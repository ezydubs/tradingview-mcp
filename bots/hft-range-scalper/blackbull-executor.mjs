/**
 * blackbull-executor.mjs — direct HTTP client for the BlackBull cTrader order
 * backend (blackbull.tv.ctrader.com), documented in
 * docs/BLACKBULL_CTRADER_ORDER_API.md.
 *
 * AUTH: the backend requires a ~71-char, ROTATING OAuth access token held in
 * the broker connection's OAuth2 provider closure. It is captured fresh from
 * the live TradingView page over CDP via a fetch interceptor (see the doc's
 * "Authentication & token acquisition"). `window.user.auth_token` does NOT
 * work — using it yields `Authorization fail.`.
 *
 * This token works from DIRECT Node fetch (no page-context requirement), so
 * this client issues raw HTTP:
 *   - POST   /accounts/{id}/orders?locale=en&requestId=<id>   -> open order
 *   - GET    /accounts/{id}/positions?locale=en               -> list positions
 *   - DELETE /accounts/{id}/positions/{id}?locale=en          -> close position
 *
 * Safety: demo account only (guarded in index.mjs). Never touches live
 * accounts.
 */
import CDP from 'chrome-remote-interface';

const HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const BBC = 'https://blackbull.tv.ctrader.com';

/**
 * CDP-backed provider that captures the live rotating Bearer token from the
 * TradingView page by hooking window.fetch and triggering a broker call.
 */
export class CdpTokenProvider {
  constructor() { this.client = null; this._hooked = null; }

  async _connect() {
    if (this.client) {
      try { await this.client.Runtime.evaluate({ expression: '1', returnByValue: true }); }
      catch (e) { this.client = null; }
    }
    if (!this.client) {
      this.client = await CDP({ host: HOST, port: PORT });
      await this.client.Runtime.enable();
    }
    return this.client;
  }

  async _eval(expression) {
    const c = await this._connect();
    const { result, exceptionDetails } = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error('page eval error');
    return result && result.value;
  }

  /** Trigger a broker call so the fetch hook records a fresh auth header. */
  async _trigger() {
    await this._eval(`(async function(){
      window.__hdrArr = [];
      var origF = window.fetch;
      if (!window.__hookedBB) {
        window.__hookedBB = true;
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
      try { if (ab && ab.ordersHistory) await ab.ordersHistory(); } catch(e){}
      await new Promise(function(r){ setTimeout(r, 1500); });
      return {};
    })()`);
  }

  /** Warm up: eagerly capture a token so the first trade doesn't have to. */
  async warm() {
    await this.getToken();
  }

  /** Return a fresh bearer token (without the "Bearer " prefix). */
  async getToken() {
    let lastErr = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await this._trigger();
        const r = await this._eval(`(function(){
          var arr = window.__hdrArr || [];
          var tok = null;
          for (var i = arr.length - 1; i >= 0; i--){
            var h = arr[i].hdrs;
            for (var k in h){ if (/authorization/i.test(k)){ var v = String(h[k]); if (v.indexOf('Bearer ') !== -1 && v.length < 200){ tok = v.slice(7); break; } } }
            if (tok) break;
          }
          return { token: tok };
        })()`);
        const t = r && r.token;
        if (t) return t;
        lastErr = new Error('empty token capture');
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('token provider: no BlackBull bearer captured after retries (is TradingView logged in + BlackBull connected on port ' + PORT + '?)' + (lastErr ? ': ' + lastErr.message : ''));
  }
}

export class BlackBullClient {
  constructor({ accountId }) {
    this.accountId = accountId;
    this.tokens = new CdpTokenProvider();
    this._mutex = Promise.resolve();
    this._cachedToken = null;
  }

  /**
   * Token caching: the blackbull OAuth token is stable for tens of seconds
   * (20+ sequential calls succeed with one capture), so re-capture only on a
   * fresh capture or when the server rejects it with `Authorization fail.`.
   * Avoids a slow CDP round-trip on every HTTP call.
   */
  async _getToken() {
    if (!this._cachedToken) this._cachedToken = await this.tokens.getToken();
    return this._cachedToken;
  }

  _invalidateToken() {
    this._cachedToken = null;
  }

  /** Eagerly capture a token at startup so the first trade needs no capture. */
  async warm() {
    await this._getToken();
    return this._cachedToken;
  }

  async _doCall(method, path, form) {
    const token = await this._getToken();
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BBC}/accounts/${this.accountId}${path}${sep}locale=en`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (!json) throw new Error(`BlackBull ${method} ${path} HTTP ${res.status} (non-json)`);
    if (!json.s || json.s !== 'ok') {
      const err = new Error(`BlackBull error: ${json.errmsg || json.error || 'unknown'}`);
      err.body = json;
      throw err;
    }
    return json.d;
  }

  /** Auth-fail-aware call: on a rejected token, re-capture once and retry. */
  async _call(method, path, form) {
    try {
      return await this._doCall(method, path, form);
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/Authorization fail/i.test(msg)) {
        this._invalidateToken();
        return await this._doCall(method, path, form);
      }
      throw e;
    }
  }

  /** Serialize mutations; a single-position bot must never double-submit. */
  _serialized(fn) {
    const run = this._mutex.then(
      () => fn().then((v) => ({ v }), (e) => ({ e })),
      (e) => ({ e })
    );
    this._mutex = run.then(() => undefined, () => undefined);
    return run.then((r) => (r.e ? Promise.reject(r.e) : r.v));
  }

  /**
   * Open a market order. Resolves to the created order/position info.
   * currentAsk/currentBid required by the backend (values ignored for pricing).
   */
  openMarket({ side, qty, takeProfit, stopLoss }) {
    return this._serialized(async () => {
      const p = new URLSearchParams();
      p.set('side', String(side).toLowerCase());
      p.set('type', 'market');
      p.set('instrument', 'BTCUSD');
      p.set('qty', String(qty));
      p.set('currentBid', '1');
      p.set('currentAsk', '2');
      if (takeProfit != null) p.set('takeProfit', String(takeProfit));
      if (stopLoss != null) p.set('stopLoss', String(stopLoss));
      const d = await this._call('POST', '/orders', p.toString());
      return { orderId: d && d.orderId, ...(d && typeof d === 'object' ? d : {}) };
    });
  }

  /** List open positions. Returns raw array [{id, instrument, qty, side, avgPrice}]. */
  listPositions() {
    return this._serialized(async () => {
      const d = await this._call('GET', '/positions');
      return Array.isArray(d) ? d : [];
    });
  }

  /** Close a position by id (full or partial qty). */
  closePosition(positionId, qty) {
    return this._serialized(async () => {
      const p = new URLSearchParams();
      if (qty != null) p.set('qty', String(qty));
      const form = p.toString();
      const d = await this._call('DELETE', `/positions/${positionId}`, form || undefined);
      return { closed: true, ...(d && typeof d === 'object' ? d : {}) };
    });
  }
}
