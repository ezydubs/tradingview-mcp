# HFT-Style 1-Range-Bar Scalper (Binance signal → BlackBull exec)

A fast **open-and-force-close** scalper. It streams live Binance BTCUSD trades,
re-bins them into **1-point range bars**, and on each completed bar opens a
position in the bar's direction on the **BlackBull Demo** account, then
**force-closes it as soon as the next bar completes** — so the max holding time
is one range bar (effectively "close very fast").

Execution goes through the BlackBull broker adapter **in the TradingView page
context** over CDP (port 9222). This is the same authenticated path the MCP's
`place_order` / `close_position` tools use.

## Files

| File | Purpose |
|------|---------|
| `binance-feed.mjs` | Binance WS → builds 1-point range bars (emits `bar` events) |
| `blackbull-executor.mjs` | Opens/closes positions via the in-page broker adapter over CDP |
| `index.mjs` | Strategy loop: open on bar, force-close on next bar |
| `fetch-token.mjs` | (legacy) pulls `window.user.auth_token` — **not required** for execution |

## Strategy (default)

- Stream `binance.com:9443` `btcusdt@trade`.
- Accumulate range bars of `rangePts` (default **1** point): a bar closes when
  price moves ≥ `rangePts` from its open, either direction.
- On each completed bar: if a position is open, **force-close it** (hit the
  "close fast" requirement), then **open** `qty` (default **0.005**) in the
  direction the bar closed (up bar → buy, down bar → sell).
- Result: a momentum scalper with a hard one-bar round-trip cap.

## Safety (read before --live)

- **`--dry-run` is the default.** Nothing is submitted until you pass `--live`.
- **Demo only.** The account id is `BB_ACCOUNT` (default `48466618`, the demo
  NZD account). If `BB_ACCOUNT` is one of the two live BlackBull accounts
  (`48466898`, `48475221`) the bot **refuses to start**.
- **Single position.** It never holds more than one position; it force-closes
  before opening the next.
- **Smallest lot (0.005)** and optional `--risk=<nzd>` cap. Real HFT sizing is
  out of scope here — this is a mechanism demo on a paper account.
- Does **not** rely on raw BlackBull HTTP (blocked by auth in this session);
  it reuses the proven CDP broker-adapter path.

## Run

Prerequisites: **TradingView Desktop open + logged in + BlackBull demo connected**
(CDP on port 9222), and an internet connection for Binance.

```bash
# Dry run (recommended first — shows every open/close decision, trades nothing)
node index.mjs --dry-run --qty=0.005 --range=1

# Live (places + closes real demo trades)
BB_ACCOUNT=48466618 node index.mjs --live --qty=0.005 --range=1
```

Options:
- `--dry-run` / `--live` — toggle order submission (default dry-run).
- `--qty=<n>` — per-trade qty (min 0.005, max 100; default 0.005).
- `--range=<n>` — range-bar size in points (default 1).
- `--risk=<nzd>` — NZD risk cap placeholder (default 5).
- `BB_ACCOUNT=<id>` — demo account id (default `48466618`).

Stop with Ctrl-C; the bot attempts to close any open position on shutdown.

## Honest caveats

- This is **not** true low-latency HFT. Round trips are bounded by the CDP
  broker-adapter RTT (~hundreds of ms to ~1s) and bar-completion cadence, not
  exchange colocation.
- The Binance feed is a *signal*; fills and PnL happen on BlackBull demo at the
  broker's own live price. Micro-slippage between the two feeds is expected and
  is not controlled for here.
- Momentum/range-breakout edge is **not** validated; run `--dry-run` long enough
  to log a meaningful sample before going live, and keep size minimal on paper.
- See `docs/BLACKBULL_CTRADER_ORDER_API.md` for the backend validation model and
  quirks (min qty 0.005 vs 0.01 advertised, TIF codes, SL/TP behavior).
