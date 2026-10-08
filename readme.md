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
| Take profit | +200% gross P&L / initial margin |
| Intended stop | −100% gross P&L / initial margin |
| Positions | One at a time; existing positions may carry into the next day |
| Re-entry | Five-minute cooldown after closing |
| Taker fees | 0.05% of notional on each fill; assumed, not account-tier verified |
| Slippage | 0.01% adverse on each fill; assumed |
| Funding | Historical Binance funding rates; mark open approximates settlement price |
| Minimum notional | 100 USDT; assumed paper eligibility threshold |
| Maintenance margin | 0.40% of marked notional; approximation, not live tier lookup |

These numeric assumptions are public in
[`engine.mjs`](supabase/functions/rigged-tick/engine.mjs). Each run stores its
configuration, so an engine update does not silently change an existing run's rules.
Entry distance and cooldown are explicit simulation parameters that can be reviewed
and adjusted through versioned changes.

## How it runs

1. Supabase Cron invokes `rigged-tick` every minute, independently of visitors.
2. The Edge Function uses CCXT 4.5.0 to obtain completed futures trade candles,
   mark-price candles, and historical funding rates. No Binance API key is needed.
3. The engine advances in chronological order, saving state, trades, and equity
   together through an atomic compare-and-swap database function.
4. GitHub Pages serves `web/`. It polls public Supabase records every 15 seconds.

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
python -m http.server 8080 --directory web
node --test tests/engine.test.mjs
node --check web/app.js
```

Open `http://localhost:8080`. The browser's public URL and publishable key are in
`web/config.js`. These identify a read-only public Supabase connection. Never put
a service-role key, access token, or Binance trading key in that file.

## Deployment

The Supabase migrations create only `rigged_*` objects. All public tables use RLS,
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
[GitHub Pages deployment](https://docs.github.com/en/get-started/start-your-journey/deploying-your-website-automatically).
