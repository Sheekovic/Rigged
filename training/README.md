# Historical policy training

This is an actual PyTorch neural policy trained with proximal policy optimization
(PPO). It runs offline and never sends trading orders. Each seven-day episode
starts with **100 USDT**; the account resets, while the policy weights persist.
It is an initial research experiment, not evidence of future profitability.

## Fixed rules and learned decisions

The simulator retains 120x leverage, cross margin, 10% allocation, the full
00:00–12:00 UTC observation, range-edge plus completed-hour Fibonacci eligibility,
one position at a time, five-minute re-entry cooldown, and at most six entries
per UTC day. No minimum number of trades is forced. Positions can carry overnight.

The policy has five actions: wait; enter with a 0.05%, 0.10%, or 0.20% Fibonacci
invalidation buffer; or close an existing position. An action mask prevents
invalid entries and simultaneous positions. All entry variants keep the original
nearer Fibonacci / +200% or −100% margin-ROI exits. A new entry after an exit
must satisfy the rules again. There is no averaging into an open position.

The model receives 18 market features plus nine account/position features:
past returns, trailing volatility and volume, range and Fibonacci distances,
swing direction, UTC time, mark-price basis, candle shape, balance/equity,
position ROI, daily count, holding time, stop/target distances, and drawdown.
Only information available at the current candle close is supplied.

The actor and critic share two 128-unit tanh layers. PPO uses clipped updates,
masked categorical actions, a value baseline and generalized advantage estimation.
The reward is the change in log equity minus 0.2 times any increase in maximum
drawdown. Future equity is never supplied as an input. The episodic discount is
1, avoiding a time-discount bias when flat periods skip to the next eligible setup.
Risk checks still process every minute while a position is open.

## Data and evaluation

The downloader obtains 2024–2025 Binance public BTCUSDT USD-M perpetual
one-minute trade candles, mark-price candles, and funding archives. Every ZIP is
verified against its published SHA-256 checksum. Preparation rejects malformed
OHLC, non-finite values, gaps, duplicate minutes, and trade/mark misalignment.
Funding is mapped to its settlement minute; mark open approximates settlement price.
The August 2024 mark archive omits two minutes. These exact candles are recovered
from Binance's public `markPriceKlines` REST endpoint, with URLs, response hashes
and raw candle values preserved in `data/repairs/`. Missing prices are never
interpolated. Unrecoverable gaps fail preparation.

| Purpose | UTC dates |
| --- | --- |
| Training | 2024-01-01 through 2025-06-30 |
| Validation / checkpoint selection | 2025-07-01 through 2025-09-30 |
| Final test | 2025-10-01 through 2025-12-31 |

Training samples random seven-day episodes entirely inside the training dates.
Validation and test use consecutive, nonoverlapping seven-day blocks, with a
shorter final block. Every block starts with 100 USDT and positions are closed
at the block end with modeled slippage and fees. Held-out features may use earlier
market history, as would be available live; held-out outcomes never enter training.

Every five updates, validation chooses the checkpoint by mean log final equity
minus a drawdown penalty. The final test compares that checkpoint with the
unchanged strategy and a 100-USDT cash baseline on identical dates and blocks.
Read every episode and drawdown in the report, not just a profitable average.
Once test results have been inspected, do not tune against those dates: use
a fresh, untouched period for claims about a revised experiment.

## Run locally

Requires Python, NumPy, pandas, and PyTorch. The initial run uses the already
installed CPU versions; no pretrained model or extra package is downloaded.

```powershell
python -m training.download --years 2024 2025
python -m training.download --download --years 2024 2025
python -m unittest training.test_training -v
python -m training.train --updates 40 --rollout 1024 --output training/runs/initial
```

The first command inspects archive sizes. The second downloads and prepares the
dataset, reusing verified archives after an interrupted download. Downloading
new years or dependencies should be a deliberate choice.

To continue training the learned weights, use a new output directory:

```powershell
python -m training.train --resume training/runs/initial/latest.pt --updates 40 --rollout 1024 --output training/runs/continued
```

Resume restores the policy and optimizer, requires the same data hash, splits,
rules, and rollout size, and starts fresh episodes. It does not reproduce an
interrupted trajectory byte for byte. More updates alone do not establish skill.

Outputs are local and ignored by Git:

- `data/archives/`: original checksummed archives.
- `data/btc-usdt-1m.npy`, `dataset.json`: aligned dataset and provenance.
- `runs/<name>/latest.pt`: latest policy, optimizer and training state.
- `runs/<name>/best.pt`: checkpoint selected on validation only.
- `runs/<name>/metrics.jsonl`: per-update losses and validation metrics.
- `runs/<name>/report.json`: complete validation/test episodes and comparisons.
- `runs/<name>/policy.json`: portable weights and architecture; inference also
  requires identical feature calculation and hard action masks.

Keep these files to preserve data and learning across restarts. Nothing uploads
them to Supabase automatically. The deployed dashboard continues its separately
saved forward paper experiment; trained policies require evaluation before any
separate paper deployment.

## Execution limits

The historical environment matches the deployed engine's fixed-strategy fills,
fees and funding in long/short parity tests. Other tests cover future-data leakage,
single-position and entry limits, account resets, stop-before-profit ordering,
liquidation and real neural-weight updates.

The assumed 0.05% taker fee, 0.01% slippage and 0.40% maintenance margin are
approximations. One-minute OHLC cannot recover intrabar order, so liquidation
is resolved before stops and stops before profit. Cross liquidation can wipe the
whole account. Minute-close drawdown omits intraminute excursions. The simulator
does not model actual historical margin tiers, partial liquidation, liquidity,
latency, outages or changes in exchange rules. A neural policy can learn to wait
if the available setups do not reward trading after costs.

Sources: [Binance public data](https://github.com/binance/binance-public-data),
[PPO paper](https://arxiv.org/abs/1707.06347),
[GAE paper](https://arxiv.org/abs/1506.02438).
