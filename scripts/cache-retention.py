#!/usr/bin/env python3
"""Factory-only regenerable caches. Source, Git and operational evidence stay put."""
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


def remove(cache, manifest=None, base=None):
    base = base or cache
    # Preserve in-cache evidence at its exact location; never follow links.
    for item in os.scandir(cache):
        p = pathlib.Path(item.path)
        if evidence(p.name):
            continue
        if item.is_dir(follow_symlinks=False):
            remove(p, manifest, base)
        elif not retained_entry(p, base, manifest):
            p.unlink()
    # Unknown empty directories may carry evidence too. Remove only directories
    # known to the original installation (or the root once it is empty).
    if manifest is not None and (cache == base or manifest['entries'].get(str(cache.relative_to(base))) == {'kind': 'dir'}):
        try:
            cache.rmdir()
        except OSError:
            pass


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
    if name != 'node_modules' or repo != root / 'workspaces' / str(sid):
        return None
    binding = db.execute('select value from kv where key=?', ('dependency-installation:' + sid,)).fetchone()
    if binding is None:
        return None
    fingerprint = json.loads(binding[0])
    if not isinstance(fingerprint, str) or not re.fullmatch(r'[a-f0-9]{64}', fingerprint):
        return None
    row = db.execute('select value from kv where key=?', ('dependency-cache-manifest:' + fingerprint,)).fetchone()
    if row is None:
        return None
    manifest = json.loads(row[0])
    if (not isinstance(manifest, dict) or manifest.get('version') != 1 or
        manifest.get('fingerprint') != json.loads(binding[0]) or not isinstance(manifest.get('entries'), dict)):
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
        if row[0] == 'waiting-browser' and (row[2] != 'codex' or json.loads(row[3]).get('repo') not in {'fulmar-hq/alido', 'fulmar-hq/agent-factory'}):
            return None
        if row[0] == 'waiting-browser':
            binding = db.execute('select value from kv where key=?', ('dependency-installation:' + sid,)).fetchone()
            if binding is None or not isinstance(json.loads(binding[0]), str) or not re.fullmatch(r'[a-f0-9]{64}', json.loads(binding[0])):
                return None
        proof = db.execute('select value from kv where key=?', ('cleanup-evidence:' + sid,)).fetchone()
        if proof is None or json.loads(proof[0]).get('verified') is not True:
            return None
        return [root / 'workspaces' / sid, root / 'runs/delivery' / sid, repo]
    # Non-session review/rehearsal clones need a full quiet hour as well as
    # process/cwd/open-file proof. A live maintenance lease excludes them.
    lease = db.execute("select value from kv where key='launcher-maintenance-lease'").fetchone()
    if lease and json.loads(lease[0]) and json.loads(lease[0]).get('state') != 'released':
        return None
    if time.time() - max(repo.stat().st_mtime, (repo / '.git').stat().st_mtime) < 3600:
        return None
    return [repo]


def sweep(root, apply=False):
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
            return {'state': 'already-running'}
        output = receipts / (str(time.time_ns()) + '.jsonl')
        with output.open('x') as log:
            os.chmod(output, 0o600)
            def record(data):
                log.write(json.dumps({'at': time.time(), **data}) + '\n')
                log.flush()
                os.fsync(log.fileno())
            record({'state': 'start', 'apply': apply, 'df': command(['/bin/df', '-k', str(root)])})
            db = sqlite3.connect(root / 'controller.sqlite', timeout=2)
            try:
                for repo in repositories(root):
                    for name in sorted(CACHES):
                        cache = repo / name
                        if not cache.exists() or cache.is_symlink():
                            continue
                        try:
                            if not custody(db, root, repo) or not eligible(repo, cache):
                                continue
                            manifest = cache_manifest(db, root, repo, name)
                            if not manifest or not has_generated(cache, manifest):
                                continue
                            # Serialize against launcher reservation/continuation and
                            # reread custody + process/path evidence immediately before I/O.
                            db.execute('BEGIN IMMEDIATE')
                            try:
                                paths = custody(db, root, repo)
                                if not paths or not quiet(paths) or not eligible(repo, cache) or cache_manifest(db, root, repo, name) != manifest:
                                    continue
                                record({'state': 'intent', 'path': str(cache), 'apply': apply})
                                if apply:
                                    sid = session_for(root, repo)
                                    state = db.execute('select status from sessions where id=?', (sid,)).fetchone() if sid else None
                                    if name == 'node_modules' and repo.parent == root / 'workspaces' and state and state[0] == 'waiting-browser':
                                        scratch = repo / '.factory-tmp'
                                        if scratch.is_symlink():
                                            raise RuntimeError('linked scratch refused')
                                        scratch.mkdir(exist_ok=True)
                                        marker = scratch / 'dependencies-evicted.jsonl'
                                        if marker.is_symlink() or (marker.exists() and (not marker.is_file() or marker.stat().st_nlink != 1)):
                                            raise RuntimeError('linked restoration marker refused')
                                        if not marker.exists():
                                            binding = db.execute('select value from kv where key=?', ('dependency-installation:' + sid,)).fetchone()
                                            identity = json.loads(binding[0])
                                            with marker.open('x') as pending:
                                                pending.write(json.dumps({'at': time.time(), 'receipt': str(output), 'dependencyFingerprint': identity}) + '\n')
                                    remove(cache, manifest)
                                record({'state': 'removed' if apply else 'planned', 'path': str(cache)})
                            finally:
                                db.rollback()
                        except Exception as exc:
                            record({'state': 'refused', 'path': str(cache), 'error': str(exc)})
            finally:
                db.close()
            record({'state': 'complete', 'df': command(['/bin/df', '-k', str(root)])})
        return {'state': 'complete', 'receipt': str(output)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--root', type=pathlib.Path)
    group.add_argument('--fingerprint', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--inventory', action='store_true')
    args = parser.parse_args()
    if args.fingerprint:
        result = dependency_identity(args.fingerprint, args.inventory)
        print(json.dumps(result) if args.inventory else result)
    else:
        print(json.dumps(sweep(args.root, args.apply)))
