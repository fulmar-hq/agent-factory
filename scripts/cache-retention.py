#!/usr/bin/env python3
"""Audit factory caches only. Source, dependencies and operational evidence stay put."""
import argparse, fcntl, json, os, pathlib, sqlite3, subprocess, time, stat, re, hashlib

CACHES = {'node_modules', '.next', '.turbo'}
PROTECTED = {'.git', '.factory-tmp', 'receipts', 'evidence', 'transcripts', 'logs',
             'test-results', 'playwright-report', 'coverage', 'artifacts'}


def command(args, allowed=(0,), with_pid=False):
    if with_pid:
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.communicate()
            raise RuntimeError("process inventory timed out")
        if child.returncode != 0 or err.strip() or not out.strip():
            raise RuntimeError("process inventory unavailable")
        return out, child.pid
    p = subprocess.run(args, capture_output=True, text=True, timeout=5 if args[0] in {'/bin/ps', '/usr/sbin/lsof'} else 120,
                       env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    if p.returncode not in allowed or p.stderr.strip():
        raise RuntimeError('probe refused: ' + args[0] + ': ' + p.stderr[:200])
    return p.stdout


def real(p):
    return not p.is_symlink() and p.resolve() == p


def evidence(name):
    n = name.lower()
    return (n in PROTECTED or n in {'log', 'trace', 'traces'} or
            n.endswith(('.json', '.xml', '.html', '.htm', '.csv', '.tsv', '.tap', '.lcov', '.log', '.jsonl', '.bundle', '.receipt', '.sqlite', '.sqlite3', '.db', '.db3', '.sqlitedb', '-wal', '-shm', '-journal')) or
            any(s in n for s in ('receipt', 'transcript', 'evidence', '.log.', 'trace', 'junit', 'report', 'result')))


def quiet(paths):
    def processes():
        out, probe_pid = command(['/bin/ps', '-ww', '-axo', 'uid=,pid=,stat=,command='], with_pid=True)
        if not out.strip():
            raise RuntimeError('empty process inventory')
        rows = {}
        for line in out.splitlines():
            fields = line.strip().split(None, 3)
            if len(fields) != 4 or not fields[0].isdigit() or not fields[1].isdigit():
                raise RuntimeError('partial process inventory')
            uid, pid, state, args = fields
            if int(uid) != os.getuid() or state.startswith('Z') or int(pid) == probe_pid:
                continue
            rows[int(pid)] = args
            if int(pid) != os.getpid() and any(str(p) in args for p in paths):
                return None
        return rows
    before = processes()
    if before is None:
        return False
    files = command(['/usr/sbin/lsof', '-nP', '-a', '-u', str(os.getuid()), '-Fpcftn'])
    if not files.startswith('p') or not files.endswith('\n'):
        raise RuntimeError('empty or truncated file inventory')
    seen = set()
    pid = None
    cmd = False
    descriptor = None
    kind = None
    named = False
    cwd = False
    executable = False
    ordinary_fd = False
    def finish_file():
        if descriptor is not None and not named:
            raise RuntimeError('incomplete descriptor name')
    def finish_process():
        finish_file()
        if pid is not None:
            if not cmd or not cwd or not executable or not ordinary_fd:
                raise RuntimeError('incomplete command/cwd/descriptor evidence')
            seen.add(pid)
    for line in files.splitlines():
        if line.startswith('p'):
            finish_process()
            if not re.fullmatch(r'p[1-9][0-9]*', line):
                raise RuntimeError('partial file process identity')
            pid, cmd, descriptor, kind, named, cwd, executable, ordinary_fd = int(line[1:]), False, None, None, False, False, False, False
        elif line.startswith('c'):
            if pid is None or cmd or descriptor is not None or len(line) < 2:
                raise RuntimeError('partial file command')
            cmd = True
        elif line.startswith('f'):
            finish_file()
            if not cmd or not re.fullmatch(r'f(?:cwd|twd|fp\.|rtd|txt|mem|DEL|[0-9]+[a-z]*)', line):
                raise RuntimeError('unavailable descriptor inventory')
            descriptor, kind, named = line[1:], None, False
        elif line.startswith('t'):
            if descriptor is None or kind is not None or len(line) < 2:
                raise RuntimeError('partial descriptor type')
            kind = line[1:]
        elif line.startswith('n'):
            # Darwin proc_info.h distinguishes PIPE/NETPOLICY/NEXUS from
            # VNODE. lsof emits an explicit empty name for these kernel handles;
            # they cannot be cache files. Unknown/vnode/cwd names still refuse.
            unnamed_kernel = line == 'n' and descriptor is not None and descriptor.isdigit() and kind in {'PIPE', 'NPOLICY', 'NEXUS'}
            if descriptor is None or (len(line) < 2 and not unnamed_kernel) or re.search(r'\([^)]*(?:Permission denied|Operation not permitted|opendir:|readlink:|stat:|error:)', line, re.I):
                raise RuntimeError('unavailable descriptor name')
            named = True
            cwd = cwd or descriptor == 'cwd'
            executable = executable or descriptor == 'txt'
            ordinary_fd = ordinary_fd or bool(re.fullmatch(r'[0-9]+[a-z]*', descriptor))
            name = line[1:].removesuffix(' (deleted)')
            if any(name == str(p) or name.startswith(str(p) + '/') for p in paths):
                return False
        else:
            raise RuntimeError('unknown file inventory record')
    finish_process()
    after = processes()
    if after is None:
        return False
    if set(after) - seen:
        raise RuntimeError('final live process missing cwd/descriptor evidence')
    return True


def eligible(repo, cache):
    if not real(repo) or not real(cache) or not cache.is_dir() or cache.parent != repo or cache.name not in CACHES:
        return False
    if command(['git', '-c', 'core.fsmonitor=false', '-C', str(repo), 'rev-parse', '--show-toplevel']).strip() != str(repo):
        return False
    git = ['git', '-c', 'core.fsmonitor=false', '-C', str(repo)]
    if not command(git + ['check-ignore', '--', cache.name], (0, 1)):
        return False
    if command(git + ['ls-files', '-z', '--', cache.name]):
        return False
    # HEAD independently protects staged deletions hidden by an ignore rule.
    if command(git + ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', cache.name]):
        return False
    dev = repo.stat().st_dev
    for directory, dirs, files in os.walk(cache, followlinks=False):
        if '.git' in dirs or '.git' in files:
            return False
        for name in dirs + files:
            mode = (pathlib.Path(directory) / name).lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                return False
        for name in list(dirs):
            p = pathlib.Path(directory) / name
            if evidence(name) or p.is_symlink():
                dirs.remove(name)
            elif p.stat().st_dev != dev:
                return False
    return True


def retained_entry(p, cache=None, manifest=None):
    if evidence(p.name):
        return True
    if p.is_file() and not p.is_symlink():
        with p.open('rb') as data:
            if data.read(16) == b'SQLite format 3\x00':
                return True
    # Only byte-identical objects in the trusted pre-worker installation are
    # regenerable. Unknown, newly written or modified content is evidence.
    if cache is None or manifest is None:
        return True
    expected = manifest['entries'].get(str(p.relative_to(cache)))
    if expected is None:
        return True
    try:
        before = p.lstat()
        if p.is_symlink():
            return expected != {'kind': 'link', 'target': str(p.resolve(strict=True).relative_to(cache))}
        if not stat.S_ISREG(before.st_mode) or expected.get('kind') != 'file':
            return True
        digest = hashlib.sha256()
        with p.open('rb') as data:
            for chunk in iter(lambda: data.read(1024*1024), b''):
                digest.update(chunk)
        after = p.lstat()
        return ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_mode) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode) or
                expected != {'kind': 'file', 'sha256': digest.hexdigest(), 'executable': bool(before.st_mode & 0o100)})
    except (OSError, ValueError):
        return True


