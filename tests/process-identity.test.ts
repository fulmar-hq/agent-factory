import { expect, test } from "bun:test";
import { processIdentity } from "../launcher/process";

type IdentityOS = NonNullable<Parameters<typeof processIdentity>[1]>;
const boot = "12345678-abcd-1234-abcd-123456789abc";
const start = "Sun Nov  8 12:34:56 2026   501";
const fault = (code: string) => Object.assign(Error(`fictional ${code}`), { code });
function fixture(platform: NodeJS.Platform = "darwin") {
  const commands: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const files: string[] = [];
  const ps: ReturnType<IdentityOS["spawn"]> = { status: 0, stdout: `${start}\n`, stderr: "", signal: null };
  const data = { boot: `${boot}\n`, stat: stat("12345") };
  const os: IdentityOS = {
    platform,
    spawn(file, args, options) { commands.push({ file, args, env: options.env }); return ps; },
    exec(file, args) { commands.push({ file, args }); return data.boot; },
    readFile(path, encoding) {
      expect(encoding).toBe("utf8");
      files.push(path);
      if (path === "/proc/42/stat") return data.stat;
      if (path === "/proc/sys/kernel/random/boot_id") return data.boot;
      throw Error(`unexpected synthetic path: ${path}`);
    },
  };
  return { os, ps, data, commands, files };
}
function stat(start: string) {
  // Field 2 can contain spaces and closing parentheses; starttime is field 22.
  return `42 (fictional ) worker) S ${Array(18).fill("0").join(" ")} ${start} 0 0\n`;
}

test("ps pins the C locale under inherited locale changes and retains identity text", () => {
  const before = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LC_TIME: process.env.LC_TIME };
  try {
    for (const locale of ["fr_CA.UTF-8", "de_DE.UTF-8", "C"]) {
      process.env.LC_ALL = process.env.LANG = process.env.LC_TIME = locale;
      const f = fixture();
      f.os.spawn = (file, args, options) => {
        f.commands.push({ file, args, env: options.env });
        return { ...f.ps, stdout: options.env?.LC_ALL === "C" ? `${start}\n` : "dim. nov. 8 12:34:56 2026 501" };
      };
      expect(processIdentity(42, f.os)).toBe(`${boot}:${start}`);
      expect(f.commands[0]).toEqual({
        file: "/bin/ps", args: ["-p", "42", "-o", "lstart=", "-o", "uid="],
        env: { ...process.env, LC_ALL: "C" },
      });
      expect(f.commands[1]).toEqual({ file: "/usr/sbin/sysctl", args: ["-n", "kern.bootsessionuuid"] });
      expect(f.files).toEqual([]);
    }
  } finally {
    for (const key of ["LC_ALL", "LANG", "LC_TIME"] as const) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("invalid PIDs never invoke OS commands or file reads", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const f = fixture(platform);
    for (const pid of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => processIdentity(pid, f.os)).toThrow("positive safe integer");
    }
    expect(f.commands).toEqual([]);
    expect(f.files).toEqual([]);
  }
});

test("successful ps output must contain one valid start date and numeric UID", () => {
  for (const stdout of ["", " \n", "garbage", "Sun Nov 8 12:34:56 2026", `${start}\n${start}`,
    "dim. nov. 8 12:34:56 2026 501", "Sun Nov 8 25:34:56 2026 501", "Sun Nov 31 12:34:56 2026 501",
    "Mon Nov 8 12:34:56 2026 501", "Sun Nov 8 12:34:56 2026 -1", "Sun Nov 8 12:34:56 2026 9007199254740992"]) {
    const f = fixture();
    f.ps.stdout = stdout;
    expect(() => processIdentity(42, f.os)).toThrow("malformed process start");
    expect(f.commands).toHaveLength(1);
  }
});

test("both platforms reject empty or malformed boot identities", () => {
  for (const platform of ["darwin", "linux"] as const) {
    for (const output of ["", " \n", "undefined", "1234", `${boot}\n${boot}`, `${boot}:extra`]) {
      const f = fixture(platform);
      f.data.boot = output;
      expect(() => processIdentity(42, f.os)).toThrow("malformed boot identity");
    }
    const f = fixture(platform);
    f.data.boot = ` ${boot.toUpperCase()}\n`;
    expect(processIdentity(42, f.os)?.startsWith(`${boot.toUpperCase()}:`)).toBe(true);
  }
});

