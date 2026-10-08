# Initial experiment: fixed 120x leverage

The initial PPO run completed 40 updates, 40,960 decision samples, and 1,697
completed training episodes. Each account began with 100 USDT. Checkpoint 10
was selected using validation dates only. This is a small initial run, not a
validated profitable trading system.

The validation-selected policy took no trades in the final test. Under these
encoded rules and modeled costs, it learned to wait. Do not interpret capital
preservation through zero exposure as profitable trading expertise.

| October–December 2025 test | Learned policy | Fixed strategy | Cash |
| --- | ---: | ---: | ---: |
| Episodes | 14 | 14 | 14 |
| Starting equity per episode | 100.00 | 100.00 | 100.00 |
| Mean final equity | 100.00 | 88.96 | 100.00 |
| Median final equity | 100.00 | 89.97 | 100.00 |
| Minimum final equity | 100.00 | 78.04 | 100.00 |
| Profitable episodes | 0 | 0 | 0 |
| Trades | 0 | 77 | 0 |
| Worst episode drawdown | 0.00% | 24.88% | 0.00% |
| Total modeled fees across episodes | 0.00 | 85.72 | 0.00 |

Each test block is at most seven days and resets to 100 USDT, including the
shorter final block. These values are not one continuously compounded quarter.
The fixed comparison is the precise published version-3 implementation and its
assumptions, not a reconstruction of undocumented discretionary decisions.

## Reproduction and saved artifacts

- Seed: 42; PPO settings and train/validation/test dates: [training guide](README.md).
- Dataset: 1,052,640 continuous one-minute observations and 2,193 funding events.
- Archives: 72 SHA-256-verified Binance ZIPs, 66.78 MiB total.
- Two missing August 2024 mark candles: recovered from Binance public REST,
  with source records in local `data/repairs/mark-2024-08.json`.
- Prepared dataset SHA-256:
  `82b3d624f76b52067b2df65dd8e986043ba3352dd7a6a2cf2203052aed799b43`.
- Initial successful output directory: `training/runs/initial-v1/`.
- `best.pt` preserves the selected model; `latest.pt` preserves all 40 updates
  and optimizer state for continuation. `policy.json` exports the selected weights.
- `report.json` includes every validation/test episode; `metrics.jsonl` includes
  every update. Data and model artifacts remain local and are ignored by Git.

Both the selected and latest checkpoints were successfully reloaded. The live
Supabase paper worker was not switched to this policy. Test results must not be
used to tune subsequent experiments while continuing to call those dates unseen.
