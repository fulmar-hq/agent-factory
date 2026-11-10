"""Read real release inputs, then execute release code against a synthetic port.

The only live operation supported here is gh api GET. All writes, build results,
Quality acceptance and hosted observations in the contract run are SYNTHETIC.
An actual readiness refusal remains a failed rehearsal, even if contracts pass.
"""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
import types
from unittest.mock import patch
from zoneinfo import ZoneInfo

REPO = 'fulmar-hq/alido'
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('window_release', HERE / 'alido-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def epoch(day, clock):
    return datetime.datetime.fromisoformat(day + 'T' + clock).replace(tzinfo=ZoneInfo('America/Toronto')).timestamp()


def context(batch, step, revision=None, hold_id=None):
    revision = revision or batch['revision']
    cutoff = '19:50' if step == 'preflight' else '21:20' if step == 'qa' else '22:00'
    result = {'day': batch['day'], 'step': step, 'revision': revision, 'tree': batch['tree'],
              'hold_id': hold_id or batch['holdId'], 'deadline': int(epoch(batch['day'], cutoff) * 1000)}
    result['key'] = hashlib.sha256(json.dumps([result['day'], step, revision, result['tree']], separators=(',', ':')).encode()).hexdigest()
    if step in ('preflight', 'qa'):
        result['batch'] = batch
    return result


class LiveReads:
    def __init__(self):
        self.receipts = {}

    def api(self, path, method='GET', body=None):
        if method != 'GET' or body is not None:
            raise ValueError('Rehearsal permits live GET only')
        p = subprocess.run(['gh', 'api', '--method', 'GET', 'repos/' + REPO + '/' + path],
                           capture_output=True, text=True, timeout=45, check=True)
        result = json.loads(p.stdout)
        self.receipts[path] = result
        return result

    def pages(self, path):
        result = []
        for page in range(1, 101):
            rows = self.api(path + '&per_page=100&page=' + str(page))
            if not isinstance(rows, list):
                raise ValueError('Incomplete real PR inventory')
            result.extend(rows)
            if len(rows) < 100:
                if len({p['number'] for p in result}) != len(result):
                    raise ValueError('Changing/duplicate real PR inventory')
                return result
        raise ValueError('Real PR inventory exceeds bound')

    def source(self, path, revision):
        result = self.api('contents/' + path + '?ref=' + revision)
        body = base64.b64decode(result['content'])
        digest = hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest()
        if digest != result['sha']:
            raise ValueError('Real protected source blob differs')
        return body.decode()


class SyntheticWindow:
    """Deterministic in-memory GitHub state; never calls an external command."""
    def __init__(self, batch, pull, checks, remote_source):
        self.batch, self.pull, self.checks = batch, pull, checks
        self.now = epoch(batch['day'], '19:00:10')
        self.qa = batch['base']
        self.main = '1' * 40
        self.qa_result = '2' * 40
        self.main_result = '3' * 40
        self.hold = {'version': 1, 'id': batch['holdId'], 'held': False, 'legacy_issue': None,
                     'reason': 'SYNTHETIC reviewed batch', 'by': 'fictional-owner', 'at': batch['day'] + 'T23:00:00Z'}
        self.vars = {'ALIDO_QA_BATCH_SHA': batch['base']}
        self.statuses = {}
        self.attempt = 1
        self.mutations = []
        self.merge_calls = 0
        self.uncertain_merge = False
        self.quality_verdict = 'ACCEPT'
        self.artifact = 'SYNTHETIC-registry@sha256:' + '4' * 64
        self.remote = types.ModuleType('synthetic_protected_readback')
        exec(compile(remote_source, '<real-protected-readback-source>', 'exec'), self.remote.__dict__)

    def set_clock(self, clock):
        self.now = epoch(self.batch['day'], clock)

    def run_identity(self, ident):
        return {'id': ident, 'status': 'completed', 'conclusion': 'success', 'run_attempt': self.attempt,
                'head_sha': self.qa if ident == 9 else self.main, 'event': 'push' if ident == 9 else 'workflow_run',
                'path': '.github/workflows/ci.yml' if ident == 9 else '.github/workflows/deploy.yml'}

    def api(self, path, method='GET', body=None):
        if method != 'GET':
            self.mutations.append({'SYNTHETIC': True, 'at': int(self.now * 1000), 'method': method, 'path': path, 'body': body})
            if path == 'pulls/' + str(self.batch['pr']) + '/merge':
                self.merge_calls += 1
                self.qa = self.qa_result
                self.set_clock('20:03:00')
                if self.uncertain_merge:
                    raise RuntimeError('SYNTHETIC lost merge response: retain uncertain custody')
                return {'merged': True, 'sha': self.qa}
            if path == 'pulls':
                return {'number': 10}
            if path == 'pulls/10/merge':
                self.main = self.main_result
                return {'merged': True, 'sha': self.main}
            if path.startswith('actions/variables'):
                self.vars[body['name']] = body['value']
                return None
            if path.startswith('statuses/'):
                self.statuses[body['context']] = {**body, 'creator': {'login': 'vincentmessina'}}
                return None
            if path == 'actions/runs/9/rerun':
                self.attempt = 2
                return None
            raise ValueError('Unexpected SYNTHETIC mutation ' + path)
        if path == 'pulls/' + str(self.batch['pr']):
            return self.pull
        if path == 'pulls/10':
            return {'head': {'sha': self.qa}, 'merge_commit_sha': '5' * 40, 'mergeable_state': 'clean'}
        if path.startswith('pulls?'):
            return []
        if path.startswith('git/ref/heads/'):
            name = path.split('git/ref/heads/', 1)[1]
            return {'object': {'sha': self.qa if name == 'QA' else self.main if name == 'main' else self.batch['revision']}}
        if path.startswith('git/commits/'):
            return {'tree': {'sha': self.batch['tree']}}
        if path == 'commits/' + self.qa_result:
            return {'commit': {'tree': {'sha': self.batch['tree']}, 'verification': {'verified': True}}, 'parents': [{'sha': self.batch['base']}]}
        if path == 'actions/variables/QA_HOLD':
            return {'value': json.dumps(self.hold)}
        if path.startswith('issues/'):
            return {'labels': []}
        if path.endswith('/check-runs?per_page=100'):
            if path.startswith('commits/' + self.batch['revision'] + '/'):
                return self.checks
            return {'check_runs': [{'id': i, 'name': name, 'status': 'completed', 'conclusion': 'success'} for i, name in enumerate(['Verify', 'Secret scan'])]}
        if path.endswith('/status'):
            return {'statuses': list(self.statuses.values())}
        if path.startswith('actions/workflows/ci.yml/runs?'):
            return {'workflow_runs': [self.run_identity(9)]}
        if path.startswith('actions/workflows/deploy.yml/runs?'):
            return {'workflow_runs': [self.run_identity(11)]}
        if path.startswith('actions/runs/') and path.endswith('/jobs?per_page=100'):
            ident = int(path.split('/')[2])
            names = ['Verify', 'Secret scan', 'Full test suite', 'Build candidate image / Build', 'Deploy QA'] if ident == 9 else ['deploy']
            return {'jobs': [{'name': name, 'status': 'completed', 'conclusion': 'success'} for name in names]}
        if path.startswith('actions/runs/'):
            return self.run_identity(int(path.split('/')[2]))
        if path == 'actions/variables?per_page=100':
            return {'variables': [{'name': name, 'value': value} for name, value in self.vars.items()]}
        if path.startswith('actions/variables/'):
            return {'value': self.vars[path.rsplit('/', 1)[1]]}
        raise ValueError('Unexpected SYNTHETIC GET ' + path)

    def freeze(self, c):
        release.validate(c, effect=False)
        release.guard(c, self.batch['holdId'])
        self.mutations.append({'SYNTHETIC': True, 'method': 'SUPPORTED-CAPTAIN-FREEZE', 'at': int(self.now * 1000)})
        self.hold = {**self.hold, 'id': 'SYNTHETIC-on-hold', 'held': True}
        return self.hold

    def logs(self, ident):
        if ident == 9:
            return json.dumps({'adopted': self.artifact}) + '\n' + json.dumps({'qaDeployment': 'SYNTHETIC', 'source': self.qa}, separators=(',', ':'))
        return self.artifact + '\n' + json.dumps({'deployment': {'source': self.main, 'environmentUnchanged': True, 'previousStopped': True}}, separators=(',', ':'))

    def hosted_readback(self, c, revision):
        return {'command': 'SYNTHETIC-no-SSM-call', 'containers': {name: {'source': revision, 'image': 'SYNTHETIC-image', 'running': True, 'health': 'healthy', 'restarts': 0} for name in ['alido-web', 'alido-worker']}}

    def run(self):
        results = {}
        with patch.object(release, 'api', side_effect=self.api), patch.object(release, 'freeze', side_effect=self.freeze), patch.object(release, 'logs', side_effect=self.logs), patch.object(release.time, 'time', side_effect=lambda: self.now):
            preflight = context(self.batch, 'preflight')
            # This is an explicitly SYNTHETIC success-path input, never actual readiness.
            preflight['readiness'] = {'day': self.batch['day'], 'at': int(self.now * 1000), 'ready': True, 'missing': [], 'SYNTHETIC': True}
            results['preflight'] = release.run(preflight)
            self.set_clock('20:00:10')
            results['qa'] = release.run(context(self.batch, 'qa'))
            if results['qa']['revision'] != self.batch['revision'] or results['qa']['qaRevision'] != self.qa_result:
                raise ValueError('Squash/source handoff failed')
            self.set_clock('20:30:00')
            acceptance = {'day': self.batch['day'], 'revision': self.qa, 'tree': self.batch['tree'], 'artifact': self.artifact,
                          'verdict': self.quality_verdict, 'evidence': 'SYNTHETIC-contract-only; no hosted acceptance proven',
                          'wake': 'SYNTHETIC-quality-wake', 'native': 'SYNTHETIC-native', 'at': int(self.now * 1000), 'qaRun': 9, 'qaAttempt': 2}
            self.set_clock('21:30:10')
            promote = context(self.batch, 'promote', self.qa, self.hold['id'])
            promote['acceptance'] = acceptance
            results['promote'] = release.run(promote)
            self.set_clock('21:40:00')
            readback = context(self.batch, 'readback', self.qa, self.hold['id'])
            readback.update(acceptance=acceptance, executor_source=self.main)
            with patch.object(self.remote, 'api', side_effect=self.api), patch.object(self.remote, 'logs', side_effect=self.logs), patch.object(self.remote, 'production_readback', side_effect=self.hosted_readback), patch.object(self.remote.subprocess, 'check_output', return_value=self.main + '\n'), patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': REPO}):
                results['readback'] = self.remote.run(readback)
        if results['readback']['main'] != self.main_result or results['readback']['tree'] != self.batch['tree']:
            raise ValueError('Protected readback contract failed')
        return {'pass': True, 'SYNTHETIC': True, 'results': results, 'mutations': self.mutations, 'mergeCalls': self.merge_calls}


def rehearse(batch, readiness, live):
    pulls = live.pages('pulls?state=open&base=QA')
    by_number = {p['number']: p for p in pulls}
    missing = [s['number'] for s in batch['sources'] if s['number'] not in by_number or by_number[s['number']]['head']['sha'] != s['head']]
    if missing:
        raise ValueError('Frozen source heads changed or closed: ' + ','.join(map(str, missing)))
    with patch.object(release, 'api', side_effect=live.api):
        release.carrier(context(batch, 'qa'))
    ci = live.source('.github/workflows/ci.yml', batch['revision'])
    for expected in ('Full test suite', 'Build candidate image', 'Deploy QA'):
        if expected not in ci:
            raise ValueError('Real QA workflow contract missing: ' + expected)
    workflow = live.source('.github/workflows/factory-release.yml', batch['revision'])
    if '# factory-release-contract: tree-deadline-v1' not in workflow or 'workflow_dispatch:' not in workflow or 'readback' not in workflow:
        raise ValueError('Real protected readback workflow contract missing')
    remote = live.source('infra/ci/factory_release.py', batch['revision'])
    main = live.api('git/ref/heads/main')['object']['sha']
    for path in ('.github/workflows/release-hold.yml', 'infra/ci/release_hold.py', 'infra/ci/release_control.py', 'infra/ci/release_captain.py'):
        live.source(path, main)
    pull = live.api('pulls/' + str(batch['pr']))
    checks = live.api('commits/' + batch['revision'] + '/check-runs?per_page=100')
    orchestration = SyntheticWindow(batch, pull, checks, remote).run()
    actual_ready = (readiness.get('ready') is True and readiness.get('missing') == []
                    and readiness.get('day') == batch['day'] and isinstance(readiness.get('at'), int)
                    and 0 <= time.time() * 1000 - readiness['at'] <= 15 * 60000)
    source_numbers = {s['number'] for s in batch['sources']}
    return {'pass': actual_ready and orchestration['pass'], 'actualReadinessPass': actual_ready,
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'actualReadiness': readiness, 'realOpenPRs': len(pulls), 'sourceChanges': len(batch['sources']),
            'excludedPRs': [{'number': p['number'], 'title': p['title']} for p in pulls if p['number'] not in source_numbers and p['number'] != batch['pr']],
            'overlappingPaths': len(batch['overlaps']), 'liveGETs': len(live.receipts), 'liveMutations': 0,
            'awsStarts': 0, 'modelCalls': 0, 'mailAlerts': 0, 'orchestration': orchestration,
            'cannotProve': ['actual protected merge authorization', 'future check/billing/credential state', 'AWS OIDC/IAM and native resource admission', 'full combined database suite and immutable build', 'hosted feature acceptance and timely genuine Quality ACCEPT', 'Production source/health/configuration/rollback and readback', 'two consecutive live nights']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', type=Path, required=True)
    parser.add_argument('--readiness', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    live = LiveReads()
    try:
        reading = json.loads(args.readiness.read_text())
        readiness = reading.get('readiness', reading)
        summary = rehearse(json.loads(args.batch.read_text()), readiness, live)
    except Exception as error:
        summary = {'pass': False, 'failure': type(error).__name__ + ': ' + str(error), 'liveGETs': len(live.receipts), 'liveMutations': 0, 'awsStarts': 0, 'modelCalls': 0, 'mailAlerts': 0}
    for name, value in [('live-reads.json', live.receipts), ('summary.json', summary)]:
        with open(args.output / name, 'x') as stream:
            os.chmod(stream.name, 0o600)
            json.dump(value, stream, indent=2)
    print(json.dumps({k: v for k, v in summary.items() if k not in ('actualReadiness', 'orchestration', 'excludedPRs')}))
    return 0 if summary['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