test("Linux preserves valid boot/start identity and detects PID reuse", () => {
  const f = fixture("linux");
  expect(processIdentity(42, f.os)).toBe(`${boot}:12345`);
  f.data.stat = stat("12346");
  expect(processIdentity(42, f.os)).toBe(`${boot}:12346`);
  for (const ticks of ["0", "000123", "18446744073709551615"]) {
    f.data.stat = stat(ticks);
    expect(processIdentity(42, f.os)).toBe(`${boot}:${ticks}`);
  }
  expect(f.files.slice(0, 2)).toEqual(["/proc/42/stat", "/proc/sys/kernel/random/boot_id"]);
  expect(f.commands).toEqual([]);
});

test("macOS detects a reused PID by its changed start identity", () => {
  const f = fixture();
  const first = processIdentity(42, f.os);
  f.ps.stdout = "Sun Nov  8 12:34:57 2026   501\n";
  expect(processIdentity(42, f.os)).toBe(`${boot}:Sun Nov  8 12:34:57 2026   501`);
  expect(processIdentity(42, f.os)).not.toBe(first);
});

test("Linux rejects malformed stat headers and missing or invalid start ticks", () => {
  for (const text of ["", "garbage", stat("123").replace("42 (", "43 ("), "42 fictional S 0", "42 (worker)",
    "42 (worker) S 0 0", stat("-1"), stat("1.5"), stat("NaN"), stat("18446744073709551616"),
    stat("12").replace(") S ", ") ?? ")]) {
    const f = fixture("linux");
    f.data.stat = text;
    expect(() => processIdentity(42, f.os)).toThrow("malformed process");
    expect(f.files).toEqual(["/proc/42/stat"]);
  }
});

test("vanished macOS process is absent, while denial and failed tools remain errors", () => {
  const f = fixture();
  f.ps.status = 1;
  f.ps.stdout = "\n";
  expect(processIdentity(42, f.os)).toBeNull();
  expect(f.commands).toHaveLength(1);
  for (const status of [0, 1, 2, null]) {
    f.ps.status = status;
    f.ps.stderr = "ps: permission denied";
    expect(() => processIdentity(42, f.os)).toThrow("identity unavailable");
  }
  f.ps.stderr = "";
  f.ps.status = 2;
  expect(() => processIdentity(42, f.os)).toThrow("identity unavailable");
  f.ps.status = 1;
  f.ps.stdout = start;
  expect(() => processIdentity(42, f.os)).toThrow("identity unavailable");
  for (const signal of ["SIGTERM", "SIGABRT"] as const) {
    f.ps.status = null;
    f.ps.signal = signal;
    expect(() => processIdentity(42, f.os)).toThrow("identity unavailable");
  }
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    const error = fault(code);
    f.ps.error = error;
    expect(() => processIdentity(42, f.os)).toThrow(error);
  }
});

test("boot command failures are propagated rather than mistaken for absence", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM"]) {
    const f = fixture();
    const error = fault(code);
    f.os.exec = () => { throw error; };
    expect(() => processIdentity(42, f.os)).toThrow(error);
  }
});

test("Linux ENOENT stays absent; read denials and other file errors propagate", () => {
  for (const path of ["/proc/42/stat", "/proc/sys/kernel/random/boot_id"]) {
    for (const code of ["ENOENT", "EACCES", "EPERM", "EIO"]) {
      const f = fixture("linux");
      const read = f.os.readFile;
      const error = fault(code);
      f.os.readFile = (file, encoding) => {
        if (file === path) throw error;
        return read(file, encoding);
      };
      if (code === "ENOENT") expect(processIdentity(42, f.os)).toBeNull();
      else expect(() => processIdentity(42, f.os)).toThrow(error);
      expect(f.commands).toEqual([]);
    }
  }
});
