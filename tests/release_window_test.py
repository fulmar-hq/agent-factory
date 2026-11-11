"""Provider-free regression for the exact release runner's carrier transition."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rehearsal', Path(__file__).resolve().parents[1] / 'scripts/rehearse-window.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

# The live command loads the actual protected source after verifying its Git
# blob. Offline tests inject a tiny remote port; hosted behavior is not proven.
REMOTE_PORT = '''
import subprocess, time
def api(*args): raise AssertionError('unbound remote port')
def logs(*args): raise AssertionError('unbound log port')
def production_readback(*args): raise AssertionError('unbound hosted port')
def run(c):
    main=api('git/ref/heads/main')['object']['sha']
    return {'main':main,'tree':c['tree'],'revision':c['revision'],
            'readback':production_readback(c,main),'status':'success'}
'''


def fixture():
    batch = {'version': 1, 'day': '2026-11-12', 'base': 'a' * 40, 'revision': 'b' * 40, 'tree': 'c' * 40,
             'pr': 7, 'ref': 'fix/fictional-carrier', 'holdId': 'fictional-off',
             'sources': [{'number': 1, 'head': 'd' * 40, 'ref': 'fix/fictional-source', 'title': 'Fictional source'}],
             'overlaps': [], 'review': 'fictional independent source review'}
    digest = hashlib.sha256(json.dumps(batch, separators=(',', ':')).encode()).hexdigest()
    pull = {'number': 7, 'state': 'open', 'draft': False,
            'head': {'sha': batch['revision'], 'ref': batch['ref'], 'repo': {'full_name': w.REPO}},
            'base': {'sha': batch['base'], 'ref': 'QA', 'repo': {'full_name': w.REPO}},
            'mergeable': True, 'mergeable_state': 'clean', 'body': 'factory-batch-sha256:' + digest}
    checks = {'total_count': 3, 'check_runs': [{'id': i, 'name': name, 'head_sha': batch['revision'],
              'app': {'slug': 'github-actions'}, 'status': 'completed', 'conclusion': 'success'}
              for i, name in enumerate(['Verify', 'Secret scan', 'Release hold'])]}
    return w.SyntheticWindow(batch, pull, checks, REMOTE_PORT)


class ReleaseWindow(unittest.TestCase):
    def test_actual_runner_preserves_key_across_squash_and_completes_window_contract(self):
        port = fixture()
        result = port.run()
        self.assertTrue(result['pass'])
        self.assertTrue(result['SYNTHETIC'])
        self.assertEqual(result['mergeCalls'], 1)
        self.assertEqual(result['results']['qa']['revision'], port.batch['revision'])
        self.assertEqual(result['results']['qa']['qaRevision'], port.qa_result)
        self.assertEqual(result['results']['promote']['main'], port.main_result)
        self.assertEqual(result['results']['readback']['revision'], port.qa_result)
        writes = result['mutations']
        self.assertTrue(all(item['SYNTHETIC'] for item in writes))
        self.assertEqual([item['body']['merge_method'] for item in writes if item.get('path', '').endswith('/merge')], ['squash', 'squash'])
        self.assertGreater(next(item['at'] for item in writes if item['method'] == 'SUPPORTED-CAPTAIN-FREEZE'), w.epoch(port.batch['day'], '20:01:00') * 1000)

    def test_failed_latest_check_never_merges_even_with_older_success(self):
        port = fixture()
        bad = copy.deepcopy(port.checks['check_runs'][0])
        bad.update(id=10, conclusion='failure')
        port.checks['check_runs'].append(bad)
        port.checks['total_count'] += 1
        with self.assertRaisesRegex(ValueError, 'Exact carrier check failed'):
            port.run()
        self.assertEqual(port.mutations, [])

    def test_hold_change_between_carrier_read_and_write_never_merges(self):
        port = fixture()
        port.set_clock('20:00:10')
        original = port.api
        def changed(path, method='GET', body=None):
            result = original(path, method, body)
            if path.endswith('/check-runs?per_page=100'):
                port.hold['id'] = 'changed-epoch'
            return result
        with patch.object(w.release, 'api', side_effect=changed), patch.object(w.release.time, 'time', side_effect=lambda: port.now):
            with self.assertRaisesRegex(ValueError, 'admission changed'):
                w.release.merge_carrier(w.context(port.batch, 'qa'))
        self.assertEqual(port.mutations, [])

    def test_late_admission_has_zero_mutations(self):
        port = fixture()
        port.set_clock('20:01:00')
        with patch.object(w.release, 'api', side_effect=port.api), patch.object(w.release.time, 'time', side_effect=lambda: port.now):
            with self.assertRaisesRegex(ValueError, 'Outside fixed'):
                w.release.run(w.context(port.batch, 'qa'))
        self.assertEqual(port.mutations, [])

    def test_unknown_merge_result_stops_with_one_retained_intent(self):
        port = fixture()
        port.uncertain_merge = True
        with self.assertRaisesRegex(RuntimeError, 'lost merge response'):
            port.run()
        self.assertEqual(port.merge_calls, 1)
        self.assertEqual(len(port.mutations), 1)
        self.assertEqual(port.mutations[0]['method'], 'PUT')
        # The runner does not retry; persisted executor custody owns recovery.

    def test_live_adapter_refuses_every_non_get_operation_before_subprocess(self):
        live = w.LiveReads()
        with patch.object(w.subprocess, 'run') as external:
            with self.assertRaisesRegex(ValueError, 'GET only'):
                live.api('pulls/7/merge', 'PUT', {'sha': 'a' * 40})
            external.assert_not_called()

    def test_rejected_quality_never_creates_or_merges_a_promotion(self):
        port = fixture()
        port.quality_verdict = 'REJECT'
        with self.assertRaisesRegex(ValueError, 'Quality ACCEPT'):
            port.run()
        self.assertFalse(any(item.get('path') in ('pulls', 'pulls/10/merge') for item in port.mutations))


if __name__ == '__main__':
    unittest.main()
