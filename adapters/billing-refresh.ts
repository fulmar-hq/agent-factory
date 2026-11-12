import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {open, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {billingFromBudget, reviewedSchema} from './billing';
import {BillingSchema, ConfigSchema, type Billing} from '../launcher/config';
import {monthAt} from '../wallet/ledger';

export const BILLING_REFRESH_INTERVAL_MS = 6 * 3600000;
const MAX_FILE_BYTES = 1024 * 1024;
export const BILLING_COMMAND_TIMEOUT_MS = 15000;
export const BILLING_COMMAND_MAX_BYTES = 256 * 1024;
const sourceSchema = z.object({
  profile: z.string().regex(/^[\w-]+$/), accountId: z.string().regex(/^\d{12}$/),
  budgetName: z.string().min(1).max(100),
}).strict();
const stateSchema = z.object({
  attemptedAt: z.number().int().positive(), status: z.enum(['running', 'ok', 'error']),
  receipt: z.string().min(1), error: z.string().optional(),
}).strict();
type RefreshState = z.infer<typeof stateSchema>;
type Executor = (args: string[]) => Promise<string>;
type Result = {
  status: 'disabled' | 'not-due' | 'busy' | 'updated' | 'error';
  dueAt?: number; receipt?: string; error?: string;
  lastAttemptStatus?: RefreshState['status'];
  billingState?: ReturnType<typeof billingState>;
};

// No shell, pager, sign-in, retry loop or mutating API. execFile also bounds
// stderr and kills the process on deadline/output overflow. Never print stderr.
export const executeBillingCommand: Executor = args => new Promise((resolve, reject) => {
  execFile(args[0], args.slice(1), {
    encoding: 'utf8', timeout: BILLING_COMMAND_TIMEOUT_MS,
    maxBuffer: BILLING_COMMAND_MAX_BYTES, killSignal: 'SIGKILL',
    env: {...process.env, AWS_CLI_AUTO_PROMPT: 'off', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1'},
  }, (error, stdout) => error ? reject(Error('billing provider command failed')) : resolve(stdout));
});

// Metadata age schedules acquisition; it never supplies the source observation
// time. Failed attempts also wait six hours, avoiding an unbounded retry storm.
export function billingRefreshDue(state: unknown, now: number) {
  if (!Number.isSafeInteger(now) || now <= 0) throw Error('invalid clock');
  if (state === null) return {due: true, dueAt: now};
  const parsed = stateSchema.parse(state);
  if (parsed.attemptedAt > now) throw Error('billing refresh clock moved backwards');
  const dueAt = parsed.attemptedAt + BILLING_REFRESH_INTERVAL_MS;
  return {due: now >= dueAt, dueAt};
}

export function billingState(value: unknown, now: number) {
  const b = BillingSchema.safeParse(value);
  if (!b.success) return 'unknown';
  if (b.data.month !== monthAt(now)) return 'wrong-month';
  if (b.data.observedAt > now) return 'future';
  return now - b.data.observedAt >= 86400000 ? 'stale' : 'current';
}

async function textAt(path: string, optional = false): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('invalid or oversized billing input');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const {bytesRead} = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw Error('oversized billing input');
    return buffer.toString('utf8', 0, size);
  } finally { await file.close(); }
}

async function atomicJSON(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
  await rename(temporary, path);
}

function readingsObject(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('readings must be an object');
  return value as Record<string, unknown>;
}

