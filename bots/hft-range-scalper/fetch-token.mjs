#!/usr/bin/env node
/**
 * fetch-token.mjs — pull the TradingView session token from a running Desktop
 * via CDP (port 9222) and print it to stdout.
 *
 * Usage:
 *   node fetch-token.mjs            # print token to stdout
 *   TV_TOKEN=$(node fetch-token.mjs) node index.mjs   # inject into env
 *
 * The token is the OAuth bearer for blackbull.tv.ctrader.com. It can expire /
 * rotate; re-run this helper whenever the bot reports 401 / Forbidden.
 */
import CDP from 'chrome-remote-interface';

const HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;

async function main() {
  let client = null;
  try {
    client = await CDP({ host: HOST, port: PORT });
    await client.Runtime.enable();
    const { result } = await client.Runtime.evaluate({
      expression: 'window.user && window.user.auth_token || ""',
      returnByValue: true,
    });
    const token = result && result.value;
    if (!token || typeof token !== 'string' || token.length < 40) {
      throw new Error('Could not read window.user.auth_token (is TradingView logged in and reachable on port 9222?)');
    }
    process.stdout.write(token + '\n');
    process.exitCode = 0;
  } finally {
    if (client) { try { await client.close(); } catch (e) {} }
  }
}

main().catch((e) => {
  process.stderr.write('fetch-token error: ' + (e && e.message) + '\n');
  process.exit(1);
});
