# BlackBull (cTrader) Order API — Validation Surface Discovery

Status: **demo account, authenticated, empirical field fuzzing captured.** Maps the
server-side validation behavior of the BlackBull `tv.ctrader.com` order-submission
REST endpoint that the TradingView Paper-Trading integration talks to. This is
**not** TradingView's native Paper backend (see
[PAPER_TRADING_DISCOVERY.md](PAPER_TRADING_DISCOVERY.md) for the native `Paper`
broker) — it is BlackBull's own cTrader-hosted order API.

## Purpose and scope

Document what the BlackBull order endpoint accepts and rejects, field by field,
so the MCP can (a) model order/tif/enum shapes accurately, and (b) avoid relying
on behaviors that fail server-side. This covers **only** a BlackBull **demo**
account. Live BlackBull accounts are explicitly out of scope and must not be
touched by any probe.

Everything below was produced by direct `POST` to:

```
https://blackbull.tv.ctrader.com/accounts/<ACCOUNT>/orders?locale=en&requestId=<id>
```

with `Content-Type: application/x-www-form-urlencoded` and an
`Authorization: Bearer <token>` header carrying the session token the TradingView
Desktop renderer already holds (`window.<token var>`). Form-encoded camelCase
fields. Responses are JSON with `{"s":"ok","d":{...}}` on success and
`{"s":"error","errmsg":"..."}` on failure.

## Security rules for evidence collection

- **Demo account only.** The two live BlackBull accounts observed in the account
  list are covered by the same rule as all real-money accounts: never submit an
  order, never touch them.
- **Never paste cookies, tokens, authorization headers, or storage contents**
  into this document, issues, or test fixtures. Record *shapes* and *error
  strings* only — never the bearer token or account secrets.
- Recording order IDs / position IDs / demo account ID is acceptable (demo
  material).
- Any full repro that creates positions must close/cancel them afterward so the
  account is left flat (0 positions / 0 active orders).
- The endpoint is an undocumented internal backend; behavior can change with no
  notice. Every finding is a single-session observation unless noted.

## Authentication & token acquisition

The backend requires `Authorization: Bearer <access-token>`. Getting the right
token is the single most important gotcha — it is easy to get an
`{"s":"error","errmsg":"Authorization fail."}`.

### What the token IS and is NOT

- **IS:** a **~71-char, rotating OAuth access token** that the BlackBull broker
  connection (`activeBroker()._brokerConnection`) attaches to every request to
  `blackbull.tv.ctrader.com`. It **rotates** — a token that once passed auth may
  be rejected later (verified: a token that passed one POST was rejected on the
  next after a short delay), so capture it fresh immediately before use.
- **IS NOT** the TradingView web-session JWT at `window.user.auth_token` (that
  is an 846-char JWT that is **rejected** by this backend → `Authorization
  fail.`). The long renderer JWT is unrelated to the BlackBull cTrader OAuth
  token; using it is the #1 cause of the auth error.

The access token lives in a **closure** inside the broker connection's
`_oAuth2AuthorizationProvider` (no public getter), so it cannot be read by
listing object keys. It is exposed in practice only by observing an **actual
authenticated request**.

### How to capture it (fetch interceptor)

The renderer's broker adapter makes real authenticated calls (positions,
ordersHistory, quotes, state) against `blackbull.tv.ctrader.com`. Hook
`window.fetch` to record the `Authorization` header, then **trigger** one of
those calls. Because `tradingview_ui_evaluate` tears down async contexts, run
the trigger and the read as **two separate evaluates**:

1. Install a fetch hook AND trigger a broker call (this persists in the page):

```js
/* evaluate #1 (async — its return is ignored; it sets window.__hdrArr) */
(async function(){
  window.__hdrArr = [];
  var origF = window.fetch;
  if (!window.__hooked) {
    window.__hooked = true;
    window.fetch = function(url, opts){
      try {
        var u = (typeof url === 'string' ? url : (url && url.url) || '');
        if (u.indexOf('blackbull.tv.ctrader.com') !== -1 && opts && opts.headers) {
          var hdrs = (opts.headers instanceof Headers) ? Object.fromEntries(opts.headers.entries()) : opts.headers;
          window.__hdrArr.push({ hdrs: hdrs });
        }
      } catch(e){}
      return origF.apply(this, arguments);
    };
  }
  var t = window.TradingView && window.TradingView.bottomWidgetBar &&
    window.TradingView.bottomWidgetBar._widgetControllers &&
    window.TradingView.bottomWidgetBar._widgetControllers.get('paper_trading') &&
    window.TradingView.bottomWidgetBar._widgetControllers.get('paper_trading')._trading;
  var ab = t && t.activeBroker ? (t.activeBroker.value ? t.activeBroker.value() : t.activeBroker()) : null;
  try { if (ab && ab.positions) await ab.positions(); } catch(e){}
  await new Promise(r => setTimeout(r, 700));
  return {};
})()
```

