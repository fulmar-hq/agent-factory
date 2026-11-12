import {expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, writeFile, readdir, symlink, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {
  billingRefreshDue, billingState, refreshBilling, executeBillingCommand,
  BILLING_REFRESH_INTERVAL_MS as SIX_HOURS, BILLING_COMMAND_MAX_BYTES,
} from '../adapters/billing-refresh';
import {billingRefreshHelp} from '../scripts/refresh-billing';
import {config as fixtureConfig} from './fixtures';
import {inputs, ConfigSchema} from '../launcher/config';
import {available, awsRefusal, observeBilling, debit} from '../wallet/ledger';
import {Store} from '../tracking/store';

// Fictional account/policy only. Scratch and evidence are retained, not deleted.
const now = Date.parse('2031-11-10T01:00:00Z');
const scratch = join(import.meta.dir, '../.factory-tmp/billing-refresh-tests');
const policy = () => {
  const config = fixtureConfig();
  return {...config, wallet: {...config.wallet, aws: {...config.wallet.aws,
    hold_at_projected: 75, stop_at_actual: 68,
    stop_rule: 'gross_actual_plus_remaining_cost_plus_reservations_plus_lag',
    reviewed_month: '2031-11', stopped_monthly_gross_usd: 30,
    lag_reserve_usd: 5, reserved_usd: 2,
  }}};
};
const budget = () => ({
  BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: {Amount: '75', Unit: 'USD'},
  CostTypes: {IncludeTax: true, IncludeSubscription: true, IncludeRefund: false, IncludeCredit: false},
  TimePeriod: {Start: '2031-10-31T20:00:00-04:00'}, LastUpdatedTime: '2031-11-09T18:12:00Z',
  CalculatedSpend: {ActualSpend: {Amount: '20.123', Unit: 'USD'}, ForecastedSpend: {Amount: '110.5', Unit: 'USD'}},
});
const response = () => JSON.stringify({Budget: budget()});
const source = {profile: 'fictional-existing', accountId: '111111111111', budgetName: 'Fictional gross budget'};
const meters = {codex: {source: 'retain codex'}, claude: {source: 'retain claude'}, extension: {keep: [1, 2]}};
const options = {enabled: true, clock: () => now, execute: async () => response()};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function setup(readings: unknown = meters) {
  await mkdir(scratch, {recursive: true});
  const dir = await mkdtemp(join(scratch, 'case-'));
  await writeFile(join(dir, 'config.yaml'), JSON.stringify(policy()));
  await writeFile(join(dir, 'release-billing-source.json'), JSON.stringify(source));
  if (readings !== undefined) await writeFile(join(dir, 'readings.json'), JSON.stringify(readings));
  return dir;
}

test('off by default makes no reads, writes or provider execution', async () => {
  let called = false;
  expect(await refreshBilling('/nonexistent/fictional', {execute: async () => {called = true; return response();}}))
    .toEqual({status: 'disabled'});
  expect(called).toBe(false);
});

test('six-hour decision uses attempt time, including failures, never source time or mtime', () => {
  expect(billingRefreshDue(null, now).due).toBe(true);
  for (const status of ['running', 'ok', 'error']) {
    const state = {attemptedAt: now, status, receipt: 'fictional'};
    expect(billingRefreshDue(state, now + SIX_HOURS - 1).due).toBe(false);
    expect(billingRefreshDue(state, now + SIX_HOURS)).toEqual({due: true, dueAt: now + SIX_HOURS});
  }
  for (const state of [{}, {attemptedAt: now + 1, status: 'ok', receipt: 'fictional'},
    {attemptedAt: now, status: 'ok', receipt: ''}]) expect(() => billingRefreshDue(state, now)).toThrow();
  expect(() => billingRefreshDue(null, NaN)).toThrow();
});

test('one read-only existing-profile call preserves gross source time, obligations and unrelated readings', async () => {
  const dir = await setup(), calls: string[][] = [];
  const configBefore = await readFile(join(dir, 'config.yaml'), 'utf8');
  const sourceBefore = await readFile(join(dir, 'release-billing-source.json'), 'utf8');
  const result = await refreshBilling(dir, {...options, execute: async args => {calls.push(args); return response();}});
  expect(result.status).toBe('updated');
  expect(calls).toEqual([['aws', 'budgets', 'describe-budget', '--profile', source.profile, '--region', 'us-east-1',
    '--account-id', source.accountId, '--budget-name', source.budgetName, '--output', 'json', '--no-cli-pager',
    '--no-cli-auto-prompt', '--cli-connect-timeout', '5', '--cli-read-timeout', '10']]);
  const readings = await json(join(dir, 'readings.json'));
  expect(readings).toMatchObject(meters);
  expect(readings.billing).toMatchObject({observedAt: Date.parse(budget().LastUpdatedTime), month: '2031-11',
    postedCents: 2013, unpostedCents: 700, fixedCents: 2100, projectedCents: 4813});
  expect(readings.billing.receipt).toMatch(/policy\+source sha256:[a-f0-9]{64}$/);
  expect((await inputs(dir)).billing).toEqual(readings.billing);
  expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe(configBefore);
  expect(await readFile(join(dir, 'release-billing-source.json'), 'utf8')).toBe(sourceBefore);
  expect((await stat(join(dir, 'readings.json'))).mode & 0o777).toBe(0o600);
  const receipt = await json(result.receipt!);
  expect(receipt.changed).toBe(true);
  expect(JSON.parse(receipt.previousReadings)).toEqual(meters);
  expect(receipt.undo).toContain('Never clear wallet stops or debits');
  expect(await json(join(dir, 'billing-refresh.json'))).toMatchObject({status: 'ok', attemptedAt: now});
  expect((await readdir(dir)).includes('billing-refresh.lock')).toBe(false);
  expect(await refreshBilling(dir, {...options, execute: async () => {throw Error('must not run');}}))
    .toMatchObject({status: 'not-due', billingState: 'current', dueAt: now + SIX_HOURS});
});

test('a later six-hour read never renews the provider observation time', async () => {
  const dir = await setup();
  await refreshBilling(dir, options);
  expect((await refreshBilling(dir, {...options, clock: () => now + SIX_HOURS})).status).toBe('updated');
  const {billing} = await inputs(dir);
  expect(billing?.observedAt).toBe(Date.parse(budget().LastUpdatedTime));
});

test('missing readings starts with actual evidence, never synthetic zeros', async () => {
  // setup omits a file by constructing the installation directly.
  await mkdir(scratch, {recursive: true});
  const dir = await mkdtemp(join(scratch, 'missing-'));
  await writeFile(join(dir, 'config.yaml'), JSON.stringify(policy()));
  await writeFile(join(dir, 'release-billing-source.json'), JSON.stringify(source));
  expect((await refreshBilling(dir, options)).status).toBe('updated');
  expect((await inputs(dir)).billing?.postedCents).toBe(2013);
});

test('failed provider preserves exact previous readings, records error and bounds retry cadence', async () => {
  const dir = await setup();
  await refreshBilling(dir, options);
  const before = await readFile(join(dir, 'readings.json'), 'utf8');
  let calls = 0;
  const failed = {...options, clock: () => now + SIX_HOURS, execute: async () => {calls++; throw Error('secret fictional token');}};
  const result = await refreshBilling(dir, failed);
  expect(result).toMatchObject({status: 'error', error: 'billing provider read failed', billingState: 'current'});
  expect(await readFile(join(dir, 'readings.json'), 'utf8')).toBe(before);
  expect(await json(join(dir, 'billing-refresh.json'))).toMatchObject({status: 'error', attemptedAt: now + SIX_HOURS});
  expect(JSON.stringify(await json(result.receipt!))).not.toContain('secret fictional token');
  expect(await refreshBilling(dir, failed)).toMatchObject({status: 'not-due', lastAttemptStatus: 'error',
    error: 'billing provider read failed'});
  expect(calls).toBe(1);
});

test('unknown, stale, future and wrong-month remain distinct after failed collection', async () => {
  const good = {observedAt: now, month: '2031-11', postedCents: 100, fixedCents: 100,
    unpostedCents: 100, projectedCents: 300, receipt: 'fictional'};
  for (const [prior, expected] of [[undefined, 'unknown'], [{...good, observedAt: now - 86400000}, 'stale'],
    [{...good, observedAt: now + 1}, 'future'], [{...good, month: '2031-10'}, 'wrong-month']] as const) {
    const dir = await setup({...meters, ...(prior ? {billing: prior} : {})});
    const before = await readFile(join(dir, 'readings.json'), 'utf8');
    const result = await refreshBilling(dir, {...options, execute: async () => {throw Error('fixture offline');}});
    expect(result).toMatchObject({status: 'error', billingState: expected});
    expect(await readFile(join(dir, 'readings.json'), 'utf8')).toBe(before);
    expect(billingState(prior, now)).toBe(expected);
  }
});

test('invalid provider time, month, net costs and amounts fail without changing readings', async () => {
  const invalid = [
    {...budget(), LastUpdatedTime: new Date(now - 86400000).toISOString()},
    {...budget(), LastUpdatedTime: new Date(now + 1).toISOString()},
    {...budget(), LastUpdatedTime: 'not a date'},
    {...budget(), TimePeriod: {Start: '2031-10-01'}},
    {...budget(), CostTypes: {...budget().CostTypes, IncludeCredit: true}},
    {...budget(), CostTypes: {...budget().CostTypes, IncludeRefund: true}},
    {...budget(), BudgetLimit: {Amount: '76', Unit: 'USD'}},
    {...budget(), CalculatedSpend: {...budget().CalculatedSpend, ActualSpend: {Amount: '-1', Unit: 'USD'}}},
    {...budget(), CalculatedSpend: {...budget().CalculatedSpend, ForecastedSpend: {Amount: 'NaN', Unit: 'USD'}}},
    {...budget(), CalculatedSpend: {...budget().CalculatedSpend, ActualSpend: {Amount: '1', Unit: 'CAD'}}},
  ];
  for (const value of invalid) {
    const dir = await setup(), before = await readFile(join(dir, 'readings.json'), 'utf8');
    expect((await refreshBilling(dir, {...options, execute: async () => JSON.stringify({Budget: value})})).status).toBe('error');
    expect(await readFile(join(dir, 'readings.json'), 'utf8')).toBe(before);
  }
  for (const output of ['{', '{}', 'x'.repeat(BILLING_COMMAND_MAX_BYTES + 1)]) {
    const dir = await setup();
    expect((await refreshBilling(dir, {...options, execute: async () => output})).status).toBe('error');
    expect((await inputs(dir)).billing).toBeUndefined();
  }
});

test('Toronto month rollover and a clock change during acquisition cannot create valid evidence', async () => {
  const first = Date.parse('2031-11-01T04:30:00Z'), dir = await setup();
  const value = budget(); value.LastUpdatedTime = '2031-11-01T03:59:00Z';
  expect((await refreshBilling(dir, {...options, clock: () => first,
    execute: async () => JSON.stringify({Budget: value})})).status).toBe('error');
  const other = await setup(); let clockCalls = 0;
  expect((await refreshBilling(other, {...options, clock: () => clockCalls++ ? now - 1 : now})).status).toBe('error');
});

test('unreviewed obligations, changed ceilings and unsafe guards refuse before execution', async () => {
  for (const patch of [{reviewed_month: '2031-10'}, {stop_rule: 'unknown'}, {ceiling_usd_month: 76},
    {hold_at_projected: 76}, {stop_at_actual: 76}, {stop_at_actual: 0}, {lag_reserve_usd: -1},
    {stopped_monthly_gross_usd: undefined}, {reserved_usd: undefined}]) {
    const dir = await setup(), value = policy(); Object.assign(value.wallet.aws, patch);
    await writeFile(join(dir, 'config.yaml'), JSON.stringify(value));
    let calls = 0;
    expect((await refreshBilling(dir, {...options, execute: async () => {calls++; return response();}})).status).toBe('error');
    expect(calls).toBe(0);
    expect((await inputs(dir)).billing).toBeUndefined();
  }
});

test('malformed, oversized and symlink inputs are retained and never replaced with an empty object', async () => {
  for (const content of ['{', 'null', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
    const dir = await setup(); await writeFile(join(dir, 'readings.json'), content);
    let calls = 0;
    expect((await refreshBilling(dir, {...options, execute: async () => {calls++; return response();}})).status).toBe('error');
    expect(calls).toBe(0);
    expect(await readFile(join(dir, 'readings.json'), 'utf8')).toBe(content);
  }
  const dir = await setup(), target = join(dir, 'retained.json');
  await writeFile(target, JSON.stringify(meters));
  await symlink(target, join(dir, 'billing-refresh.json'));
  expect((await refreshBilling(dir, options)).status).toBe('error');
  expect(await json(target)).toEqual(meters);
  const corrupt = await setup();
  await writeFile(join(corrupt, 'billing-refresh.json'), '{');
  expect((await refreshBilling(corrupt, options)).status).toBe('error');
  expect(await readFile(join(corrupt, 'billing-refresh.json'), 'utf8')).toBe('{');
});

test('provider execution can update other readings; merge reads the latest document', async () => {
  const dir = await setup();
  const result = await refreshBilling(dir, {...options, execute: async () => {
    await writeFile(join(dir, 'readings.json'), JSON.stringify({...meters, claude: {source: 'new concurrent reading'}}));
    return response();
  }});
  expect(result.status).toBe('updated');
  expect(await json(join(dir, 'readings.json'))).toMatchObject({codex: meters.codex, claude: {source: 'new concurrent reading'}});
});

test('policy/source drift and newer billing evidence refuse replacement', async () => {
  for (const name of ['config.yaml', 'release-billing-source.json', 'readings.json']) {
    const dir = await setup();
    const result = await refreshBilling(dir, {...options, execute: async () => {
      if (name === 'readings.json') await writeFile(join(dir, name), JSON.stringify({...meters,
        billing: {observedAt: now, month: '2031-11', postedCents: 6800, unpostedCents: 0,
          fixedCents: 0, projectedCents: 7500, receipt: 'newer fictional stop'}}));
      else await writeFile(join(dir, name), (await readFile(join(dir, name), 'utf8')) + ' ');
      return response();
    }});
    expect(result.status).toBe('error');
    if (name === 'readings.json') expect((await inputs(dir)).billing?.postedCents).toBe(6800);
    else expect((await inputs(dir)).billing).toBeUndefined();
  }
});

test('concurrent collection is exclusive and a retained crash lock fails closed', async () => {
  const dir = await setup();
  let entered!: () => void, finish!: (value: string) => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const first = refreshBilling(dir, {...options, execute: async () => {
    entered(); return await new Promise<string>(resolve => {finish = resolve;});
  }});
  await started;
  expect((await refreshBilling(dir, options)).status).toBe('busy');
  finish(response());
  expect((await first).status).toBe('updated');
  const crashed = await setup(); await writeFile(join(crashed, 'billing-refresh.lock'), 'retained crash custody');
  expect((await refreshBilling(crashed, options)).status).toBe('busy');
  expect(await readFile(join(crashed, 'billing-refresh.lock'), 'utf8')).toBe('retained crash custody');
});

test('collected evidence preserves $75 ceiling, actual stops, commitments and latched stops', async () => {
  for (const actual of ['20.123', '68', '75']) {
    const dir = await setup(), value = budget(); value.CalculatedSpend.ActualSpend.Amount = actual;
    expect((await refreshBilling(dir, {...options, execute: async () => JSON.stringify({Budget: value})})).status).toBe('updated');
    const billing = (await inputs(dir)).billing!, config = ConfigSchema.parse(policy()), store = new Store(':memory:');
    try {
      const before = available(store, config, 'aws', now, billing);
      if (actual === '20.123') {
        expect(before).toBe(1187);
        store.atomic(() => debit(store, 'fictional-reservation', 'aws', 100, now));
        expect(available(store, config, 'aws', now, billing)).toBe(before - 100);
      } else {
        expect(awsRefusal(store, config, now, billing)).toBe('wallet stopped');
        observeBilling(store, config, billing, now);
        expect(store.get('aws-stop-latched')).toBe(true);
      }
      store.set('aws-stop-latched', true);
      expect(awsRefusal(store, config, now, billing)).toBe('wallet stopped');
      expect(available(store, config, 'aws', now, billing)).toBe(0);
      expect(config.wallet.aws.ceiling_usd_month).toBe(75);
    } finally {store.close();}
  }
  // Projection alone at the ceiling also remains held through existing gates.
  const dir = await setup(), p = policy(); p.wallet.aws.stopped_monthly_gross_usd = 100;
  await writeFile(join(dir, 'config.yaml'), JSON.stringify(p));
  await refreshBilling(dir, options);
  const s = new Store(':memory:');
  try {expect(awsRefusal(s, ConfigSchema.parse(p), now, (await inputs(dir)).billing)).toBe('wallet stopped');}
  finally {s.close();}
});

test('bounded runner handles output overflow, nonzero and signal exits without AWS', async () => {
  expect(await executeBillingCommand([process.execPath, '-e', 'process.stdout.write("fixture")'])).toBe('fixture');
  await expect(executeBillingCommand([process.execPath, '-e', 'process.exit(7)'])).rejects.toThrow('command failed');
  await expect(executeBillingCommand([process.execPath, '-e', `process.stdout.write('x'.repeat(${BILLING_COMMAND_MAX_BYTES + 1}))`])).rejects.toThrow('command failed');
  await expect(executeBillingCommand([process.execPath, '-e', `process.stderr.write('x'.repeat(${BILLING_COMMAND_MAX_BYTES + 1}))`])).rejects.toThrow('command failed');
  // Never deliberately abort on macOS. Real abort-signal coverage remains on Linux.
  const signal = process.platform === 'linux' ? 'SIGABRT' : 'SIGTERM';
  await expect(executeBillingCommand([process.execPath, '-e', `process.kill(process.pid, '${signal}')`])).rejects.toThrow('command failed');
  const dir = await setup();
  expect((await refreshBilling(dir, {...options, execute: async () => {
    throw Object.assign(Error('mock signal exit'), {signal: 'SIGABRT'});
  }})).status).toBe('error');
});

test('bounded runner kills a hung local command at its deadline without AWS', async () => {
  const start = Date.now();
  await expect(executeBillingCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'])).rejects.toThrow('command failed');
  expect(Date.now() - start).toBeLessThan(19000);
}, 20000);

test('CLI opt-in/undo and invalid arguments never invoke a provider', async () => {
  const run = async (args: string[], enabled?: string) => {
    const p = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../scripts/refresh-billing.ts'), ...args], {
      env: {...process.env, FACTORY_BILLING_REFRESH: enabled ?? '', FACTORY_PRIVATE_DIR: join(scratch, 'nonexistent'),
        HOME: join(import.meta.dir, '../.factory-tmp/home')}, stdout: 'pipe', stderr: 'pipe',
    });
    return {out: await new Response(p.stdout).text(), code: await p.exited};
  };
  expect(await run(['--due'])).toEqual({out: '{"status":"disabled"}\n', code: 0});
  expect(await run(['--due'], '0')).toEqual({out: '{"status":"disabled"}\n', code: 0});
  expect((await run(['--force'], '1')).code).toBe(1);
  const help = await run(['--help']);
  expect(help.code).toBe(0);
  expect(help.out).toContain(billingRefreshHelp);
  expect(help.out).toContain('FACTORY_BILLING_REFRESH=1 bun --no-env-file scripts/refresh-billing.ts --due');
  expect(help.out).toContain('FACTORY_BILLING_REFRESH=0 bun --no-env-file scripts/refresh-billing.ts --due');
});
