import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
// Include boot identity as well as process start: PIDs are reused across reboots.
export function processIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "uid="], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.status !== 0) throw Error("supervisor identity unavailable");
  const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim();
  return `${boot}:${result.stdout.trim()}`;
}