def has_generated(cache, manifest=None, base=None):
    base = base or cache
    with os.scandir(cache) as entries:
        for item in entries:
            p = pathlib.Path(item.path)
            if evidence(p.name):
                continue
            if item.is_dir(follow_symlinks=False):
                if has_generated(p, manifest, base):
                    return True
            elif not retained_entry(p, base, manifest):
                return True
    return False


def dependency_identity(root, inventory=False):
    if not root.is_dir() or not real(root):
        raise RuntimeError('local dependency installation required')
    digest = hashlib.sha256()
    entries = {}
    def visit(directory):
        for p in sorted(directory.iterdir(), key=lambda q: q.name):
            relative = str(p.relative_to(root)).encode()
            if p.is_symlink():
                target = p.resolve(strict=True)
                if not target.is_relative_to(root):
                    raise RuntimeError('external dependency link refused')
                digest.update(b'link\0' + relative + b'\0' + str(target.relative_to(root)).encode() + b'\0')
                entries[relative.decode()] = {'kind': 'link', 'target': str(target.relative_to(root))}
            elif p.is_dir():
                digest.update(b'dir\0' + relative + b'\0');entries[relative.decode()] = {'kind': 'dir'};visit(p)
            elif p.is_file():
                before = p.stat()
                digest.update(b'file\0' + relative + b'\0' + str(before.st_size).encode() + b':' + str(before.st_mode & 0o100).encode() + b'\0')
                content = hashlib.sha256()
                with p.open('rb') as data:
                    for chunk in iter(lambda: data.read(1024*1024), b''):
                        digest.update(chunk);content.update(chunk)
                entries[relative.decode()] = {'kind': 'file', 'sha256': content.hexdigest(), 'executable': bool(before.st_mode & 0o100)}
                digest.update(b'\0')
                after = p.stat()
                if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_mode) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode):
                    raise RuntimeError('dependency installation changed while reading')
            else:
                raise RuntimeError('special dependency object refused')
    visit(root)
    fingerprint = digest.hexdigest()
    return {'version': 1, 'fingerprint': fingerprint, 'entries': entries} if inventory else fingerprint