2. Read the freshest captured token (synchronous evaluate):

```js
(function(){
  var arr = window.__hdrArr || [];
  var tok = null;
  for (var i = arr.length - 1; i >= 0; i--){
    var h = arr[i].hdrs;
    for (var k in h){ if (/authorization/i.test(k)){ var v = String(h[k]); if (v.indexOf('Bearer ') !== -1 && v.length < 200){ tok = v.slice(7); break; } } }
    if (tok) break;
  }
  return { token: tok };
})()
```

Use the returned value verbatim as `Authorization: Bearer <token>` on the raw
HTTP calls. This token works from **direct Node `fetch`** (no page-context
requirement) — the earlier "must run via page XHR" assumption only applied
because the page token used then was the wrong one. Because it rotates, either
re-capture immediately before each batch or fail-and-retry on `Authorization
fail.`.

Observed authenticated endpoints the broker calls (all `Bearer`-auth'd,
`locale=en`):
- `GET /accounts/{id}/ordersHistory?locale=en&...`
- `GET /accounts/{id}/orders?locale=en`
- `GET /accounts/{id}/positions?locale=en` → `{"s":"ok","d":[{id,instrument,qty,side,avgPrice,...}]}`
- `GET /accounts/{id}/state?locale=en`
- `GET /quotes?locale=en&symbols=BTCUSD&accountId={id}`

## Environment record

| Field | Value |
|-------|-------|
| TradingView Desktop version | 3.3.0 (Electron 38.2.2, Chrome 140) |
| Broker | BlackBull Markets (cTrader-hosted) |
| Target account | **Demo** `48466618` (currency NZD) — the only account probed |
| Live accounts seen | `48466898`, `48475221` — **not touched** (live; out of scope) |
| Transport | HTTPS `POST` to `blackbull.tv.ctrader.com/accounts/48466618/orders` |
| Encoding | `application/x-www-form-urlencoded`, camelCase field names |
| Auth | `Authorization: Bearer <access-token>` — a **71-char rotating OAuth access token** held in the broker connection's OAuth2 provider closure (NOT `window.user.auth_token`; see [Authentication & token acquisition](#authentication--token-acquisition)) |
| Probe method | synchronous `XMLHttpRequest` inside `tradingview_ui_evaluate`, or raw Node `fetch` with a freshly captured token (single call runs each request atomically — reliable; async `fetch` loops were abandoned because page navigation tears down the async context) |
| Instrument probed | `BTCUSD` (spot) unless noted |
| Account state | left flat (0 positions / 0 orders) after each fuzz batch |

## Summary of findings (TL;DR)

The backend validates **strict on shape** (known enum values, ≤2 fractional
digits on price, exact instrument names) but has a handful of concrete gaps:

