#!/usr/bin/env bun
import {root} from '../launcher/config';
import {refreshBilling} from '../adapters/billing-refresh';

export const billingRefreshHelp = `Read-only billing acquisition (default off).
For Coordinator after Release merge; parent #133 owns qualified live readback:
Run from the installed checkout, with the existing FACTORY_PRIVATE_DIR.
Schedule this exact one-shot command every six hours (no scheduler is installed here):
  FACTORY_BILLING_REFRESH=1 bun --no-env-file scripts/refresh-billing.ts --due
Undo: replace the scheduled command with this disabled invocation, then remove its schedule:
  FACTORY_BILLING_REFRESH=0 bun --no-env-file scripts/refresh-billing.ts --due
Existing release-billing-source.json supplies account/profile/budget; config.yaml is read only.
billing-refresh.json schedules attempts; it never refreshes source observation time.
Errors retain previous readings and record an error, never zero or synthetic success.
A retained billing-refresh.lock or running state refuses overlap/retry. Coordinator
must reconcile the prior process and archive both custody and running metadata before retry.
Retain billing-refresh-attempt-*.json and staged files. No wallet stop is cleared.
No activation, AWS qualification or installed acceptance is implied by source tests.`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(billingRefreshHelp);
  else if (args.length !== 1 || args[0] !== '--due') {
    console.error('Usage: bun --no-env-file scripts/refresh-billing.ts --due|--help');
    process.exitCode = 1;
  } else {
    const result = await refreshBilling(root, {enabled: process.env.FACTORY_BILLING_REFRESH === '1'});
    console.log(JSON.stringify(result));
    if (result.status === 'error' || result.status === 'busy' || result.lastAttemptStatus === 'error') process.exitCode = 1;
  }
}