def cache_manifest(db, root, repo, name):
    # Only node_modules has a trusted before-native baseline. Build outputs and
    # legacy/rehearsal clones without provenance remain untouched.
    sid = session_for(root, repo)
    if name != 'node_modules' or not sid:
        return None
    if repo == root / 'workspaces' / str(sid):
        binding = db.execute('select value from kv where key=?', ('dependency-installation:' + sid,)).fetchone()
        if binding is None:
            return None
        fingerprint = json.loads(binding[0])
    else:
        key = 'publisher-dependency-installation:' + hashlib.sha256(str(repo).encode()).hexdigest()
        binding = db.execute('select value from kv where key=?', (key,)).fetchone()
        if binding is None:
            return None
        bound = json.loads(binding[0])
        if not isinstance(bound, dict) or bound.get('version') != 1 or bound.get('session') != sid or bound.get('checkout') != str(repo) or not real(repo):
            return None
        fingerprint = bound.get('fingerprint')
    if not isinstance(fingerprint, str) or not re.fullmatch(r'[a-f0-9]{64}', fingerprint):
        return None
    row = db.execute('select value from kv where key=?', ('dependency-cache-manifest:' + fingerprint,)).fetchone()
    if row is None:
        return None
    manifest = json.loads(row[0])
    if (not isinstance(manifest, dict) or manifest.get('version') != 1 or
        manifest.get('fingerprint') != fingerprint or not isinstance(manifest.get('entries'), dict)):
        return None
    return manifest


def repositories(root):
    # Explicit factory roots only. Never walk arbitrary work/owner scratch.
    roots = [root / 'workspaces', root / 'runs'] + sorted((root / 'work').glob('review-*'))
    for base in roots:
        if not base.exists() or not real(base):
            continue
        for directory, dirs, files in os.walk(base, followlinks=False):
            p = pathlib.Path(directory)
            dirs[:] = [n for n in dirs if n not in CACHES | PROTECTED and not (p / n).is_symlink()]
            if (p / '.git').exists():
                yield p
                dirs[:] = []


def session_for(root, repo):
    parts = repo.relative_to(root).parts
    if parts[0] == 'workspaces':
        return parts[1]
    if parts[0] == 'runs' and len(parts) >= 3 and parts[1] in {'delivery', 'browser-drain'}:
        return parts[2]
    return None


def custody(db, root, repo):
    sid = session_for(root, repo)
    if sid:
        row = db.execute('select status,pid,provider,brief from sessions where id=?', (sid,)).fetchone()
        if row is None or row[0] not in {'finished', 'archived', 'waiting-browser'} or row[1] is not None:
            return None
        # Native supervision clears sessions.pid before browser collection and
        # publication. Only positive absence of the recorded original supervisor
        # releases that interval; legacy or inaccessible custody stays retained.
        original = db.execute("select data from events where kind='custody' and json_extract(data,'$.id')=? order by at desc,rowid desc limit 1", (sid,)).fetchone()
        if original is None:
            return None
        supervisor = json.loads(original[0]).get('pid')
        if not isinstance(supervisor, int) or supervisor < 1:
            return None
        try:
            os.kill(supervisor, 0)
        except ProcessLookupError:
            pass
        except OSError:
            return None
        else:
            return None
        if (root / 'workspaces' / sid / '.factory-tmp/browser-needed.json').exists():
            return None
        if row[0] == 'waiting-browser' and (row[2] != 'codex' or json.loads(row[3]).get('repo') not in {'fulmar-hq/alido', 'fulmar-hq/agent-factory'}):
            return None
        if row[0] == 'waiting-browser':
            binding = db.execute('select value from kv where key=?', ('dependency-installation:' + sid,)).fetchone()
            if binding is None or not isinstance(json.loads(binding[0]), str) or not re.fullmatch(r'[a-f0-9]{64}', json.loads(binding[0])):
                return None
        proof = db.execute('select value from kv where key=?', ('cleanup-evidence:' + sid,)).fetchone()
        if proof is None or json.loads(proof[0]).get('verified') is not True:
            return None
        return [root / 'workspaces' / sid, root / 'runs/delivery' / sid, root / 'runs/browser-drain' / sid, repo]
    # Non-session review/rehearsal clones need a full quiet hour as well as
    # process/cwd/open-file proof. A live maintenance lease excludes them.
    lease = db.execute("select value from kv where key='launcher-maintenance-lease'").fetchone()
    if lease and json.loads(lease[0]) and json.loads(lease[0]).get('state') != 'released':
        return None
    if time.time() - max(repo.stat().st_mtime, (repo / '.git').stat().st_mtime) < 3600:
        return None
    return [repo]