// This source-only lane deliberately does not wire a scheduler, touch the stop
// latch/debits, or qualify a live reading. Coordinator owns opt-in and cadence.
export async function refreshBilling(dir: string, options: {
  enabled?: boolean; execute?: Executor; clock?: () => number;
} = {}): Promise<Result> {
  if (options.enabled !== true) return {status: 'disabled'};
  const clock = options.clock ?? Date.now, now = clock();
  const statePath = join(dir, 'billing-refresh.json'), readingsPath = join(dir, 'readings.json');
  const lockPath = join(dir, 'billing-refresh.lock');
  const readState = async () => {
    const text = await textAt(statePath, true);
    return text === null ? null : stateSchema.parse(JSON.parse(text));
  };
  try {
    if (await textAt(lockPath, true) !== null) return {status: 'busy', error: 'billing refresh custody retained; reconcile before retry'};
    const prior = await readState(), due = billingRefreshDue(prior, now);
    if (prior?.status === 'running') return {status: 'busy', receipt: prior.receipt,
      error: 'billing refresh attempt unfinished; reconcile retained custody'};
    if (!due.due) return {status: 'not-due', dueAt: due.dueAt,
      lastAttemptStatus: prior!.status, receipt: prior!.receipt, ...(prior!.error ? {error: prior!.error} : {}),
      billingState: billingState(readingsObject(await textAt(readingsPath, true)).billing, now)};
  } catch { return {status: 'error', error: 'invalid billing refresh state or readings'}; }

  const id = randomUUID();
  const receipt = join(dir, `billing-refresh-attempt-${id}.json`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? {status: 'busy', error: 'billing refresh custody retained; reconcile before retry'}
      : {status: 'error', error: 'cannot claim billing refresh custody'};
  }
  let result: Result = {status: 'error', receipt, error: 'billing refresh interrupted'};
  let attempted = false, changed = false, previousReadings: string | null = null;
  let phase = 'invalid billing refresh state';
  const state = (status: RefreshState['status'], error?: string): RefreshState => ({attemptedAt: now, status, receipt, ...(error ? {error} : {})});
  const retainReceipt = async () => {
    const record = Buffer.from(JSON.stringify({attemptedAt: now, result, changed, previousReadings,
      undo: 'Disable the invocation first. Retain this receipt; restore only the prior billing entry after review, preserving newer unrelated readings. Never clear wallet stops or debits.'}) + '\n');
    let offset = 0;
    while (offset < record.length) {
      const {bytesWritten} = await lock.write(record, offset, record.length - offset, offset);
      if (!bytesWritten) throw Error('cannot retain billing receipt');
      offset += bytesWritten;
    }
    await lock.truncate(record.length);
    await lock.sync();
  };
  try {
    await lock.writeFile(JSON.stringify({attemptedAt: now, pid: process.pid, receipt}) + '\n');
    const priorState = await readState(), due = billingRefreshDue(priorState, now); // Serialize competing invocations.
    if (!due.due) {
      result = {status: 'not-due', dueAt: due.dueAt, receipt, lastAttemptStatus: priorState!.status,
        ...(priorState!.error ? {error: priorState!.error} : {})};
      return result;
    }
    phase = 'cannot record billing refresh attempt';
    await atomicJSON(statePath, state('running'));
    attempted = true;
    phase = 'invalid billing source, readings or policy';
    // Refuse malformed existing data before any provider call; never replace it
    // with an empty document. Re-read after execution to retain other providers.
    readingsObject(await textAt(readingsPath, true));
    const sourceText = (await textAt(join(dir, 'release-billing-source.json')))!;
    const policyText = (await textAt(join(dir, 'config.yaml')))!;
    const source = sourceSchema.parse(JSON.parse(sourceText));
    const raw: unknown = Bun.YAML.parse(policyText), config = ConfigSchema.parse(raw);
    const aws = config.wallet.aws;
    if (aws.ceiling_usd_month !== 75 || aws.stop_at_actual <= 0 || aws.stop_at_actual > 75 ||
        aws.hold_at_projected <= 0 || aws.hold_at_projected > 75) throw Error('unsafe billing guard');
    // Missing reviewed obligations are unknown, not zero. The existing gross
    // converter owns fixed/unposted/projected accounting for the reviewed month.
    const reviewed = reviewedSchema.parse((raw as {wallet: {aws: unknown}}).wallet.aws);
    if (reviewed.reviewed_month !== monthAt(now)) throw Error('unreviewed billing month');
    phase = 'billing provider read failed';
    const output = await (options.execute ?? executeBillingCommand)([
      'aws', 'budgets', 'describe-budget', '--profile', source.profile, '--region', 'us-east-1',
      '--account-id', source.accountId, '--budget-name', source.budgetName,
      '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt',
      '--cli-connect-timeout', '5', '--cli-read-timeout', '10',
    ]);
    phase = 'invalid billing provider evidence';
    if (Buffer.byteLength(output) > BILLING_COMMAND_MAX_BYTES) throw Error('oversized response');
    const finishedAt = clock();
    if (finishedAt < now || monthAt(finishedAt) !== reviewed.reviewed_month) throw Error('clock or month changed');
    const hash = createHash('sha256').update(policyText + '\n' + output).digest('hex');
    const billing: Billing = billingFromBudget(JSON.parse(output).Budget, raw,
      `AWS Budgets DescribeBudget ${source.accountId}/${source.budgetName}; policy+source sha256:${hash}`, finishedAt);
    if (monthAt(billing.observedAt) !== billing.month) throw Error('source observation from previous month');
    phase = 'billing inputs changed during collection';
    if (await textAt(join(dir, 'config.yaml')) !== policyText ||
        await textAt(join(dir, 'release-billing-source.json')) !== sourceText) throw Error('inputs changed');
    previousReadings = await textAt(readingsPath, true);
    const readings = readingsObject(previousReadings), prior = BillingSchema.safeParse(readings.billing);
    if (prior.success && prior.data.observedAt > billing.observedAt) throw Error('newer billing already present');
    phase = 'cannot atomically merge billing readings';
    // Staging is retained on failure. The last byte check refuses a detected
    // concurrent writer; other readings writers must also serialize publication.
    const temporary = `${readingsPath}.${id}.tmp`;
    await writeFile(temporary, JSON.stringify({...readings, billing}) + '\n', {flag: 'wx', mode: 0o600});
    await retainReceipt(); // Retain undo evidence before replacing any reading.
    if (await textAt(readingsPath, true) !== previousReadings) throw Error('readings changed');
    await rename(temporary, readingsPath);
    changed = true;
    await atomicJSON(statePath, state('ok'));
    result = {status: 'updated', receipt, dueAt: now + BILLING_REFRESH_INTERVAL_MS,
      billingState: billingState(billing, finishedAt)};
  } catch {
    result = {status: 'error', receipt, error: phase, dueAt: now + BILLING_REFRESH_INTERVAL_MS};
    if (attempted) {
      try { await atomicJSON(statePath, state('error', phase)); }
      catch { result.error = 'cannot persist billing refresh failure; reconcile retained receipt'; }
    }
    try { result.billingState = billingState(readingsObject(await textAt(readingsPath, true)).billing, clock()); }
    catch { result.billingState = 'unknown'; }
  } finally {
    try {
      // Archive custody and the exact previous readings for review/undo. No
      // operational file is deleted, and a crash leaves the exclusive lock.
      await retainReceipt();
      await lock.close();
      await rename(lockPath, receipt);
    } catch {
      await lock.close().catch(() => {});
      result.status = 'error';
      result.error = 'cannot archive billing refresh custody; reconcile retained lock';
    }
  }
  return result;
}
