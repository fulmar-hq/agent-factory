"""Protected factory release operations. Never uses workstation credentials.

Every external mutation has a unique workflow run; a failed/unknown mutation is
not retried. The Mini retains its dispatch claim and reconciles this run only.
"""
import datetime
import base64
import shlex
import urllib.request
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

REPO = 'fulmar-hq/alido'
SHA = re.compile(r'[a-f0-9]{40}')


def journal(kind, data):
    path = os.environ.get('FACTORY_EFFECT_JOURNAL')
    if not path:
        return
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, (json.dumps({'at': int(time.time() * 1000), 'kind': kind, **data}) + '\n').encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def api(path, method='GET', body=None):
    args = ['gh', 'api', '--method', method, 'repos/' + REPO + '/' + path]
    if body is not None:
        args += ['--input', '-']
    if method != 'GET':
        journal('mutation-intent', {'method': method, 'path': path, 'body': body})
    p = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                       text=True, capture_output=True, timeout=45)
    if p.returncode:
        raise RuntimeError('GitHub operation failed; reconcile outcome before any retry: ' + p.stderr[:300])
    value = json.loads(p.stdout) if p.stdout.strip() else None
    if method != 'GET':
        journal('mutation-response', {'method': method, 'path': path, 'response': value})
    return value


def validate(c, now=None, effect=True):
    now = time.time() if now is None else now
    local = datetime.datetime.fromtimestamp(now, ZoneInfo('America/Toronto'))
    if not all(isinstance(c.get(k), str) and SHA.fullmatch(c[k]) for k in ('revision', 'tree')):
        raise ValueError('Frozen SHA/tree required')
    if c['day'] != local.date().isoformat() or now * 1000 >= c['deadline']:
        raise ValueError('Wrong day or expired release deadline')
    cutoff_clock = '19:50' if c['step'] == 'preflight' else '21:20' if c['step'] == 'qa' else '22:00'
    cutoff = datetime.datetime.fromisoformat(c['day'] + 'T' + cutoff_clock).replace(tzinfo=ZoneInfo('America/Toronto')).timestamp() * 1000
    if c['deadline'] > cutoff:
        raise ValueError('Deadline exceeds fixed release cutoff')
    minute = local.hour * 60 + local.minute
    windows = {'preflight': (1140, 1190), 'qa': (1200, 1201),
               'promote': (1290, 1291), 'readback': (1290, 1320)}
    start, end = windows[c['step']]
    if effect and not start <= minute < end:
        raise ValueError('Outside fixed release effect window')
    expected = hashlib.sha256(json.dumps([c['day'], c['step'], c.get('admitted_revision', c['revision']), c['tree']], separators=(',', ':')).encode()).hexdigest()
    if expected != c['key']:
        raise ValueError('Effect identity differs')


def branch(name):
    return api('git/ref/heads/' + name)['object']['sha']


def tree(revision):
    return api('git/commits/' + revision)['tree']['sha']


def hold():
    value = json.loads(api('actions/variables/QA_HOLD')['value'])
    # This installation retains protocol1. Unknown migrations require the
    # supported captain rollout, never a guessed same-ID success.
    fields = {'version', 'held', 'reason', 'by', 'at', 'id', 'legacy_issue'}
    if (not isinstance(value, dict) or set(value) != fields or type(value.get('version')) is not int
            or value['version'] != 1 or type(value.get('held')) is not bool
            or any(not isinstance(value[k], str) or not value[k].strip() for k in ('reason', 'by', 'at', 'id'))
            or len(value['reason']) > 500 or len(value['by']) > 120
            or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', value['id'])
            or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value['at'])
            or value['legacy_issue'] is not None and (type(value['legacy_issue']) is not int or value['legacy_issue'] < 1)):
        raise ValueError('Complete supported QA hold required')
    datetime.datetime.fromisoformat(value['at'].replace('Z', '+00:00'))
    return value


