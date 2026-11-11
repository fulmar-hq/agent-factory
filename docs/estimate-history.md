# Estimate history

Completion time orders retained history and direct forecasting inputs. IDs, start time, features and measured dimensions make ties deterministic without mutating caller data. Imported rows participate in neither training nor held-out eligibility; they cannot promote the recent-five forecast. This reconciles the overlapping proposals #50 and #59.

A ticket-level completion receipt belongs to an attempt only when exactly one successful retained attempt matches its counters and time. Archived successes also need the original finished-status receipt. Ambiguous or malformed evidence stays excluded; corrupt unrelated archive JSON cannot discard independent valid history. Predictions retain their existing version, thresholds and evidence-only confidence.
