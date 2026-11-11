"""Read Claude's built-in /usage panel without a model turn or sign-in.

Unknown UI, workspace trust, authentication or incomplete quota rows refuse.
The child has no tools, customizations, MCP, browser or fallback model. Only
the local /usage command is submitted; the owned process group is terminated.
"""
import datetime
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from zoneinfo import ZoneInfo

ANSI = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78]|[\x00-\x08\x0b-\x1f]')
MONTHS = {name: i for i, name in enumerate(('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}
SOURCE = 'native Claude /usage TUI'


def plain(text):
    # Native panel redraws move to an earlier row without a literal newline.
    # Preserve that row boundary instead of joining unrelated panel labels.
    text = re.sub(r'\x1b\[[0-9;]*[ABCDEFGHfJK]', '\n', text)
    return ANSI.sub('', text).replace('\r', '')


def reset_at(text, observed):
    match = re.fullmatch(r'Resets (?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^()]+)\)', text)
    if not match:
        raise ValueError('unknown reset format')
    month, day, hour, minute, meridiem, zone = match.groups()
    local = datetime.datetime.fromtimestamp(observed / 1000, ZoneInfo(zone))
    h, m = int(hour), int(minute or '0')
    if not 1 <= h <= 12 or not 0 <= m < 60:
        raise ValueError('invalid reset clock')
    h = h % 12 + (12 if meridiem == 'pm' else 0)
    year = local.year + (1 if month == 'Jan' and local.month == 12 else 0)
    reset = datetime.datetime(year, MONTHS[month] if month else local.month, int(day) if day else local.day, h, m, tzinfo=ZoneInfo(zone))
    if reset <= local:
        raise ValueError('expired or ambiguous reset')
    return int(reset.timestamp() * 1000)


def parse_panel(text, observed):
    try:
        if type(observed) is not int or observed <= 0:
            return None
        text = plain(text)
        if re.search(r'Enter y/n|Permission Required|Sign in|/login|password|MFA|billing details', text, re.I):
            return None
        marker = re.search(r'Settings\s+Status\s+Config\s+Usage\s+Stats', text)
        if not marker:
            return None
        text = text[marker.end():]
        api_rows = re.findall(r'Total duration \(API\):\s*([^\n]+)', text)
        usage_rows = [line.strip() for line in text.splitlines() if line.strip().startswith('Usage:')]
        if not api_rows or any(row.strip() != '0s' for row in api_rows) or not usage_rows or any(not re.fullmatch(r'Usage:\s+0 input, 0 output, 0 cache read, 0 cache write', row) for row in usage_rows):
            return None
        if 'Usage credits are off' not in text or 'Esc to cancel' not in text:
            return None
        rows = [line.strip() for line in text.splitlines() if line.strip()]
        headers = [(i, row) for i, row in enumerate(rows) if row.startswith('Current ')]
        if not headers:
            return None
        windows = {}
        for index, (start, name) in enumerate(headers):
            if name != 'Current session' and not re.fullmatch(r'Current week \([A-Za-z0-9 ._-]+\)', name):
                return None
            end = headers[index + 1][0] if index + 1 < len(headers) else len(rows)
            values = [re.fullmatch(r'(\d{1,3})%(?:\s+(\d{1,3})%)? used', row) for row in rows[start + 1:end]]
            values = [v for v in values if v]
            resets = [row for row in rows[start + 1:end] if row.startswith('Resets ')]
            if len(values) != 1 or len(resets) != 1:
                return None
            first, second = values[0].groups()
            if int(first) > 100 or (second is not None and first != second):
                return None
            value = {'name': name, 'used': int(first) / 100, 'resetsAt': reset_at(resets[0], observed)}
            if name in windows and windows[name] != value:
                return None
            windows[name] = value
        if 'Current week (all models)' not in windows:
            return None
        return {'observedAt': observed, 'nativeProvider': 'claude', 'windows': list(windows.values()), 'source': SOURCE}
    except (ValueError, KeyError, OverflowError):
        return None


def read_usage(budget_seconds=8, quiet_seconds=.3):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 160, 0, 0))
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG') if k in os.environ}
    env['TERM'] = 'xterm-256color'
    args = ['claude', '--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--model', 'claude-opus-5-5', '--effort', 'medium', '--ax-screen-reader']
    child, text = None, ''
    try:
        child = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
        os.close(slave)
        slave = None
        deadline, text, sent, last_data = time.monotonic() + budget_seconds, '', False, None
        while time.monotonic() < deadline and child.poll() is None:
            if not select.select([master], [], [], min(.15, max(0, deadline - time.monotonic())))[0]:
                continue
            data = os.read(master, 8192)
            if not data:
                break
            text += data.decode('utf-8', errors='replace')
            last_data = time.monotonic()
            if len(text.encode()) > 131072:
                raise ValueError('quota panel exceeded bounded output')
            clean = plain(text)
            if re.search(r'Enter y/n|Permission Required|Sign in|/login|password|MFA|billing details', clean, re.I):
                raise ValueError('quota requires trust or authentication; no answer submitted')
            if not sent and re.search(r'(?:^|\n)[$>❯]\s*$', clean):
                os.write(master, b'/usage\r')
                sent = True
                text = ''
                continue
        # Drain the entire bounded observation window. An initially complete
        # aggregate/footer may be followed by another model's quota row. Never
        # return that earlier partial inventory, even when it parses cleanly.
        if sent and last_data is not None and time.monotonic() - last_data >= quiet_seconds:
            value = parse_panel(text, int(time.time() * 1000))
            if value is not None:
                return value
        raise ValueError('complete quota panel unavailable before bounded deadline')
    finally:
        # A parent timeout enters this finally through SystemExit. Repeated
        # polite stops cannot interrupt the bounded owned-group teardown.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup_error = None
        if slave is not None:
            os.close(slave)
        if child is not None:
            # Never target another CLI or session. The new process group is
            # this helper's sole custody; even early return runs this cleanup.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(child.pid, sig)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    cleanup_error = error
                    # Keep attempting cleanup even if group signalling fails.
                    # Popen still owns this exact child; no PID search is used.
                    if child.poll() is None:
                        try:
                            child.send_signal(sig)
                        except ProcessLookupError:
                            pass
                        except OSError as child_error:
                            cleanup_error = child_error
                try:
                    child.wait(timeout=.4)
                except subprocess.TimeoutExpired:
                    pass
            try:
                child.wait(timeout=.4)
            except subprocess.TimeoutExpired as error:
                cleanup_error = error
        os.close(master)
        # Diagnostic I/O must never prevent owned-process cleanup above.
        diagnostic = os.environ.get('FACTORY_CLAUDE_USAGE_RECEIPT')
        if diagnostic:
            try:
                fd = os.open(diagnostic, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.write(fd, json.dumps({'observedAt': int(time.time() * 1000), 'text': text[:131072]}).encode())
                finally:
                    os.close(fd)
            except OSError:
                print('Native Claude quota diagnostic unavailable', file=sys.stderr)
        if cleanup_error is not None:
            raise RuntimeError('owned quota CLI cleanup could not be verified') from cleanup_error


def install_signal_handlers():
    def stop(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)


if __name__ == '__main__':
    install_signal_handlers()
    try:
        if sys.argv[1:] == ['--parse']:
            fixture = json.load(sys.stdin)
            result = parse_panel(fixture['text'], fixture['observedAt'])
        elif sys.argv[1:]:
            raise ValueError('unsupported quota reader arguments')
        else:
            result = read_usage()
        print(json.dumps(result, separators=(',', ':')))
    except Exception as error:
        print('null')
        print('Native Claude quota unavailable: ' + str(error), file=sys.stderr)