def guard(c, expected_hold, held=None):
    if branch('QA') != c['revision'] or tree(c['revision']) != c['tree']:
        raise ValueError('Frozen QA source changed before effect')
    current = hold()
    if current['id'] != expected_hold or (held is not None and current['held'] is not held):
        raise ValueError('Expected hold changed before effect')
    return current


def carrier(c):
    """Read-only exact-head admission. Never update/rebase a frozen carrier."""
    b = c['batch']
    if (b.get('version') != 1 or b.get('day') != c['day'] or b.get('revision') != c['revision']
            or b.get('tree') != c['tree'] or b.get('holdId') != c['hold_id']):
        raise ValueError('Reviewed batch context differs')
    pull = api('pulls/' + str(b['pr']))
    # JSON property order is fixed by the strict controller schema.
    digest = hashlib.sha256(json.dumps(b, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    if (pull.get('state') != 'open' or pull.get('draft') is not False
            or pull['head']['sha'] != b['revision'] or pull['head']['ref'] != b['ref']
            or pull['head']['repo']['full_name'] != REPO or pull['base']['ref'] != 'QA'
            or pull['base']['repo']['full_name'] != REPO or pull['base']['sha'] != b['base']
            or pull.get('mergeable') is not True or pull.get('mergeable_state') != 'clean'
            or 'factory-batch-sha256:' + digest not in (pull.get('body') or '')):
        raise ValueError('Carrier identity/base/merge readiness changed')
    if branch('QA') != b['base'] or tree(b['revision']) != b['tree']:
        raise ValueError('Carrier base/tree moved')
    state = hold()
    if state.get('held') is not False or state.get('id') != b['holdId'] or state.get('version') not in (1, 2):
        raise ValueError('Explicit matching OFF hold required')
    if state['version'] == 2 and {'number': b['pr'], 'head': b['revision'], 'ref': b['ref']} not in state.get('batch', []):
        raise ValueError('Carrier not admitted by batch hold')
    for number in {1192, state.get('legacy_issue')} - {None}:
        labels = api('issues/' + str(number))['labels']
        if not isinstance(labels, list) or any(x.get('name') in ('QA hold', 'qa-hold') for x in labels):
            raise ValueError('Release board hold is on or unknown')
    promotions = api('pulls?state=open&base=main&per_page=100')
    if not isinstance(promotions, list) or len(promotions) >= 100 or any(p['head']['ref'] == 'QA' for p in promotions):
        raise ValueError('Existing/unknown promotion owns release')
    checks = api('commits/' + b['revision'] + '/check-runs?per_page=100')
    runs = checks.get('check_runs')
    if not isinstance(runs, list) or checks.get('total_count') != len(runs) or len(runs) >= 100:
        raise ValueError('Carrier check inventory incomplete')
    for name in ('Verify', 'Secret scan', 'Release hold'):
        found = sorted((r for r in runs if r['name'] == name and r.get('app', {}).get('slug') == 'github-actions'), key=lambda r: r['id'], reverse=True)
        if not found or found[0].get('head_sha') != b['revision'] or found[0]['status'] != 'completed' or found[0]['conclusion'] != 'success':
            raise ValueError('Exact carrier check failed/missing: ' + name)
    return pull


def merge_carrier(c):
    carrier(c)
    # Repeat current clock and branch/hold directly before the single write.
    validate(c)
    b = c['batch']
    current = hold()
    if branch('QA') != b['base'] or current['id'] != c['hold_id'] or current['held'] is not False:
        raise ValueError('Carrier admission changed before merge')
    validate(c)
    merged = api('pulls/' + str(b['pr']) + '/merge', 'PUT', {'sha': b['revision'], 'merge_method': 'squash'})
    revision = merged.get('sha')
    if merged.get('merged') is not True or not isinstance(revision, str) or not SHA.fullmatch(revision):
        raise RuntimeError('Carrier merge uncertain; never retry')
    commit = api('commits/' + revision)
    if (branch('QA') != revision or commit['commit']['tree']['sha'] != c['tree']
            or commit['commit']['verification']['verified'] is not True
            or [p['sha'] for p in commit['parents']] != [b['base']]):
        raise RuntimeError('Merged carrier source/tree/signature differs; retain custody')
    journal('carrier-merged', {'pr': b['pr'], 'revision': revision, 'tree': c['tree'], 'sources': b['sources']})
    return {**c, 'revision': revision, 'admitted_revision': c['revision']}


def freeze(c):
    # Execute only exact protected-main blobs; canonical checkout dirt/age is irrelevant.
    from pathlib import Path
    directory = Path(c['scratch']) / 'protected-source'
    captain_source = branch('main')
    for path in ('.github/workflows/release-hold.yml', 'infra/ci/release_hold.py',
                 'infra/ci/release_control.py', 'infra/ci/release_captain.py'):
        remote = api('contents/' + path + '?ref=' + captain_source)
        content = base64.b64decode(remote['content'])
        if hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest() != remote['sha']:
            raise ValueError('Protected captain blob differs')
        target = directory / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, 'xb') as stream:
            stream.write(content)
    validate(c, effect=not bool(c.get('admitted_revision')))
    guard(c, c['hold_id'])
    journal('freeze-intent', {'expectedHold': c['hold_id'], 'tree': c['tree'], 'source': captain_source})
    subprocess.run(['/usr/bin/python3', '-B', str(directory / 'infra/ci/release_captain.py'),
                    'hold', 'on', '--expect', c['hold_id'], '--reason', 'Factory frozen tree ' + c['tree']],
                   check=True, capture_output=True, text=True, timeout=120, cwd=directory)
    state = hold()
    if not state['held']:
        raise ValueError('Supported freeze not confirmed')
    journal('freeze-readback', {'hold': state})
    return state


def publish_authority(c, environment, fields):
    payload = {k: c[k] for k in ('day', 'revision', 'tree', 'hold_id')}
    payload.update(fields)
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode().rstrip('=')
    api('statuses/' + c['revision'], 'POST', {'state': 'success', 'context': 'factory/' + environment,
        'description': 'Frozen factory release authority',
        'target_url': 'https://github.com/fulmar-hq/alido/actions#factory=' + encoded})


def variable(name, value):
    # Bounded inventory proves absence before explicit one-time bootstrap.
    inventory = api('actions/variables?per_page=100')['variables']
    if len(inventory) == 100:
        raise RuntimeError('Variable inventory truncated')
    found = [x for x in inventory if x['name'] == name]
    if not found and name != 'ALIDO_FACTORY_RELEASE':
        raise ValueError('Existing release pin missing')
    previous = found[0]['value'] if found else None
    api('actions/variables/' + name if found else 'actions/variables', 'PATCH' if found else 'POST', {'name': name, 'value': value})
    if api('actions/variables/' + name)['value'] != value:
        raise RuntimeError('Variable write readback differs; retain freeze')
    return previous


def wait(c, read):
    while time.time() * 1000 < c['deadline']:
        result = read()
        if result is not None:
            return result
        time.sleep(5)
    raise TimeoutError('Release deadline expired; no catch-up')


def workflow(c, name, revision, required, run_id=None, attempt=None):
    def read():
        if run_id is not None:
            run = api('actions/runs/' + str(run_id))
            if (run.get('head_sha') != revision or run.get('event') != 'push'
                    or run.get('path') != '.github/workflows/' + name
                    or run.get('run_attempt') != attempt):
                raise RuntimeError('Exact native run/attempt identity differs')
        else:
            runs = api('actions/workflows/' + name + '/runs?head_sha=' + revision + '&per_page=100')['workflow_runs']
            if not runs:
                return None
            run = max(runs, key=lambda r: r['id'])
        jobs = api('actions/runs/' + str(run['id']) + '/jobs?per_page=100')['jobs']
        if len(jobs) == 100:
            raise RuntimeError('Truncated jobs evidence')
        for required_name in required:
            found = [j for j in jobs if j['name'] == required_name]
            if len(found) > 1:
                raise RuntimeError('Ambiguous check')
            if not found or found[0]['status'] != 'completed':
                if run['status'] == 'completed':
                    raise RuntimeError('Required job absent/incomplete')
                return None
            if found[0]['conclusion'] != 'success':
                raise RuntimeError('Required check failed/skipped: ' + required_name)
        return run
    return wait(c, read)


def logs(run):
    return subprocess.run(['gh', 'run', 'view', str(run), '--repo', REPO, '--log'],
                          capture_output=True, text=True, check=True, timeout=45).stdout


def deployed(run, revision):
    # Native guarded deployment emits the exact host verification and retained
    # rollback evidence, not merely a successful workflow conclusion.
    receipts = []
    for line in logs(run).splitlines():
        pos = line.find('{"deployment":')
        if pos >= 0:
            receipts.append(json.loads(line[pos:]))
    if len(receipts) != 1:
        raise RuntimeError('Unique native deployment receipt missing')
    value = receipts[0]['deployment']
    if value.get('source') != revision or value.get('environmentUnchanged') is not True or value.get('previousStopped') is not True:
        raise RuntimeError('Source/configuration/rollback verification differs')
    return value



def accepted(c):
    a = c['acceptance']
    if not isinstance(a, dict) or any(a.get(k) != c[k] for k in ('day', 'revision', 'tree')) or a.get('verdict') != 'ACCEPT':
        raise ValueError('Quality ACCEPT for frozen tree required')
    if not all(isinstance(a.get(k), str) and a[k] for k in ('artifact', 'evidence', 'wake', 'native')):
        raise ValueError('Independent Quality provenance missing')
    cutoff = datetime.datetime.fromisoformat(c['day'] + 'T21:20').replace(tzinfo=ZoneInfo('America/Toronto')).timestamp() * 1000
    if not isinstance(a.get('at'), int) or not 0 < a['at'] < cutoff:
        raise ValueError('Quality deadline missed')
    return a


def gate(environment):
    """Rechecked from deployment entrypoints, immediately before each effect."""
    frozen = json.loads(api('actions/variables/ALIDO_FACTORY_RELEASE')['value'])
    now = datetime.datetime.now(ZoneInfo('America/Toronto'))
    if frozen['day'] != now.date().isoformat():
        raise ValueError('No current-day frozen release')
    minute = now.hour * 60 + now.minute
    if not ((1200 <= minute < 1280) if environment == 'qa' else (1290 <= minute < 1320)):
        raise ValueError('Deployment effect outside release window')
    source = os.environ.get('SOURCE_SHA', '')
    if not SHA.fullmatch(source) or tree(source) != frozen['tree']:
        raise ValueError('Deployment tree differs from frozen release')
    if environment == 'qa' and source != frozen['revision']:
        raise ValueError('QA source differs from frozen release')
    if environment == 'production':
        accepted({**frozen, 'acceptance': frozen.get('acceptance')})
    return frozen


def run(c):
    validate(c)
    if c['step'] not in ('preflight', 'qa', 'promote'):
        raise ValueError('Local executor has no AWS or readback operation')
    original_revision = c['revision']
    if c.get('batch') and c['step'] == 'preflight':
        carrier(c)
        readiness = c.get('readiness', {})
        now = int(time.time() * 1000)
        if (readiness.get('ready') is not True or readiness.get('missing') != []
                or readiness.get('day') != c['day'] or not isinstance(readiness.get('at'), int)
                or not 0 <= now - readiness['at'] < 300000):
            raise ValueError('Complete fresh release readiness required')
        return {'version': 1, 'key': c['key'], 'day': c['day'], 'step': c['step'],
                'revision': c['revision'], 'tree': c['tree'], 'status': 'success',
                'completedAt': now, 'readiness': True, 'inputs': readiness}
    if c.get('batch') and c['step'] == 'qa':
        c = merge_carrier(c)
    if branch('QA') != c['revision'] or tree(c['revision']) != c['tree']:
        raise ValueError('Frozen QA source changed')
    state = hold()
    if state['id'] != c['hold_id']:
        raise ValueError('Expected current hold identity required')
    if c['step'] == 'promote' and not state['held']:
        raise ValueError('Expected current ON freeze required')
    result = {}
    if c['step'] == 'preflight':
        # Pinned CI dispatch is test-only and cannot build or deploy.
        validate(c)
        guard(c, c['hold_id'])
        api('actions/workflows/ci.yml/dispatches', 'POST', {'ref': 'QA', 'inputs': {'factory_preflight': c['revision']}})
        def read():
            runs = api('actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=' + c['revision'] + '&per_page=100')['workflow_runs']
            found = [r for r in runs if datetime.datetime.fromisoformat(r['created_at'].replace('Z', '+00:00')) >= datetime.datetime.fromisoformat(os.environ['FACTORY_DISPATCHED_AT'].replace('Z', '+00:00')).replace(microsecond=0)]
            if len(found) > 1:
                raise RuntimeError('Ambiguous preflight dispatch')
            if not found or found[0]['status'] != 'completed':
                return None
            if found[0]['conclusion'] != 'success':
                raise RuntimeError('Preflight failed')
            jobs = api('actions/runs/' + str(found[0]['id']) + '/jobs?per_page=100')['jobs']
            if not any(j['name'] == 'Full test suite' and j['conclusion'] == 'success' for j in jobs):
                raise RuntimeError('Full preflight proof missing')
            return {'preflightRun': found[0]['id']}
        result = wait(c, read)
    elif c['step'] == 'qa':
        # A batch admitted at20:00 may finish its freeze/build inside the fixed
        # QA deadline. A late process cannot claim or merge a new batch.
        validate({**c, 'revision': original_revision}, effect=not bool(c.get('batch')))
        if not state['held']:
            state = freeze(c)
        frozen_hold_id = state['id']
        # First wait for the automatic light push run; never rerun an active run.
        def completed_push():
            runs = api('actions/workflows/ci.yml/runs?event=push&head_sha=' + c['revision'] + '&branch=QA&per_page=100')['workflow_runs']
            if len(runs) >= 100:
                raise RuntimeError('QA push inventory incomplete')
            if not runs:
                return None
            latest = max(runs, key=lambda r: r['id'])
            if latest['status'] != 'completed':
                return None
            if latest['conclusion'] != 'success':
                raise RuntimeError('Initial QA push checks failed; never retry')
            return latest
        original = wait(c, completed_push)
        run_id = original['id']
        frozen = {k: c[k] for k in ('day', 'revision', 'tree', 'hold_id')}
        frozen['hold_id'] = frozen_hold_id
        guard(c, frozen_hold_id, True)
        previous = variable('ALIDO_FACTORY_RELEASE', json.dumps(frozen, separators=(',', ':')))
        validate(c, effect=False)
        guard(c, frozen_hold_id, True)
        pin = variable('ALIDO_QA_BATCH_SHA', c['revision'])
        validate(c, effect=False)
        guard(c, frozen_hold_id, True)
        publish_authority({**c, 'hold_id': frozen_hold_id}, 'qa', {'qaRun': run_id, 'qaAttempt': original['run_attempt'] + 1})
        validate(c, effect=False)
        guard(c, frozen_hold_id, True)
        api('actions/runs/' + str(run_id) + '/rerun', 'POST')
        def started():
            current = api('actions/runs/' + str(run_id))
            return current if current['run_attempt'] == original['run_attempt'] + 1 else None
        wait(c, started)
        run = workflow(c, 'ci.yml', c['revision'], ['Verify', 'Secret scan', 'Full test suite', 'Build candidate image / Build', 'Deploy QA'], run_id, original['run_attempt'] + 1)
        # Candidate adoption log is immutable digest evidence for this tree.
        candidates = re.findall(r'"adopted":\s*"([^"]+@sha256:[a-f0-9]{64})"', logs(run['id']))
        if len(set(candidates)) != 1:
            raise RuntimeError('Unique immutable QA artifact missing')
        qa_log = logs(run['id'])
        confirmations = []
        for line in qa_log.splitlines():
            pos = line.find('{"qaDeployment":')
            if pos >= 0:
                confirmations.append(json.loads(line[pos:]))
        if len(confirmations) != 1 or confirmations[0].get('source') != c['revision']:
            raise RuntimeError('Unique native hosted QA source confirmation missing')
        result = {'qaRevision': c['revision'], 'qaReadback': confirmations[0], 'artifact': candidates[0], 'qaRun': run['id'], 'qaAttempt': run['run_attempt'], 'holdId': frozen_hold_id, 'previousPin': pin, 'previousRelease': previous}
    elif c['step'] == 'promote':
        a = accepted(c)
        qa = workflow(c, 'ci.yml', c['revision'], ['Full test suite', 'Deploy QA'], a['qaRun'], a['qaAttempt'])
        if a['artifact'] not in logs(qa['id']):
            raise ValueError('Quality artifact not the deployed QA artifact')
        existing = api('pulls?state=open&base=main&head=fulmar-hq:QA&per_page=100')
        if existing:
            raise ValueError('Existing promotion owns release')
        frozen = {k: c[k] for k in ('day', 'revision', 'tree', 'hold_id')}
        frozen['acceptance'] = a
        validate(c)
        guard(c, c['hold_id'], True)
        variable('ALIDO_FACTORY_RELEASE', json.dumps(frozen, separators=(',', ':')))
        validate(c)
        guard(c, c['hold_id'], True)
        publish_authority(c, 'production', {'artifact': a['artifact'], 'qaRun': a['qaRun'], 'qaAttempt': a['qaAttempt'], 'acceptedAt': a['at'], 'verdict': 'ACCEPT'})
        validate(c)
        guard(c, c['hold_id'], True)
        pull = api('pulls', 'POST', {'base': 'main', 'head': 'QA', 'title': 'Promote accepted QA tree', 'body': 'Factory frozen tree ' + c['tree'] + '; Quality receipt ' + a['evidence']})
        def checks():
            current = api('pulls/' + str(pull['number']))
            if current['head']['sha'] != c['revision']:
                raise ValueError('Promotion source changed')
            merge_sha = current.get('merge_commit_sha')
            if not merge_sha or current.get('mergeable_state') not in ('clean', 'unstable'):
                return None
            status = api('commits/' + merge_sha + '/check-runs?per_page=100')['check_runs']
            if len(status) == 100:
                raise RuntimeError('Promotion check inventory truncated')
            required = [x for x in status if x['name'] in ('Verify', 'Secret scan')]
            if any(x['status'] != 'completed' for x in required) or len(required) < 2:
                return None
            if any(x['conclusion'] != 'success' for x in required):
                raise RuntimeError('Promotion check failed')
            return current
        wait(c, checks)
        validate(c, effect=False)
        guard(c, c['hold_id'], True)
        merged = api('pulls/' + str(pull['number']) + '/merge', 'PUT', {'sha': c['revision'], 'merge_method': 'squash'})
        main = merged['sha']
        if not merged['merged'] or tree(main) != c['tree']:
            raise RuntimeError('Protected promotion tree differs')
        result = {'main': main, 'promotion': pull['number'], 'artifact': a['artifact']}
    else:
        raise ValueError('Remote readback only')
    validate({**c, 'revision': original_revision}, effect=False)
    return {'version': 1, 'key': c['key'], 'day': c['day'], 'step': c['step'], 'revision': original_revision,
            'tree': c['tree'], 'status': 'success', 'completedAt': int(time.time() * 1000), **result}


if __name__ == '__main__':
    import pathlib
    result_path = pathlib.Path(sys.argv[2])
    try:
        c = json.loads(pathlib.Path(sys.argv[1]).read_text())
        os.environ['FACTORY_DISPATCHED_AT'] = c['dispatched_at']
        os.environ['FACTORY_EFFECT_JOURNAL'] = str(pathlib.Path(c['scratch']) / 'mutations.jsonl')
        result = {'state': 'success', 'evidence': run(c)}
    except Exception as error:
        result = {'state': 'failure', 'evidence': {'reason': type(error).__name__ + ': ' + str(error)}}
    temporary = result_path.with_suffix('.writing')
    with open(temporary, 'x') as stream:
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, result_path)