class Snapshot:
    """Bounded materialized rows; the controller is closed before external probes."""
    def __init__(self, rows):
        self.rows = rows

    def execute(self, query, args=()):
        row = self.rows.get((query, tuple(args)))
        class Cursor:
            def fetchone(self):
                return row
        return Cursor()


def controller_snapshot(root, repo):
    sid = session_for(root, repo)
    rows = {}
    db = sqlite3.connect((root / 'controller.sqlite').as_uri() + '?mode=ro', uri=True, timeout=0.5)
    try:
        def read(query, args):
            row = db.execute(query, args).fetchone()
            if row and any(isinstance(value, str) and len(value) > 16 * 1024 * 1024 for value in row):
                raise RuntimeError('bounded cache observation exceeded')
            rows[(query, tuple(args))] = row
            return row
        keys = ['launcher-maintenance-lease']
        if sid:
            read('select status,pid,provider,brief from sessions where id=?', (sid,))
            read("select data from events where kind='custody' and json_extract(data,'$.id')=? order by at desc,rowid desc limit 1", (sid,))
            keys += ['cleanup-evidence:' + sid, 'dependency-installation:' + sid,
                     'publisher-dependency-installation:' + hashlib.sha256(str(repo).encode()).hexdigest()]
        for key in keys:
            row = read('select value from kv where key=?', (key,))
            if row and key.startswith(('dependency-installation:', 'publisher-dependency-installation:')):
                bound = json.loads(row[0])
                fingerprint = bound if isinstance(bound, str) else bound.get('fingerprint') if isinstance(bound, dict) else None
                if isinstance(fingerprint, str) and re.fullmatch(r'[a-f0-9]{64}', fingerprint):
                    read('select value from kv where key=?', ('dependency-cache-manifest:' + fingerprint,))
    finally:
        db.close()
    return Snapshot(rows)


def sweep(root, apply=False):
    if apply:
        raise RuntimeError('archive-only policy: destructive cache apply is unavailable')
    if not root.is_dir() or not real(root):
        raise RuntimeError('real existing factory root required')
    database = root / 'controller.sqlite'
    if not database.is_file() or not real(database):
        raise RuntimeError('existing local controller required')
    for parent in [root / 'receipts', root / 'receipts/cache-retention']:
        if parent.is_symlink() or not real(parent):
            raise RuntimeError('linked receipt root refused')
        parent.mkdir(mode=0o700, exist_ok=True)
    receipts = root / 'receipts/cache-retention'
    with (receipts / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'already-running', 'mode': 'audit-only', 'recoveredBytes': 0}
        output = receipts / (str(time.time_ns()) + '.jsonl')
        with output.open('x') as log:
            os.chmod(output, 0o600)
            def record(data):
                log.write(json.dumps({'at': time.time(), **data}) + '\n')
                log.flush()
                os.fsync(log.fileno())
            record({'state': 'start', 'mode': 'audit-only', 'recoveredBytes': 0, 'df': command(['/bin/df', '-k', str(root)])})
            for repo in repositories(root):
                for name in sorted(CACHES):
                    cache = repo / name
                    if not cache.exists() or cache.is_symlink():
                        continue
                    try:
                        db = controller_snapshot(root, repo)
                        paths = custody(db, root, repo)
                        if not paths or not eligible(repo, cache):
                            continue
                        manifest = cache_manifest(db, root, repo, name)
                        if not manifest or not has_generated(cache, manifest) or not quiet(paths):
                            continue
                        # An observation is never deletion or eviction authority.
                        record({'state': 'planned', 'mode': 'audit-only', 'path': str(cache), 'retained': True, 'recoveredBytes': 0})
                    except Exception as exc:
                        record({'state': 'refused', 'path': str(cache), 'error': str(exc)})
            record({'state': 'complete', 'mode': 'audit-only', 'recoveredBytes': 0, 'df': command(['/bin/df', '-k', str(root)])})
        return {'state': 'complete', 'mode': 'audit-only', 'recoveredBytes': 0, 'receipt': str(output)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--root', type=pathlib.Path)
    group.add_argument('--fingerprint', type=pathlib.Path)
    parser.add_argument('--inventory', action='store_true')
    args = parser.parse_args()
    if args.fingerprint:
        result = dependency_identity(args.fingerprint, args.inventory)
        print(json.dumps(result) if args.inventory else result)
    else:
        print(json.dumps(sweep(args.root)))
