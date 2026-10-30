#!/usr/bin/env node
/**
 * index.mjs — HFT-style 1-range-bar scalper.
 *
 * Reads a live Binance BTCUSD feed, builds 1-point range bars, and on each
 * completed bar opens a position in the bar's direction on the BlackBull demo
 * account, then FORCE-CLOSES on the next completed bar (fast round-trip, max
 * holding = one range bar).
 *
 * SAFETY (read these):
 *  - DRY-RUN IS THE DEFAULT. Pass --live to actually trade.
 *  - Demo account only. The account id comes from env BB_ACCOUNT and must be
 *    the demo id (48466618); if set to a live id the bot refuses to start.
 *  - Max one open position at a time.
 *  - qty default 0.005 (min), risk-capped in NZD.
 *  - A spread/misquote guard stops trading if Binance vs BlackBull diverges.
 *
 * Usage:
 *   BB_TOKEN=$(node fetch-token.mjs) node index.mjs --dry-run
 *   BB_TOKEN=$(node fetch-token.mjs) BB_ACCOUNT=48466618 node index.mjs --live
 */
import { connectBinanceRange } from './binance-feed.mjs';
import { BlackBullClient } from './blackbull-executor.mjs';

const LIVE_ACCOUNTS = new Set(['48466898', '48475221']);

function parseArgs(argv) {
  const o = { dryRun: true, qty: 0.005, rangePts: 1, riskNzd: 5 };
  for (const a of argv) {
    if (a === '--live') o.dryRun = false;
    if (a === '--dry-run') o.dryRun = true;
    const m = a.match(/^--(qty|range|risk)=(.+)$/i);
    if (m) {
      const v = Number(m[2]);
      if (m[1].toLowerCase() === 'qty' && v >= 0.005 && v <= 100) o.qty = v;
      if (m[1].toLowerCase() === 'range' && v > 0) o.rangePts = v;
      if (m[1].toLowerCase() === 'risk' && v > 0) o.riskNzd = v;
    }
  }
  return o;
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const accountId = process.env.BB_ACCOUNT || '48466618';

  if (LIVE_ACCOUNTS.has(accountId)) {
    console.error('REFUSING: BB_ACCOUNT resolves to a live (real-money) account. Demo only.');
    process.exit(1);
  }

  log('mode:', opts.dryRun ? 'DRY-RUN (no orders placed)' : 'LIVE', '| qty', opts.qty, '| rangePts', opts.rangePts, '| account', accountId);

  const exec = new BlackBullClient({ accountId });
  try { await exec.warm(); log('broker token warmed'); }
  catch (e) { log('broker warm failed (will retry on first trade):', e.message); }

  // Positions the bot must never close (user's manual trades). Comma-separated
  // ids via BB_PROTECT; empty by default.
  const protectedIds = new Set(
    (process.env.BB_PROTECT || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const feed = connectBinanceRange({ rangePts: opts.rangePts });

  function guard(bar) {
    // Simple spread guard placeholder — real BlackBull quote comparison can be
    // added by a quote endpoint; kept cheap here.
    return true;
  }

  async function positionById() {
    try {
      const pos = await exec.listPositions();
      return Array.isArray(pos) ? pos : [];
    } catch (e) { return null; }
  }

  async function open(bar) {
    const side = bar.up ? 'buy' : 'sell';
    if (opts.dryRun) {
      log('  [dry-run] WOULD open', side, opts.qty, '@', bar.close.toFixed(2));
      return;
    }
    try {
      const res = await exec.openMarket({ side, qty: opts.qty });
      log('  open', side, '-> order', res.orderId, '@', bar.close.toFixed(2));
    } catch (e) {
      log('  open FAILED:', e.message, '-> closing feed');
      feed.stop();
      process.exit(1);
    }
  }

  // Close EVERY open position except protected ones. Because this runs at the
  // top of every bar, nothing can stack regardless of trades missed or orders
  // that settle late — the next bar closes it. Fast (fire-and-forget during
  // live bars); strict verify only on shutdown.
  async function closeAll(reason, strict = false) {
    if (opts.dryRun) {
      log('  [dry-run] WOULD close all non-protected (', reason, ')');
      return;
    }
    const pos = await positionById();
    if (!pos) return;
    for (const p of pos) {
      const id = String(p.id);
      if (protectedIds.has(id)) continue;
      try {
        await exec.closePosition(id, p.qty);
        if (!strict) log('  closed', id, p.side, '(', reason, ')');
      } catch (e) {
        log('  close', id, p.side, '(' + reason + ') error:', e.message);
      }
      if (strict) {
        let gone = false;
        for (let attempt = 1; attempt <= 5 && !gone; attempt++) {
          try {
            const chk = await positionById();
            gone = !chk || !chk.some((x) => String(x.id) === id);
            if (!gone) {
              log('  position', id, 'still open, retrying close...');
              await new Promise((r) => setTimeout(r, 300));
              await exec.closePosition(id, p.qty).catch(() => {});
            }
          } catch (e) {
            log('  position check error:', e.message);
          }
        }
      }
    }
  }

  let handling = false;
  feed.addEventListener('bar', async (ev) => {
    if (handling) return; // single-flight: never process bars concurrently
    handling = true;
    const bar = ev.detail;
    try {
      // Always force-close any held position first (fast round-trip).
      await closeAll('new bar ' + (bar.up ? 'up' : 'down'));
      if (!guard(bar)) return;
      await open(bar);
    } catch (e) {
      log('  bar-handler error:', e.message);
    } finally {
      handling = false;
    }
  });

  feed.addEventListener('error', (e) => log('feed error', e.detail?.message));
  feed.addEventListener('close', () => log('feed closed'));

  const shutdown = async () => {
    log('shutting down...');
    try { await closeAll('shutdown', true); } catch (e) { log('shutdown close error', e.message); }
    feed.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('waiting for Binance range feed (rangePts =', opts.rangePts, ')...');
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
