#!/usr/bin/env python3
"""Factory-only regenerable caches. Source, Git and operational evidence stay put."""
import argparse, fcntl, json, os, pathlib, sqlite3, subprocess, time

CACHES = {'node_modules', '.next', '.turbo'}
PROTECTED = {'.git', '.factory-tmp', 'receipts', 'evidence', 'transcripts', 'logs',
             'test-results', 'playwright-report', 'coverage', 'artifacts'}


def command(args, allowed=(0,)):
    p = subprocess.run(args, capture_output=True, text=True, timeout=120,
                       env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
    if p.returncode not in allowed:
        raise RuntimeError('probe refused: ' + args[0] + ': ' + p.stderr[:200])
    return p.stdout


def real(p):
    return not p.is_symlink() and p.resolve() == p


def evidence(name):
    n = name.lower()
    return (n in PROTECTED or n in {'log', 'trace', 'traces'} or
            n.endswith(('.log', '.jsonl', '.bundle', '.receipt', '.sqlite', '.db')) or
            any(s in n for s in ('receipt', 'transcript', 'evidence')))


def quiet(paths):
    ps = command(['/bin/ps', '-axo', 'pid=,stat=,command='])
    files = command(['/usr/sbin/lsof', '-nP', '-a', '-u', str(os.getuid()), '-Fpn'])
    for line in ps.splitlines():
        f = line.strip().split(None, 2)
        if len(f) != 3 or int(f[0]) == os.getpid() or f[1].startswith('Z'):
            continue
        if any(str(p) in f[2] for p in paths):
            return False
    return not any(line.startswith('n') and any(
        line[1:] == str(p) or line[1:].startswith(str(p) + '/') for p in paths)
        for line in files.splitlines())


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
        for name in list(dirs):
            p = pathlib.Path(directory) / name
            if evidence(name) or p.is_symlink():
                dirs.remove(name)
            elif p.stat().st_dev != dev:
                return False
    return True


def has_generated(cache):
    with os.scandir(cache) as entries:
        for item in entries:
            if evidence(item.name):
                continue
            if item.is_dir(follow_symlinks=False):
                if has_generated(pathlib.Path(item.path)):
                    return True
            else:
                return True
    return False


def remove(cache):
    # Preserve in-cache evidence at its exact location; never follow links.
    for item in os.scandir(cache):
        p = pathlib.Path(item.path)
        if evidence(item.name):
            continue
        if item.is_dir(follow_symlinks=False):
            remove(p)
        else:
            p.unlink()
    try:
        cache.rmdir()
    except OSError:
        pass


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
    if parts[:2] == ('runs', 'delivery'):
        return parts[2]
    return None


def custody(db, root, repo):
    sid = session_for(root, repo)
    if sid:
        row = db.execute('select status,pid from sessions where id=?', (sid,)).fetchone()
        if row is None or row[0] not in {'finished', 'archived', 'waiting-browser'} or row[1] is not None:
            return None
        proof = db.execute('select value from kv where key=?', ('cleanup-evidence:' + sid,)).fetchone()
        if proof is None or json.loads(proof[0]).get('verified') is not True:
            return None
        return [root / 'workspaces' / sid, root / 'runs/delivery' / sid]
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
                            if not has_generated(cache):
                                continue
                            # Serialize against launcher reservation/continuation and
                            # reread custody + process/path evidence immediately before I/O.
                            db.execute('BEGIN IMMEDIATE')
                            try:
                                paths = custody(db, root, repo)
                                if not paths or not quiet(paths) or not eligible(repo, cache):
                                    continue
                                record({'state': 'intent', 'path': str(cache), 'apply': apply})
                                if apply:
                                    if name == 'node_modules':
                                        scratch = repo / '.factory-tmp'
                                        if scratch.is_symlink():
                                            raise RuntimeError('linked scratch refused')
                                        scratch.mkdir(exist_ok=True)
                                        marker = scratch / 'dependencies-evicted.jsonl'
                                        if marker.is_symlink():
                                            raise RuntimeError('linked restoration marker refused')
                                        with marker.open('a') as pending:
                                            pending.write(json.dumps({'at': time.time(), 'receipt': str(output)}) + '\n')
                                    remove(cache)
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
    parser.add_argument('--root', required=True, type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(sweep(args.root, args.apply)))
