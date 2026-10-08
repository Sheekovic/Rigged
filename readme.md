# RIGGED

**The $100 BTC futures paper experiment. Every outcome stays in the record.**

Dashboard: [sheekovic.github.io/Rigged](https://sheekovic.github.io/Rigged/)

RIGGED observes BTC/USDT's midnight-to-noon UTC range, then simulates longs near
the low and shorts near the high. It starts with 100 USDT and compounds trade
allocation from the current balance. It sends **no actual trading orders**.

## Published rules

| Rule | Value |
| --- | --- |
| Market | Binance USDⓈ-M BTC/USDT perpetual futures |
| Starting capital | 100 USDT |
| Margin mode | Cross; the full paper balance backs the position |
| Allocation | 10% of current balance as initial margin |
| Leverage | 120× |
| Observation | 00:00–12:00 UTC; all 720 completed minute candles required |
| Entries | 12:00–24:00 UTC, inside the fixed observed range |
| Near an extreme | Within 0.10% of its price; provisional configurable assumption |
| Fibonacci anchors | Current UTC day's lowest and highest wicks on completed 1-hour candles, ordered by their candle times |
| Fibonacci entry filter | Trade with the swing direction, inside the 61.8–100% retracement zone, while also satisfying the 12-hour range entry |
| Take profit | Nearer 38.2% recovery level or +200% gross P&L / initial margin |
| Intended stop | Nearer swing invalidation (0.10% beyond its starting extreme) or −100% gross P&L / initial margin |
| Positions | One at a time; existing positions may carry into the next day |
| Daily entry limit | At most 6 new positions per UTC day; no minimum forced |
| Re-entry | Five-minute cooldown after closing |
| Taker fees | 0.05% of notional on each fill; assumed, not account-tier verified |
| Slippage | 0.01% adverse on each fill; assumed |
| Funding | Historical Binance funding rates; mark open approximates settlement price |
| Minimum notional | 100 USDT; assumed paper eligibility threshold |
| Maintenance margin | 0.40% of marked notional; approximation, not live tier lookup |

These numeric assumptions are public in
[`engine.mjs`](supabase/functions/rigged-tick/engine.mjs). Each run stores its
configuration. Explicit rule changes are applied through versioned migrations;
an engine deployment alone does not silently change an existing run's configuration.
Entry distance and cooldown are explicit simulation parameters that can be reviewed
and adjusted through versioned changes.

## How it runs

1. Supabase Cron invokes `rigged-tick` every minute, independently of visitors.
2. The Edge Function uses CCXT 4.5.0 to obtain completed futures trade candles,
   mark-price candles, and historical funding rates. No Binance API key is needed.
3. The engine advances in chronological order, saving state, trades, and equity
   together through an atomic compare-and-swap database function.
4. GitHub Pages serves `web/`. It polls public Supabase records every 15 seconds.
5. The custom canvas chart displays real hourly candles, volume, a crosshair, and
   Fibonacci levels. Binance's public futures WebSocket streams update the forming
   hourly candle and trade price. If the stream is unavailable, the chart explicitly
   labels the CCXT snapshot saved by Supabase each minute. The chart supports drag,
   zoom, keyboard controls, day view, and fullscreen.

The black-and-gold pixel interface uses an original, locally generated bitmap-outline
font. Neither the chart nor the font needs a third-party library or a remote font service.

## Fibonacci model (version 3)

Fibonacci retracement measures the portion of a price move that has been retraced.
This model selects the current UTC day's lowest and highest wicks from completed
hourly candles. Earlier low then later high is an upward swing; earlier high then
later low is a downward swing. If both extrema are in the same hourly candle, their
order is unknown and no setup is accepted. It uses a linear price scale.

The displayed levels are 0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, and 100%, measured
back from the swing endpoint. New entries require a retracement into the 61.8–100%
zone, consistent with the swing direction, and proximity to the fixed 12-hour range
extreme. Fibonacci has no universal entry/exit rules; these are explicit simulation
choices, not a safety guarantee.

Each new position freezes its anchors, target, and stop. Recovery to 38.2% can take
profit before the +200% margin ROI ceiling. Crossing 0.10% beyond the initial swing
extreme can close a loss before the −100% ceiling. Gaps can still exceed these limits.
Re-entry requires closing first, waiting five minutes, and a fresh qualifying signal;
it consumes another daily entry. There is no averaging into an open position.

Version 3 is recorded as a timestamped change in run state; the account and past
results are preserved. The trade ledger and CSV identify each trade's strategy
version and the database retains its Fibonacci anchors. Existing positions from
earlier versions retain their original ROI exits. Results spanning a rule change
must not be described as a single unchanged strategy.

On startup, earlier candles from the current UTC day warm up the observed range.
They never create retrospective trades. Paper trading begins with the next full
minute after startup. Restarting the worker resumes the saved run rather than
resetting its balance. Duplicate scheduler requests cannot commit duplicate trades.
After downtime, batches of up to 500 candles catch up on subsequent invocations.
Missing or malformed candles halt advancement instead of being skipped.

The experiment has no fixed end date. It depends on Supabase availability, exchange
access, platform quotas, and storage capacity. An account below the minimum trade
size stops entering positions; a depleted account is not topped up automatically.

## What the results mean

This is an ongoing **forward paper test** using public market data and simulated
positions. Positive and negative outcomes are saved equally.

Fills are simulated using one-minute candles. Entries occur at candle close;
exits begin with the next bar. When profit and stop thresholds both occur in a bar,
the adverse outcome wins. Gaps can produce losses beyond the intended stop.
Liquidation uses mark prices and an assumed maintenance rate. If a bar also breaches
that threshold, this conservative model wipes the cross balance before considering
the stop. It cannot reconstruct the actual intrabar order or Binance liquidation
fees, margin tiers, and partial liquidations. Cross margin can expose more than the
10% allocation.

Displayed net P&L includes modeled fees, slippage, and funding. Unrealized equity
uses the mark close; drawdown is based on minute-end equity samples, so intraminute
drawdown can be larger. The dashboard displays the latest 720 equity samples and
200 trades. Its CSV exports those displayed trades; the database retains the full
ledger. An administrator can modify database records, so this is a transparent
record, not a tamper-proof audit or a promise of future returns.

## Local preview and checks

No frontend build or npm install is required.

```powershell
Copy-Item supabase/functions/rigged-tick/fibonacci.mjs web/fibonacci.mjs
python -m http.server 8080 --directory web
node --test tests/*.test.mjs
node --check web/app.js
node --check web/market-chart.mjs
```

The Pages workflow copies the same Fibonacci calculation module used by the worker
into the static site. To regenerate the original pixel font, run
`python scripts/make-pixel-font.py`; this uses only the Python standard library.

Open `http://localhost:8080`. The browser's public URL and publishable key are in
`web/config.js`. These identify a read-only public Supabase connection. Never put
a service-role key, access token, or Binance trading key in that file.

## Deployment

The Supabase migrations create only `rigged_*` objects (plus scheduler extensions).
`rigged_candles` preserves hourly OHLCV market data independently of equity samples.
All public tables use RLS,
with read access for visitors and writes restricted to the service role. The
scheduler token is randomly generated in Supabase Vault and is never committed.
The Edge Function gets its service-role credentials from Supabase's server environment.

For a new project, update the URL in the scheduler SQL and `web/config.js`, deploy
the first migration, deploy `rigged-tick`, then apply the scheduler migration.
`verify_jwt = false` is intentional: the function validates its private scheduler
token through a service-role-only RPC before doing any market requests.

GitHub repository **Settings → Pages → Source → GitHub Actions** enables the
included Pages workflow. Pushing `web/` changes to `main` deploys the dashboard.
No private secrets are required for Pages itself. If you later automate Supabase
CLI deployment, put `SUPABASE_ACCESS_TOKEN` in GitHub Actions secrets and the
project ID in repository variables; do not commit credentials.

Reference documentation: [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions),
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[CCXT Binance futures](https://github.com/ccxt/ccxt/wiki/binanceusdm),
[Fibonacci drawing conventions](https://www.tradingview.com/support/solutions/43000518158-fibonacci-retracement-drawing-tool/),
[Binance futures market streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market),
[GitHub Pages deployment](https://docs.github.com/en/get-started/start-your-journey/deploying-your-website-automatically).