1. **`DurationId.DAY` is not an enum member** → every `durationType=DAY` (and
   the human-readable TradingView TIF names) throws a Spring
   `ConversionFailedException`. See [DurationId / TIF](#durationid--tif).
2. **Sub-minimum order volume accepted down to `0.005`** even though the
   advertised minimum is `0.01`. See [qty / volume](#qty--volume).
3. **Out-of-range SL/TP are silently dropped**, not rejected. See
   [SL/TP validation](#sltp-validation).
4. **Huge `limitPrice` integers are accepted** (0 fractional digits) and become
   *marketable* buy-limits that instant-fill **at the live feed** — they do **not**
   set a better price or move the market. See
   [limitPrice / stopPrice](#limitprice--stopprice).
5. **Quantity internally passes through a 64-bit `long`, scaled ×100** → an
   oversized `qty` saturates/wraps to `92233720368547760.00` (Long.MAX_VALUE ÷
   100) and is rejected as above max. See [qty overflow](#qty--volume).
6. **Advertised-vs-actual TIF mismatch**: UI-documented TIFs (`Day`, `GTDate`,
   `On Close`, `On Auction`) are not recognized by name; only cTrader-native
   codes (`GTC`, `IOC`, `FOK`, `GTD`, `MOO`) work.

None of the findings move the actual market or alter fill price — fills always
come from the server's authoritative live feed (verified empirically).

## Field-by-field evidence

### side (Buy/Sell enum)

Case-insensitive. `buy`, `sell`, `BUY`, `SELL`, `Buy`, `Sell` all accepted.
`""` → `side must not be null` (JSR-303 bean validation). Anything else
(`B`, `S`, `long`, `short`, `0`, `1`, `-1`, `bid`, `ask`, `none`) →
Spring `ConversionFailedException` to the `Side` type (same family as the
`DurationId` error below).

### type (Order type enum)

Recognized values (case-insensitive): `market`, `limit`, `stop`, `stoplimit`
(`stop_limit`, `STOP_LIMIT` normalize to `stoplimit`). Recognized-but-incomplete
orders are rejected with a required-price message:
- `type=limit` without `limitPrice` → `Limit price is required for order type limit`
- `type=stop` without `stopPrice` → `Stop price is required for order type stop`
- `type=stoplimit` without `stopPrice` → `Stop price is required for order type stoplimit`

Unknown/numeric types (`mtl`, `stopmarket`, `cross`, `iceberg`, `0`–`10`, ...) →
`ConversionFailedException`. `""` → `type must not be null`.

### DurationId / TIF

Complete observed enum membership for `durationType` on a `market` order:

| Value | Result |
|-------|--------|
| `GTC`, `GTC+` | accepted (fills) |
| `IOC`, `IOC+` | accepted (fills) |
| `FOK`, `FOK+` | recognized, but `Such TIF is not supported by this Order type` (market) |
| `GTD` | recognized; `DurationDateTime is required for duration GTD` |
| `MOO` | recognized; `Incorrect time of execution` (time-gated) |
| `DAY`, `Day`, `WEEK`, `MONTH`, `GTDate`, `On Close`, `Opening`, `On Auction`, `LOO`, `MOC`, `LOC`, `OCA`, `OCO`, `DAY+`, `IOCN`, `FOKN`, `ON_CLOSE`, `SESSION`, `NONE`, ... | **ENUM_FAIL** — `ConversionFailedException: No enum constant com.xtrader.tva.pojo.DurationId.<X>` |

Note that `DAY` itself is a valid string that is **not a member** of the enum —
the canonical `DurationId.DAY` conversion bug named in the objective.

**Full vendor-table TIF sweep (no new accepted values).** Extended across the
complete TradingView TIF table (ABX/ASX/ATHEX/BIST/B3/CBOE/CFE/CboeFX/CME/
Coinbase/DGCX/Dealerweb/EBSD/EBSM/EEX/EPEX/Eris/eSpeed/Eurex/Euronext/Fenics/
FEX/FMX/FMX_USTF/GFO-X/GSCB/HKEx/ICE/ICE_L/IDEM/JPX/JSE/KCG/Kraken/LME/LME_NTP/
MEFF/MexDer/MIAX_FUT_CH/MIAX_FUT_NY/MX/NASDAQ_NED/Nodal/Nordpool/NZX/SGX/
SGX_GIFT/TAIFEX/TFEX/TFX/WSE), the additional distinct TIF spellings beyond the
basic set were all tested and **all ENUM_FAIL**:
- `Day+`, `GTDate+`, `GTCDate` (Nordpool), `GTTime` (WSE), `GTT` (JSE),
  `GIS` (FEX/TFX), `GFA` (JSE), `On Open`, `On Close – Morning/Afternoon/Evening`
  (JPX), `Book or Cancel` (Eurex/Nodal), `Market On Open` (IDEM).
- The only values accepted were the cTrader-native codes: `GTC`/`GTC+` ✅,
  `IOC`/`IOC+` ✅, `GTD` needs datetime, `FOK`/`FOK+` incompatible on market,
  `MOO` time-gated.

This decisively confirms the **advertised-vs-actual TIF mismatch**: BlackBull's
`DurationId` enum is far narrower than the TIF set any exchange's documentation
implies.

**TIF mismatch with the vendor table.** TradingView documents TIFs like
`Day, FOK, GTC, GTDate, IOC, On Close, Opening, On Auction`. Sending those
canonical names to BlackBull:
- `Day` ❌, `GTDate` ❌, `On Close` ❌, `Opening` ❌, `On Auction` ❌ → all ENUM_FAIL
- `GTC` ✅, `IOC` ✅, `GTD` needs datetime, `FOK` incompatible with market.

So the advertised/`place_order` TIF surface does not match the backend enum.

**`durationDateTime` is Unix seconds, not an ISO string.** Verified:
- `GTD` + `durationDateTime=<epochSeconds>` → accepted (working order w/ expiry).
- `GTD` + `durationDateTime=<epochMillis>` → `Expiration timestamp is too big`.
- `durationDateTime=2026-12-31T00:00:00` (ISO) → `NumberFormatException ... for required type 'long'`.
- Past epoch → `Order expiration time <date> is in a past. Current time is <date>` (leaks server UTC formatting).
- `durationDateTime=0` → treated as null → `DurationDateTime is required`.
- **Negative epoch (e.g. `-1000`) was accepted** for a GTD order — the
  past-time check is bypassed by a negative timestamp (validation gap).

### qty / volume

Backend type is `java.math.BigDecimal` (`CONVERT_FAIL` target for non-numeric,
`2`-decimal display on errors).

- Minimum-volume check is effectively **`qty >= 0.005`**, not `0.01`:
  - `0.0049`, `0.00499` → rejected `Order volume = 0.00 is smaller than minimum allowed volume = 0.01.`
  - `0.005`, `0.0051`, `0.006`, `0.007`, `0.008`, `0.009` … `0.01` → **accepted** (real positions created).
  - The rejected display always rounds the offending volume to `0.00`, masking the true boundary.
- Scientific notation parses: `1e-2` accepted as `0.01`.
- `qty<0` (`-0.01`) → rejected as smaller than min.
- **Max volume**: `100.00`. Larger → `Order volume = <x> is bigger than maximum allowed volume = 100.00.`
- **Long-overflow artifact**: an oversized `qty` saturates to
  `92233720368547760.00` (= `Long.MAX_VALUE / 100` = `9223372036854775807 / 100`),
  i.e. the volume is **scaled ×100 into a 64-bit `long`** internally; values that
  overflow that `long` clamp/wrap to the sentinel and always fail the max check.
  Worst case confirms integer storage but is not exploitable to a negative/valid
  value.
- `NaN`, `Infinity`, `abc`, `1,000`, `1.5.2` → `ConversionFailedException` to `BigDecimal`.
- `""` → `qty must not be null`.

### limitPrice / stopPrice

Backend type is `java.lang.Double` (the `CONVERT_FAIL` target for
`abc` / `1,000` / `1.5.2`).

- **2-fractional-digit rule**: price with >2 decimal places is rejected:
  `Order price = <x> has more digits than symbol allows. Allowed 2 digits`
  (e.g. `79500.555`, `1.111` rejected; `79500.05`, `79500.55` accepted).
- `0` / `-1` → `illegal value of limitPrice (0.0) for LIMIT order` /
  `illegal value of stopPrice (0.0) for STOP order`.
- `NaN` / `Infinity` → `Order price = NaN is not parsable` / `... Inf not parsable`.
- `""` → `Limit price is required for order type limit` / `Stop price is required for order type stop`.
- **Huge integer limitPrice is accepted** (0 fractional digits) and if `>= ask`
  for a buy (or `<= bid` for a sell) becomes an instantly marketable order that
  fills at the live feed. The value is stored as a precision-truncated `Double`
  past ~15-16 significant digits, e.g.:
  - `99999999999999999999` (20 digits) stored as `1.590897978359415E22`,
    displayed **`15,908,979,783,594.15`** → order `27984053`, filled at `79,679.33`.
  - `999999999999999999999999999999999` (33 digits) stored as `6.87...e21`,
    displayed `6,873,995,514,006.73` → order `27984055`, filled at `79,671.50`.
  Verified to **instant-fill at the real market**, not at the sent price.

### instrument

Exact, case-sensitive match against the symbol table:
- `BTCUSD`, `XAUUSD` accepted (per-instrument minimum volume applies; XAUUSD min = 0.10).
- `ETHUSD` is a known symbol but rejected at `qty=0.01` (min 0.10) — not a bad symbol.
- `EURUSD`, `1` → `Trading is disabled` (recognized but trading disabled in this demo).
- Unknown / wrong-case / suffixed (`btcusd`, `BTC/USD`, `US100`, `NASDAQ:AAPL`,
  `BTCUSD,ETHUSD`, trailing space, embedded NUL) → `Not found instrument <x>`.

### SL/TP (brackets)

- Wrong-**side** values rejected: on a buy, `takeProfit` below market or
  `stopLoss` above market → `SL/TP have to be positive`.
- **Invalid magnitudes are silently dropped, not rejected**: a market order with
  `stopLoss=-5` or `takeProfit=NaN` is **accepted** (`"s":"ok"`), and the resulting
  position carries `stop_loss:null, take_profit:null`. No error, no bracket.
- A valid-but-way-above-market TP (`takeProfit=99999`) is accepted and materialized
  as a **bracket order** (e.g. `TP_<id>_1`) normalized to a sensible price.
- `takeProfit=abc` → `ConversionFailedException` to `Double`. `""` coerced to none (accepted).

#### NaN / ±Infinity across fields

Cross-field sweep of `NaN`, `Infinity`, `-Infinity` (reliability: 1 session):

| Field | NaN | Infinity | -Infinity |
|-------|-----|----------|-----------|
| `qty` | CONVERT_FAIL (`BigDecimal`) | CONVERT_FAIL | CONVERT_FAIL |
| `limitPrice` / `stopPrice` / `takeProfit`(Inf) / `stopLoss`(Inf) | `Order price = NaN is not parsable` | `Order price = ... not parsable` | `takeProfit: -Infinity` **accepted** |
| `durationDateTime` | CONVERT_FAIL (`long`) | CONVERT_FAIL | (n/a) |
| `currentAsk` / `currentBid` | **accepted** | **accepted** | **accepted** |

Key points:
- `takeProfit=-Infinity` **accepted** → position shows `take_profit:null` (same silent-sl/drop as `NaN`/`-5`).
- `currentAsk`/`currentBid` accept `NaN`/`±Infinity` with no error and **fills still price at the real live market** (e.g. a buy with `currentAsk=-Infinity` filled `79434.28`). This independently confirms the quote fields are never used for pricing.

### Misc / extra fields

The endpoint tolerates unknown/extra form fields (`unknownField`, `__proto__`,
`positionId`, `clientOrderId`, `label`, `comment` incl. 300 chars, booleans
`guaranteedStop`, `guaranteedTakeProfit`, `trailingStop`) — they are **accepted
and ignored** (no strict reject, no injection/SQLi observed). `comment`/`label`
accepted and stored.

### Order-type × TIF compatibility matrix

The earlier `FOK → "Such TIF is not supported by this Order type"` is **specific
to `market`**. Testing each recognized TIF against each non-market type
(valid non-marketable prices so the only variable is TIF/type compatibility):

| type → TIF | GTC | IOC | FOK | GTD | MOO | DAY |
|-----------|-----|-----|-----|-----|-----|-----|
| `market`   | ok | ok | TYPE_INCOMPAT | needs-datetime | time-gated | ENUM_FAIL |
| `limit`    | ok | ok | **ok** | ok | TYPE_INCOMPAT | ENUM_FAIL |
| `stop`     | ok | ok | **ok** | ok | TYPE_INCOMPAT | ENUM_FAIL |
| `stoplimit`| ok | ok | **ok** | ok | TYPE_INCOMPAT | ENUM_FAIL |

- `FOK` works on `limit`/`stop`/`stoplimit` — only `market` rejects it.
- `MOO` (market-on-open) is incompatible with every non-market type (and
  time-gated on market).
- `DAY` → ENUM_FAIL uniformly (the `DurationId.DAY` bug is type-independent).
- Though `FOK`/`GTD` are "accepted" on working limits, the accepted `limit`-type
  orders were still returned as `status: working` — the FOK fill-or-kill
  semantics were not strictly honored server-side (orders stayed pending).

### OrderType enum membership (exhaustive)

`OrderType` has exactly **4 members**, case-insensitive: `market`, `limit`,
`stop`, `stoplimit` (`stop_limit`/`STOP_LIMIT` normalize to `stoplimit`). Every
other candidate from the exchange table — `market with protection`,
`market-limit`/`market to limit`/`MTL`, `limit (post only)`, `limit if touched`,
`stop market`, `stop market to limit`, `minimum quantity/volume`/`minvol`,
`iceberg`, `cross`, `basket`, `OCO`/`ocoo`, `book or cancel`, `market on open`,
numeric indices `0`–`15`, `-1`, `null` — all **CONVERT_FAIL** (no numeric
enum-index mapping either). Empty string → generic reject.

### Modify (`PUT /accounts/{acc}/orders/{id}`) & cancel (`DELETE .../orders/{id}`)

Separate REST endpoints; `POST /orders` ignores `orderId`/`command` (a
`command=MODIFY` POST is treated as a NEW order). `PATCH` → 405. `PUT` shares the
`DurationId`/`BigDecimal`/price-parsing bugs with POST:

- `instrument` and `qty` are hard-required on `PUT` (`'X' must not be null`).
- Omitting an amendable field that matches current state → `Nothing to amend.`
  (server diffs against the existing order).
- `limitPrice` omitted → treated as `0.0` → `illegal value of limitPrice (0.0)`.
- **`DAY` modify → identical `ConversionFailedException ... DurationId`** — the
  enum bug is present on the modify path too.
- `limitPrice=NaN` / `-Infinity` / `-5` → `illegal value of limitPrice (0.0)`
  (nan/-inf/neg all coerced to 0.0 → illegal). `Infinity` → `Order price = Infinity
  is not parsable`. Huge integer `99999999999` → **ok** (same as POST).
- `qty=Infinity` → `BigDecimal` CONVERT (same as POST). **But `qty=-1`, `0`,
  `0.001` are ACCEPTED (`"s":"ok"`)** on modify — the modify path does **not**
  enforce the POST-side min/positive qty validation; a literal negative is not
  persisted (subsequent qty change → `Nothing to amend.`), so it appears to
  normalize rather than store.
- `type→market` modify is **ok** (a working limit can be converted to a
  marketable order that fills).
- `DELETE .../orders/{id}` → `{"s":"ok"}` is the cancel endpoint.

## Reproduced live

These were the cleanest live reproductions, each captured as its own atomic
request and each followed by closing/cancelling the created state:

| Finding | Reproduced result |
|---------|-------------------|
| Wrong token rejected | `Authorization: Bearer <window.user.auth_token>` (846-char JWT) → `{"s":"error","errmsg":"Authorization fail."}` on every POST, even from in-page sync-XHR |
| Correct token via interceptor | Captured ~71-char OAuth token from a live broker `positions()` call; used with **direct Node `fetch`** POST `side=sell&type=market&instrument=BTCUSD&qty=0.005&currentBid=1&currentAsk=2` → `{"s":"ok","d":{"orderId":"28075483"}}` (filled, position created) |
| Backend non-null requirement | First POST without `currentAsk`/`currentBid` → `currentAsk, currentBid must not be null`; adding them (values ignored for pricing) parses OK |
| Read + close positions via HTTP | `GET /accounts/{id}/positions?locale=en` → `{"s":"ok","d":[{id,instrument,qty,side,avgPrice,...}]}`; `DELETE /accounts/{id}/positions/{pid}?locale=en` (body `qty=0.01`) → `{"s":"ok"}` (position closed, account left flat) |
| Close without `locale` | `DELETE /positions/{pid}` (no `?locale=en`) → `{"s":"error","errmsg":"Required parameter 'locale' is missing"}` |
| `DurationId.DAY` bug | `'durationType' Failed to convert ... No enum constant com.xtrader.tva.pojo.DurationId.DAY` |
| Sub-min qty `0.005` | `{"s":"ok",...}` created a 0.005 position on a market sell |
| 2-digit price rule | `Order price = 79500.555 has more digits than symbol allows. Allowed 2 digits` |
| GTD epoch-seconds | seconds accepted; ISO string → `NumberFormatException ... required type 'long'` |
| Silent SL/TP drop | `stopLoss=-5,takeProfit=NaN` → `"s":"ok"` but position `stop_loss:null, take_profit:null` |
| TIF mismatch | `Day/GTDate/On Close/On Auction` ENUM_FAIL; `GTC/GTC+/IOC/IOC+/GTD/FOK/MOO` recognized |
| qty overflow | huge qty → `Order volume = 92233720368547760.00 is bigger than maximum allowed volume = 100.00.` |
| Huge marketable limit | `limitPrice=999999999999999999999999999999999` accepted; instant-filled at live feed (`orderId 27985138` → fill `79452.31`), NOT at the sent price |
| "15 trillion" display | `limitPrice=99999999999999999999` accepted → stored `1.59...e22` displayed `15,908,979,783,594.15`, instant-filled at live feed (`orderId 27984053` → fill `79,679.33`) |
| Price-bound (no magnitude cap) | buy-limits at `1,100,1000,50000,79000` stay `working`; at `79400,79500,80000,90000,100000,100000000,99999999999,1e9,1e12` → all ACCEPT and instant-fill **at live feed ~79380** (not sent price). `-1`/`0` → `illegal value`; `0.0001` → `more digits than symbol allows`; `99999999999999` (≈1e14) → **`price is equal or below zero`** (sign overflow) |
| Position-modify accepts -SL | `PUT /positions/{id}` with `stopLoss=-5` → `{"s":"ok"}` (not persisted); wrong-side TP → `New TP for BUY position should be >= current BID price. current BID: 79399.8, TP: 70000.0` |

**Market-impact check (no price inflation).** 12 consecutive marketable buy-limits
(`limitPrice` absurdly high, qty 0.01) filled at `79428.50`–`79432.53` with **no
upward creep**; the price-bound sweep extended this across `1e9`/`1e12`/`1e11`
limits, all filling at `~79380` — fills are pegged to the server's authoritative
live feed and the client-supplied `currentAsk`/`currentBid` are ignored for
pricing. If a fake-quote buy (`currentAsk=100/currentBid=90`) and a real-quote buy
are both placed, they fill at the same real market price. Therefore none of this
can move or inflate the market, nor achieve a better-than-market fill.

## Runtime evidence — stable facts

- Order endpoint is `blackbull.tv.ctrader.com` (BlackBull's cTrader-hosted
  TradingView integration), accounts via `/accounts/<id>/orders`.
- `currentAsk` / `currentBid` are accepted but **not trusted for fill pricing**
  (server prices fills from its own feed).
- The working bearer is a **~71-char rotating OAuth access token** from the
  broker connection's OAuth2 provider closure, captured via a fetch interceptor
  (see [Authentication & token acquisition](#authentication--token-acquisition)).
  `window.user.auth_token` (846-char JWT) is **rejected** by this backend.
- The token works from **direct Node `fetch`**, not just in-page XHR, and
  re-validates every field server-side (it is not merely client-side).
- Reuse across many rapid requests is fine; orders that fill create positions,
  orders that don't fill (limit below market) become `working` orders.

## Evidence tables (reliability: single demo session unless noted)

| Capability / field | Behavior | API/backend | Reliability | Notes |
|--------------------|----------|-------------|-------------|-------|
| `durationType` enum | cTrader-native codes only | `DurationId` | 1 session | `DAY` not a member → ConversionFailedException |
| `side` enum | case-insensitive buy/sell | `Side` | 1 session | human names (`long`/`short`) fail |
| `type` enum | market/limit/stop/stoplimit | `OrderType` | 1 session | numeric/other fail |
| `durationDateTime` | Unix **seconds** (`long`) | field type `long` | 1 session | ISO/ms fail; negative accepted (gap) |
| `qty` min | effective `0.005` vs advertised `0.01` | `BigDecimal` | 1 session | sub-min accepted (gap) |
| `qty` max / overflow | max `100.00`; Long-scaled ×100 sentinel `92233720368547760.00` | `long` scale | 1 session | not exploitable |
| `limitPrice`/`stopPrice` | ≤2 fractional digits; `Double` | price validation | 1 session | huge-integer marketable (no price impact) |
| `instrument` | exact case-sensitive symbol | symbol table | 1 session | per-instrument min volume; some `Trading is disabled` |
| SL/TP | wrong-side rejected; bad magnitudes **silently dropped** | bracket validation | 1 session | gap: no reject for -5/NaN |
| Unknown/extra fields | accepted and ignored | none | 1 session | no injection observed |
| Fill pricing | server feed always | matching engine | 1 session | client ask/bid ignored; no inflation |

## Order throughput & the open-position cap

Smallest usable unit is `qty=0.005` (server quantizes qty to 2dp, so `0.0049`
rounds to `0.00` → `smaller than minimum allowed volume = 0.01`; `0.005`+ passes).

**No per-second rate limit.** Throughput scales with client concurrency
(measured from an external parallel HTTP client, node `fetch` + `Promise.all`,
against the same account/token):

**Market orders** (each fills → opens a position, so capped by the ~2,000-position
wall):

| Concurrency | Burst | Accepted | Errors | Rate |
|------------|-------|----------|--------|------|
| 1 (serial sync-XHR in page) | 30 | 30/30 | 0 | ~1.3/s (client-bound, ~750ms RTT) |
| 20 | 50 | 50/50 | 0 | ~22/s |
| 50 | 200 | 200/200 | 0 | ~57/s |
| 100 | 500 | 500/500 | 0 | ~133/s |
| 200 | 1000 | 1000/1000 | 0 | ~230/s |
| 1000 | 2000 | 1993/2000 | 7 net | **~42/s (degraded)** |

- **Concurrency 200 is the sweet spot for market orders (~230/s).** Pushing to
  C=1000 *degrades* performance (42/s + `fetch failed`) — too many parallel TCP
  connections churn/reset the keep-alive pool rather than adding throughput. The
  server's effective per-session concurrency wall is ~200-250 connections.
- No 429/throttle responses anywhere; margin is **not** the binding constraint.

**Working limit orders** (non-margin, no position cap) reveal the true raw
request ceiling:

| Concurrency | Burst | Accepted | Errors | Rate |
|------------|-------|----------|--------|------|
| 100 | 1000 | 1000/1000 | 0 | ~202/s |
| 200 | 1000 | 1000/1000 | 0 | ~255/s |
| 400 | 1000 | 1000/1000 | 0 | ~509/s |
| 500 | 1000 | 1000/1000 | 0 | **~695/s** |

→ **Raw placement ceiling ≈ 700 orders/sec** (C≈400–500). No meaningful
working-order-count cap observed (1,200+ concurrent working limits accepted).

**Hard per-trader open-position cap ≈ 2,000.** Pushing beyond ~2,000 concurrent
positions (e.g. a 3,000-order burst at C=300) is rejected with
`Open positions limit exceeded for trader with id 141501`. This is the real ceiling
on "how many open positions at once". The 2,000-position cap is reached well before
any throughput limit, so for max *placement velocity* use non-fill working limits.

**Open/close cycle, timed:** 1,999 × `qty=0.005` sell market orders opened at
C=250 in **14.9s (~135/s)**; the same positions closed via `DELETE /positions/{id}`
(form `qty`) at C=300 in **38.7s (~52/s)** with 0 errors after re-trying 2 transient
network failures. The close path (`DELETE /positions/{id}`) is more serialized
server-side than the order-create path.

## Known risks and unknowns

- **Demo account only.** Behavior on live BlackBull (different pricing, TIF
  support, size limits) is unverified and deliberately untested.
- The backend is an undocumented internal API; any BlackBull/cTrader change can
  break or change these behaviors.
- Only BTCUSD (and one XAUUSD order) exercised; per-instrument minimum volume /
  min lot step differences are mostly unmapped.
- `FOK`/`MOO` were combined with non-market types (FOK ok on limit/stop/stoplimit,
  MOO incompatible) but `LOC`/`OCA`/`OCO` pairings were not exhaustively exercised.
- Trailing-stop and guaranteed-stop booleans were accepted but not confirmed to
  take effect on the created position.

## What happens next

- Model the BlackBull `DurationId` → MCP `tif` mapping so the adapter translates
  UI TIFs (`DAY` etc.) into the accepted cTrader codes rather than sending values
  the backend rejects.
- Optionally surface per-instrument minimum/maximum volume so the MCP can reject
  `qty < 0.01` client-side instead of relying on the backend's lax `0.005` check.
- Keep all probes confined to the demo account; never send an order to the live
  accounts.
