// Pump.fun paper sprint bot: early momentum with exits.
//
// Hello: the harness opens with a hello, then sends one batch of events per
// slot, and this bot answers each batch with its orders. The plan is simple:
// buy each new coin once, early, while it is still cheap, then manage the
// exit with a take-profit, a stop-loss, a trailing stop and a time stop.
// Positions the bot never sells are closed by the harness when the curve
// completes or the replay ends, so every round trip still counts.
//
// What the dev window taught this bot: the average coin bought early returns
// about 1.25x, but the median coin returns only 0.86x, and the profit lives
// in a fat tail (about 4% of coins run 5x or more) that mostly plays out in
// the first few trades — before a bot that answers one batch per slot and
// fills two slots later can buy into it. Buying the burst late and holding
// it lost about half the stake; holding a long window lost about a third.
// Cutting losers early and banking winners promptly lost the least, so the
// exits are: sell at +50% (take-profit), sell at -35% (stop-loss), sell if
// the price falls to 80% of its peak once the peak is +20% (trailing stop),
// and sell whatever is left after about 24000 slots (~85 minutes).
//
// Guardrails the bot respects: at most 5 open positions, at most 16 orders
// per batch, buys capped at 100 bps of the coin's real SOL reserve, and every
// buy is at least 0.01 SOL so each round trip clears the 0.01 SOL minimum.
//
// Pure Node stdlib, no network, no clock, no Math.random: the only
// randomness-free inputs are the hello seed and the batches themselves, so
// two runs produce byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 4n) / 100n; // 0.04 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: the round-trip minimum
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never refuse a fill for price drift in latency

// Exit levels, as price multiples of the entry price (integer bps, x10000).
const TAKE_PROFIT_BPS = 15_000; // sell at +50%
const STOP_LOSS_BPS = 6_500; // sell at -35%
const TRAIL_TRIGGER_BPS = 12_000; // trailing stop arms once price is +20% ...
const TRAIL_DROP_BPS = 8_000; // ... then sells if price falls to 80% of its peak
const HOLD_MAX_SLOTS = 24_000; // time stop: free the slot after ~85 minutes

/** Coins created and not yet decided (bought or skipped for good). */
const candidates = new Set<string>();

interface Entry {
  /** SOL spent per token at entry, as quote/token (both bigints). */
  quote: bigint;
  tokens: bigint;
  /** Peak price since entry, as quote/token. */
  peakQuote: bigint;
  peakTokens: bigint;
  /** Slot the buy filled at. */
  slot: number;
}

/** Entry price per held mint, filled in from buy fills. */
const entries = new Map<string, Entry>();
/** Mints with a sell already in flight this run. */
const sellPending = new Set<string>();

/** Compare two prices (quote/token pairs): -1, 0, 1 for a vs b. */
function cmpPrice(aQuote: bigint, aTokens: bigint, bQuote: bigint, bTokens: bigint): number {
  const left = aQuote * bTokens;
  const right = bQuote * aTokens;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when price a is at least `bps`/10000 of price b. */
function atLeastBps(aQuote: bigint, aTokens: bigint, bQuote: bigint, bTokens: bigint, bps: number): boolean {
  return aQuote * bTokens * 10_000n >= bQuote * aTokens * BigInt(bps);
}

/** True when price a is at most `bps`/10000 of price b. */
function atMostBps(aQuote: bigint, aTokens: bigint, bQuote: bigint, bTokens: bigint, bps: number): boolean {
  return aQuote * bTokens * 10_000n <= bQuote * aTokens * BigInt(bps);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: (BuyInput | SellInput)[] = [];

    // Fold this batch's fills in first: record entry prices for fresh buys,
    // and clear sells that resolved so the mint can be sold again if needed.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') {
        if (fill.side === 'sell') sellPending.delete(fill.mint);
        continue;
      }
      if (fill.side === 'buy') {
        entries.set(fill.mint, {
          quote: BigInt(fill.quote_lamports),
          tokens: BigInt(fill.token_amount),
          peakQuote: BigInt(fill.quote_lamports),
          peakTokens: BigInt(fill.token_amount),
          slot: fill.slot,
        });
      } else {
        sellPending.delete(fill.mint);
        entries.delete(fill.mint);
      }
    }

    // Exits first: for every held position with a known entry price, check
    // the latest curve price (marks carry it; the curve map has it too).
    for (const [mint, holding] of state.positions) {
      if (sellPending.has(mint)) continue;
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (entry === undefined || curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n || curve.virtual_quote_reserves === 0n) continue;
      const q = curve.virtual_quote_reserves;
      const t = curve.virtual_token_reserves;
      // Track the peak price since entry for the trailing stop.
      if (cmpPrice(q, t, entry.peakQuote, entry.peakTokens) > 0) {
        entry.peakQuote = q;
        entry.peakTokens = t;
      }
      const takeProfit = atLeastBps(q, t, entry.quote, entry.tokens, TAKE_PROFIT_BPS);
      const stopLoss = atMostBps(q, t, entry.quote, entry.tokens, STOP_LOSS_BPS);
      const trailing =
        atLeastBps(entry.peakQuote, entry.peakTokens, entry.quote, entry.tokens, TRAIL_TRIGGER_BPS) &&
        atMostBps(q, t, entry.peakQuote, entry.peakTokens, TRAIL_DROP_BPS);
      const timedOut = batch.slot - entry.slot >= HOLD_MAX_SLOTS;
      if (takeProfit || stopLoss || trailing || timedOut) {
        if (orders.length >= caps.max_orders_per_batch) continue;
        if (free < tx) continue;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        sellPending.add(mint);
        free -= tx;
      }
    }

    // Entries: coins created in this batch become candidates; each is
    // decided once, on the first batch where its buy-size cap reaches the
    // 0.01 SOL minimum. A fresh curve holds no real SOL, so the decision
    // waits for trades to build its reserve.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') candidates.add(e.mint);
      if (!candidates.has(e.mint)) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(e.mint);
        continue;
      }
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      candidates.delete(e.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0 || free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
