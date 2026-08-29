import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/paper.js';

export function registerTradingTools(server) {
  server.tool('get_status', 'Report TradingView trading status: desktop CDP, auth session, Trading Panel, connection, active broker id, and whether mutations are safe (safe_for_paper_mutation is true when a broker is connected).', {}, async () => {
    try { return jsonResult(await core.getStatus()); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('open_panel', 'Open, close, or toggle the Trading Panel (bottom widget paper_trading) via the internal bottomWidgetBar API.', {
    action: z.enum(['open', 'close', 'toggle']).optional().describe('open (default), close, or toggle'),
  }, async ({ action }) => {
    try { return jsonResult(await core.openPanel({ action: action || 'open' })); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('connect', 'Connect the currently selected TradingView broker. Fails if not logged in.', {}, async () => {
    try { return jsonResult(await core.connect()); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('get_account', 'Get the active trading account summary (balance, equity, PnL, margin, available funds). Requires a broker connected.', {}, async () => {
    try { return jsonResult(await core.getAccount()); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('list_accounts', 'List trading accounts for the connected broker.', {}, async () => {
    try { return jsonResult(await core.listAccounts()); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('switch_account', 'Switch the active trading account by id.', {
    account_id: z.string().describe('Account id from list_accounts'),
  }, async ({ account_id }) => {
    try { return jsonResult(await core.switchAccount({ account_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('list_positions', 'List open trading positions.', {}, async () => {
    try { return jsonResult(await core.listPositions()); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('list_orders', 'List trading orders (active by default, or order history).', {
    history: z.boolean().optional().describe('If true, return order history instead of active orders'),
  }, async ({ history }) => {
    try { return jsonResult(await core.listOrders({ history: !!history })); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('place_order', 'Place an order with the connected broker. Types: market, limit, stop, stop_limit. Optional TIF (DAY/WEEK/MONTH/GTD), take_profit / stop_loss brackets.', {
    side: z.enum(['buy', 'sell']).describe('Order side'),
    type: z.enum(['market', 'limit', 'stop', 'stop_limit']).optional().describe('Order type (default market)'),
    qty: z.coerce.number().describe('Quantity'),
    symbol: z.string().optional().describe('Symbol (defaults to active chart symbol)'),
    price: z.coerce.number().optional().describe('Limit price (limit / stop_limit)'),
    stop_price: z.coerce.number().optional().describe('Stop price (stop / stop_limit)'),
    take_profit: z.coerce.number().optional().describe('Take profit price'),
    stop_loss: z.coerce.number().optional().describe('Stop loss price'),
    tif: z.enum(['DAY', 'WEEK', 'MONTH', 'GTD']).optional().describe('Time in force (default varies by broker)'),
    duration_datetime: z.union([z.string(), z.coerce.number()]).optional().describe('Required for GTD: ISO date/time or unix ms'),
  }, async (args) => {
    try { return jsonResult(await core.placeOrder(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('cancel_order', 'Cancel an active trading order by id.', {
    order_id: z.string().describe('Order id'),
  }, async ({ order_id }) => {
    try { return jsonResult(await core.cancelOrder({ order_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('modify_order', 'Modify an active trading order (qty / price / stop_price).', {
    order_id: z.string().describe('Order id'),
    qty: z.coerce.number().optional().describe('New quantity'),
    price: z.coerce.number().optional().describe('New limit price'),
    stop_price: z.coerce.number().optional().describe('New stop price'),
  }, async (args) => {
    try { return jsonResult(await core.modifyOrder(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('close_position', 'Close a trading position (full or partial).', {
    position_id: z.string().optional().describe('Position id (often the symbol)'),
    symbol: z.string().optional().describe('Symbol if position_id omitted'),
    qty: z.coerce.number().optional().describe('Partial close quantity (omit for full close)'),
  }, async (args) => {
    try { return jsonResult(await core.closePosition(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });

  server.tool('set_brackets', 'Add, change, or clear stop loss / take profit on an open position.', {
    position_id: z.string().optional().describe('Position id (often the symbol)'),
    symbol: z.string().optional().describe('Symbol if position_id omitted'),
    stop_loss: z.coerce.number().optional().describe('Stop loss price'),
    take_profit: z.coerce.number().optional().describe('Take profit price'),
    clear: z.boolean().optional().describe('If true, clear both stop loss and take profit'),
  }, async (args) => {
    try { return jsonResult(await core.setBrackets(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message, code: err.code }, true); }
  });
}
