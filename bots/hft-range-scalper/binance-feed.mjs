/**
 * binance-feed.mjs — connect to Binance public WebSocket, accumulate a live
 * trade tick stream, and rebuild a price series as *range bars* of a fixed
 * size (default 1 point, i.e. price moves exactly `rangePts` per bar).
 *
 * A range bar closes when price moves `rangePts` away from its open, in EITHER
 * direction. It has no fixed time; each completed bar is an opportunity to
 * trade ("open on range completion, close fast").
 *
 * Emits RangeBar objects to subscribers:
 *   { open, high, low, close, up: boolean, time: ms }
 */
import WebSocket from 'ws';

const SYMBOL = process.env.BB_SYMBOL || 'btcusdt';

export class RangeBarFeed extends EventTarget {
  constructor({ rangePts = 1, symbol = 'btcusdt' } = {}) {
    super();
    this.rangePts = rangePts;
    this.symbol = symbol;
    this.ws = null;
    this.bar = null;
    this.bars = [];
    this._tickCount = 0;
  }

  start() {
    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@trade`;
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.dispatchEvent(new Event('open'));
    });
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg && typeof msg.p === 'string') {
        this._onTick(parseFloat(msg.p));
      }
    });
    this.ws.on('error', (e) => this.dispatchEvent(new CustomEvent('error', { detail: e })));
    this.ws.on('close', () => this.dispatchEvent(new Event('close')));
  }

  _onTick(price) {
    this._tickCount++;
    if (!this.bar) {
      this.bar = { open: price, high: price, low: price, close: price, up: null, time: Date.now() };
      return;
    }
    const b = this.bar;
    if (price > b.high) b.high = price;
    if (price < b.low) b.low = price;
    b.close = price;
    // A range bar closes when it has moved `rangePts` from its open in one dir.
    if (price - b.open >= this.rangePts) { this._closeBar(true); return; }
    if (b.open - price >= this.rangePts) { this._closeBar(false); return; }
  }

  _closeBar(up) {
    const closed = this.bar;
    closed.up = up;
    this.bars.push(closed);
    if (this.bars.length > 5000) this.bars.shift();
    this.dispatchEvent(new CustomEvent('bar', { detail: closed }));
    // start next bar from the closing price
    this.bar = { open: closed.close, high: closed.close, low: closed.close, close: closed.close, up: null, time: Date.now() };
  }

  stop() {
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
  }
}

export function connectBinanceRange(options) {
  const feed = new RangeBarFeed(options);
  feed.start();
  return feed;
}
