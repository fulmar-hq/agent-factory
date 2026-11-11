import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

type CommandOptions = { encoding: "utf8"; env?: NodeJS.ProcessEnv };
type IdentityOS = {
  platform: NodeJS.Platform;
  readFile: (path: string, encoding: "utf8") => string;
  spawn: (file: string, args: string[], options: CommandOptions) => {
    status: number | null; stdout: string; stderr: string; error?: Error; signal: NodeJS.Signals | null;
  };
  exec: (file: string, args: string[], options: CommandOptions) => string;
};
const host: IdentityOS = { platform: process.platform, readFile: readFileSync, spawn: spawnSync, exec: execFileSync };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function bootIdentity(text: string): string {
  const boot = text.trim();
  if (!uuid.test(boot)) throw Error("malformed boot identity");
  return boot;
}
function validStart(text: string): boolean {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[ \t]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+([1-9]|[12]\d|3[01])[ \t]+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)[ \t]+(\d{4})[ \t]+(\d+)$/.exec(text);
  if (!match) return false;
  const [, day, month, date, hour, minute, second, year, uid] = match;
  const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month!);
  const parsed = new Date(0);
  parsed.setUTCFullYear(Number(year), monthIndex, Number(date));
  parsed.setUTCHours(Number(hour), Number(minute), Number(second));
  return Number.isSafeInteger(Number(uid)) && Number.isFinite(parsed.getTime()) &&
    parsed.getUTCDate() === Number(date) && parsed.getUTCFullYear() === Number(year) &&
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()] === day;
}
// Include boot identity as well as process start: PIDs are reused across reboots.
export function processIdentity(pid: number, os: IdentityOS = host): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("PID must be a positive safe integer");
  if (os.platform === "linux") {
    try {
      const stat = os.readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (!stat.startsWith(`${pid} (`) || close < `${pid} (`.length || stat[close + 1] !== " ") {
        throw Error("malformed process stat");
      }
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const start = fields[19];
      if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !start || !/^\d+$/.test(start) || BigInt(start) > 18446744073709551615n) {
        throw Error("malformed process start identity");
      }
      return `${bootIdentity(os.readFile("/proc/sys/kernel/random/boot_id", "utf8"))}:${start}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const result = os.spawn("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "uid="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.signal && !result.stdout.trim() && !result.stderr.trim()) return null;
  if (result.status !== 0 || result.signal || result.stderr.trim()) throw Error("supervisor identity unavailable");
  if (!validStart(result.stdout.trim())) throw Error("malformed process start identity");
  const boot = bootIdentity(os.exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }));
  return `${boot}:${result.stdout.trim()}`;
}
