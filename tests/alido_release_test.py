"""Offline behavior proof for trusted launcher orchestration; fictional inputs."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
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
