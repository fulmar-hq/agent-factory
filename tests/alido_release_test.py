"""Offline behavior proof for trusted launcher orchestration; fictional inputs."""
import datetime
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from zoneinfo import ZoneInfo
spec = importlib.util.spec_from_file_location('alido_release', Path(__file__).resolve().parents[1] / 'scripts/alido-release.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


def epoch(clock):
    return datetime.datetime.fromisoformat('2026-11-09T' + clock).replace(tzinfo=ZoneInfo('America/Toronto')).timestamp()


def context(step='qa'):
    c = {'day': '2026-11-09', 'step': step, 'revision': 'a' * 40, 'tree': 'b' * 40,
         'hold_id': 'fictional-on', 'deadline': int(epoch('21:20' if step == 'qa' else '19:50' if step == 'preflight' else '22:00') * 1000)}
    c['key'] = hashlib.sha256(json.dumps([c['day'], c['step'], c['revision'], c['tree']], separators=(',', ':')).encode()).hexdigest()
    return c


class TrustedRelease(unittest.TestCase):
    def test_late_effects_never_dispatch_and_frozen_tree_cannot_change(self):
        c = context()
        f.validate(c, epoch('20:00:59'))
        for clock in ['19:59:59', '20:01:00']:
            with self.assertRaises(ValueError):
                f.validate(c, epoch(clock))
        f.validate(context('promote'), epoch('21:45'), effect=False)
        with self.assertRaises(ValueError):
            f.validate(context('promote'), epoch('21:45'))
        c['tree'] = 'c' * 40
        with self.assertRaises(ValueError):
            f.validate(c, epoch('20:00'))
        with patch.object(f, 'api') as api, patch.object(f.time, 'time', return_value=epoch('20:02')):
            with self.assertRaises(ValueError):
                f.run(c)
            api.assert_not_called()

    def test_quality_rejection_and_late_or_mismatched_acceptance_refuse(self):
        c = context('promote')
        c['acceptance'] = {'day': c['day'], 'revision': c['revision'], 'tree': c['tree'], 'verdict': 'ACCEPT', 'artifact': 'repo@sha256:' + 'd' * 64,
                           'evidence': 'fictional-proof', 'wake': 'fictional-wake', 'native': 'fictional-native', 'at': int(epoch('21:19') * 1000)}
        f.accepted(c)
        for key, value in [('tree', 'c' * 40), ('verdict', 'REJECT'), ('at', int(epoch('21:21') * 1000)), ('native', '')]:
            with self.assertRaises(ValueError):
                f.accepted({**c, 'acceptance': {**c['acceptance'], key: value}})

    def test_failed_check_is_terminal_without_retries(self):
        c = context()
        with patch.object(f, 'api', side_effect=[{'workflow_runs': [{'id': 7, 'status': 'completed'}]}, {'jobs': [{'name': 'Full test suite', 'status': 'completed', 'conclusion': 'failure'}]}]) as api, patch.object(f.time, 'time', return_value=epoch('20:20')):
            with self.assertRaisesRegex(RuntimeError, 'failed/skipped'):
                f.workflow(c, 'ci.yml', c['revision'], ['Full test suite'])
            self.assertEqual(api.call_count, 2)

    def test_authority_payload_has_only_release_identity_not_private_evidence(self):
        c = {**context('promote'), 'acceptance': {'evidence': 'private-review-pointer', 'native': 'private-native-id'}}
        with patch.object(f, 'api') as api:
            f.publish_authority(c, 'production', {'artifact': 'registry@sha256:' + 'd' * 64, 'qaRun': 7, 'qaAttempt': 2, 'acceptedAt': int(epoch('21:19') * 1000), 'verdict': 'ACCEPT'})
        body = api.call_args.args[2]
        encoded = body['target_url'].split('#factory=')[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        self.assertEqual(payload['tree'], c['tree'])
        self.assertNotIn('acceptance', payload)
        self.assertNotIn('private-', json.dumps(body))

    def test_native_push_handle_excludes_newer_preflight_and_rejects_other_attempt(self):
        c = context()
        run = {'id': 7, 'head_sha': c['revision'], 'event': 'push', 'path': '.github/workflows/ci.yml', 'run_attempt': 2, 'status': 'completed'}
        jobs = {'jobs': [{'name': 'Deploy QA', 'status': 'completed', 'conclusion': 'success'}]}
        with patch.object(f.time, 'time', return_value=epoch('20:20')), patch.object(f, 'api', side_effect=[run, jobs]) as api:
            self.assertEqual(f.workflow(c, 'ci.yml', c['revision'], ['Deploy QA'], 7, 2)['id'], 7)
            self.assertEqual(api.call_args_list[0].args[0], 'actions/runs/7')
        with patch.object(f.time, 'time', return_value=epoch('20:20')), patch.object(f, 'api', return_value=run):
            with self.assertRaisesRegex(RuntimeError, 'attempt'):
                f.workflow(c, 'ci.yml', c['revision'], ['Deploy QA'], 7, 3)

    def readiness_rows(self, host='running', database='available', ping='Online'):
        return [{'Account': '329195319812'},
                {'Reservations': [{'Instances': [{'InstanceId': 'i-07ecd4144f6823c7a', 'State': {'Name': host}}]}]},
                {'DBInstances': [{'DBInstanceIdentifier': 'alido-production-db', 'DBInstanceStatus': database}]},
                {'InstanceInformationList': [] if ping is None else [{'InstanceId': 'i-07ecd4144f6823c7a', 'PingStatus': ping}]}]

    def test_cold_production_waits_for_exact_host_database_and_ssm_without_writes(self):
        c = context('promote')
        rows = self.readiness_rows('stopped', 'starting', None) + self.readiness_rows('running', 'available', 'ConnectionLost') + self.readiness_rows()
        with patch.object(f, 'production_readiness_json', side_effect=rows) as read, patch.object(f.time, 'time', return_value=epoch('21:35')), patch.object(f.time, 'sleep') as sleep, patch.object(f, 'journal') as journal:
            proof = f.production_readiness(c)
        self.assertEqual(proof['ready'], True)
        self.assertEqual(proof['ssm'], 'Online')
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(read.call_count, 12)
        self.assertEqual([call.args[2] for call in read.call_args_list[:4]], ['get-caller-identity', 'describe-instances', 'describe-db-instances', 'describe-instance-information'])
        self.assertEqual(journal.call_count, 3)

    def test_production_readiness_refuses_foreign_or_ambiguous_metadata(self):
        for index, value in [(0, {'Account': '000000000000'}), (1, {'Reservations': []}),
                             (1, {'Reservations': [{'Instances': [{'InstanceId': 'wrong-host'}]}]}),
                             (2, {'DBInstances': []}), (3, {'InstanceInformationList': [{'InstanceId': 'wrong-host', 'PingStatus': 'Online'}]})]:
            rows = self.readiness_rows(); rows[index] = value
            with patch.object(f, 'production_readiness_json', side_effect=rows), patch.object(f.time, 'time', return_value=epoch('21:35')), patch.object(f.time, 'sleep') as sleep:
                with self.assertRaises(ValueError):
                    f.production_readiness(context('promote'))
                sleep.assert_not_called()

    def test_readiness_deadline_is_unchanged_and_never_renews_credentials(self):
        c = context('promote')
        with patch.object(f.time, 'time', return_value=epoch('22:00')), patch.object(f.subprocess, 'run') as execute:
            with self.assertRaises(TimeoutError):
                f.production_readiness(c)
            execute.assert_not_called()
        with patch.object(f.time, 'time', return_value=epoch('21:59:58')), patch.object(f.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{"Account":"329195319812"}')) as execute:
            self.assertEqual(f.production_readiness_json(c, 'sts', 'get-caller-identity')['Account'], '329195319812')
            self.assertEqual(execute.call_args.args[0], ['aws', 'sts', 'get-caller-identity', '--profile', 'fulmar-production', '--region', 'ca-central-1', '--output', 'json'])
            self.assertEqual(execute.call_args.kwargs['timeout'], 2)
            with self.assertRaises(ValueError):
                f.production_readiness_json(c, 'ec2', 'start-instances')
            self.assertEqual(execute.call_count, 1)
        with patch.object(f.time, 'time', return_value=epoch('21:35')), patch.object(f.subprocess, 'run', return_value=SimpleNamespace(returncode=255, stdout='')) as execute:
            with self.assertRaisesRegex(RuntimeError, 'read failed'):
                f.production_readiness_json(c, 'sts', 'get-caller-identity')
            self.assertEqual(execute.call_count, 1)

    def test_promotion_checks_precede_readiness_and_readiness_precedes_main_merge(self):
        c = context('promote'); artifact = 'repo@sha256:' + 'd' * 64
        c['acceptance'] = {'day': c['day'], 'revision': c['revision'], 'tree': c['tree'], 'verdict': 'ACCEPT', 'artifact': artifact,
                           'evidence': 'fictional-proof', 'wake': 'fictional-wake', 'native': 'fictional-native', 'at': int(epoch('21:19') * 1000), 'qaRun': 7, 'qaAttempt': 2}
        order = []
        def api(path, method='GET', body=None):
            if path.startswith('pulls?'): return []
            if path == 'pulls' and method == 'POST': return {'number': 8}
            if path == 'pulls/8': return {'head': {'sha': c['revision']}, 'merge_commit_sha': 'c' * 40, 'mergeable_state': 'clean'}
            if path.startswith('commits/'):
                self.assertEqual(path, 'commits/' + c['revision'] + '/check-runs?per_page=100')
                order.append('checks'); return {'total_count': 2, 'check_runs': [{'id': i, 'name': n, 'head_sha': c['revision'], 'app': {'slug': 'github-actions'}, 'status': 'completed', 'conclusion': 'success'} for i, n in enumerate(['Verify', 'Secret scan'])]}
            if path == 'pulls/8/merge' and method == 'PUT': order.append('main-merge'); return {'merged': True, 'sha': 'e' * 40}
            raise AssertionError(path)
        def ready(_): order.append('readiness'); return {'ready': True, 'evidence': 'fictional metadata, not deployment'}
        with patch.object(f.time, 'time', return_value=epoch('21:30')), patch.object(f, 'branch', return_value=c['revision']), patch.object(f, 'tree', return_value=c['tree']), patch.object(f, 'hold', return_value={'id': c['hold_id'], 'held': True}), patch.object(f, 'api', side_effect=api), patch.object(f, 'workflow', return_value={'id': 7}), patch.object(f, 'logs', return_value=artifact), patch.object(f, 'variable'), patch.object(f, 'publish_authority'), patch.object(f, 'production_readiness', side_effect=ready):
            result = f.run(c)
        self.assertEqual(order, ['checks', 'readiness', 'main-merge'])
        self.assertEqual(result['productionReadiness']['ready'], True)

    def test_native_logs_select_deploy_job_and_exclude_full_suite_fixture_receipts(self):
        jobs = {'jobs': [
            {'id': 12, 'name': 'Full test suite', 'status': 'completed', 'conclusion': 'success'},
            {'id': 13, 'name': 'Deploy QA', 'status': 'completed', 'conclusion': 'success'}]}
        with patch.object(f, 'api', return_value=jobs), patch.object(f.subprocess, 'run', return_value=SimpleNamespace(stdout='native deployment log')) as execute:
            self.assertEqual(f.logs(7, 'Deploy QA'), 'native deployment log')
            self.assertEqual(execute.call_args.args[0], ['gh', 'run', 'view', '7', '--repo', f.REPO, '--log', '--job', '13'])
        with patch.object(f, 'api', return_value={'jobs': [jobs['jobs'][1], jobs['jobs'][1]]}), patch.object(f.subprocess, 'run') as execute:
            with self.assertRaisesRegex(RuntimeError, 'Unique successful'):
                f.logs(7, 'Deploy QA')
            execute.assert_not_called()

    def test_successful_deploy_job_waits_for_terminal_run_before_log_read(self):
        c = context()
        run = {'id': 7, 'status': 'in_progress'}
        jobs = {'jobs': [{'name': 'Deploy QA', 'status': 'completed', 'conclusion': 'success'}]}
        with patch.object(f, 'api', side_effect=[{'workflow_runs': [run]}, jobs,
                {'workflow_runs': [{**run, 'status': 'completed'}]}, jobs]), \
                patch.object(f.time, 'time', return_value=epoch('20:20')), patch.object(f.time, 'sleep') as sleep:
            self.assertEqual(f.workflow(c, 'ci.yml', c['revision'], ['Deploy QA'])['status'], 'completed')
            sleep.assert_called_once_with(5)

    def test_only_explicit_factory_record_bootstraps_and_reads_back(self):
        with patch.object(f, 'api', side_effect=[{'variables': []}, None, {'value': 'fictional'}]) as api:
            self.assertIsNone(f.variable('ALIDO_FACTORY_RELEASE', 'fictional'))
            self.assertEqual(api.call_args_list[1].args[1], 'POST')
        with patch.object(f, 'api', return_value={'variables': []}) as api:
            with self.assertRaises(ValueError):
                f.variable('ALIDO_QA_BATCH_SHA', 'fictional')
            self.assertEqual(api.call_count, 1)


if __name__ == '__main__':
    unittest.main()
