# Continued training: 500 additional PPO updates

Training resumed from `initial-v1/latest.pt` with the same optimizer, dataset,
features, rewards, 120x leverage and hard strategy constraints. There were no
additional downloads and no changes to the deployed paper worker.

- Additional updates: 500; total updates: 540.
- Additional decisions: 512,000; total decisions: 552,960.
- Completed training episodes in this continuation: 21,151.
- Each episode resets the account to 100 USDT; episodes reuse the training dates.
- Policy and value-network weights changed; both saved checkpoints reload.

## Validation outcome

Across the 14 July–September 2025 validation blocks, the selected policy again
took zero trades and kept 100 USDT in every block. The final update also produced
zero validation trades. No checkpoint improved on the starting validation score,
so `best.pt` retains the resumed update-40 model; `latest.pt` preserves update 540.
More optimization did not establish profitable trading behavior.

The already inspected October–December 2025 test was **not run again**. The new
`--validation-only` option skips both test evaluations and leaves their report
fields null. These continuation results are development observations, not a new
independent test of profitability.

## Fixed-rule diagnostic

For context, the unchanged strategy was replayed on consecutive blocks of the
training and validation dates, with each block starting at 100 USDT:

| Fixed strategy | Training dates | Validation dates |
| --- | ---: | ---: |
| Blocks | 79 | 14 |
| Mean final equity | 92.75 | 95.65 |
| Profitable blocks | 18 | 3 |
| Trades | 399 | 61 |

This supports a possible explanation for the learned preference to wait: the
encoded setups lose on average after modeled costs. It does not establish that
every setup loses, that selective profitable trading is impossible, or that
undocumented discretionary decisions are reproduced. No participation reward
was added to make an inactive policy appear profitable.

## Local artifacts and reproduction

Outputs remain Git-ignored in `training/runs/continued-v1/`: `latest.pt`,
`best.pt`, `policy.json`, `metrics.jsonl`, `report.json`, and the additional
`fixed_strategy_diagnostics.json`. Original data and initial outputs are retained.
The dataset SHA-256 and chronological splits remain those in
[the initial report](INITIAL_RESULTS.md).

```powershell
python -m training.train --resume training/runs/initial-v1/latest.pt --updates 500 --rollout 1024 --validation-only --output training/runs/continued-v1
```

Use a new output directory when reproducing an already completed run.
