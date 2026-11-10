# Synthetic approved issue

Use exactly one `runs:cloud` or `runs:local` label, `state:ready`, `kind:fix` and `area:demo` label in an enrolled repository. After reviewing the block, use the owner-token command `bun scripts/control.ts approve-intake example/demo 1 OWNER-RECEIPT`. This applies a protected `ready:<digest>` label alongside `state:ready`; GitHub triage+ label authority and a matching block digest are both required. Editing the block invalidates approval; review and reapprove the new block. Free text alone cannot launch work.

```factory
{
  "owner": "builder",
  "runs": "cloud",
  "execution": {"computerControl": false, "browser": false, "signIn": false, "aws": false, "localDatabase": false, "closeCollaboration": false},
  "creator": "synthetic-owner",
  "source": "fixture:demo-1",
  "outcome": "Correct the synthetic total in src/total.ts",
  "test": "bun test tests/total.test.ts",
  "approved": true,
  "benefit": "normal",
  "estimateSeconds": 600,
  "estimateTokens": 5000,
  "paths": ["src/total.ts", "tests/total.test.ts"],
  "spansBackendAndScreen": false,
  "heavy": false,
  "wallet": "other",
  "costCents": 0,
  "provider": "codex"
}
```

A retry retains the original ticket claim and estimate. An uncertain start needs custody reconciliation; changing the issue title or posting a duplicate event cannot launch it again.

Review the full outcome and proof with [execution routing](../docs/operations.md#execution-routing). All six declarations false defaults to cloud; any true declaration requires local.
