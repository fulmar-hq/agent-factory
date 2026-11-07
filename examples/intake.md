# Synthetic approved issue

Use exactly one `state:ready`, `kind:fix` and `area:demo` label in an enrolled repository. Repository permission to approve Ready is the intake authority; free text alone cannot launch work.

```factory
{
  "owner": "builder",
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
