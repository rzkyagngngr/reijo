import type {
  BotConfig,
  DailyPnlRecord,
  DailyTradeEntry,
  OrderBook,
  OrderbookMetrics,
  OrderRecord,
  OrderSide,
  PortfolioState,
  Position,
  SettleOutcome,
  StrategyVariant,
} from './types.ts';

/**
 * Clamp contract price to valid Kalshi binary bounds (1 to 99 cents).
 */
export function clampCents(price: number): number {
  if (!Number.isFinite(price)) return 50;
  return Math.max(1, Math.min(99, Math.round(price)));
}

/**
 * Resolve official Kalshi binary settlement outcome ('win' | 'lose' | 'pending') for a given trade side.
 */
export function resolveSettleOutcome(
  side: OrderSide,
  marketResult: string | undefined | null
): { outcome: SettleOutcome; resultSide?: OrderSide } {
  const normalized = typeof marketResult === 'string' ? marketResult.trim().toLowerCase() : '';
  if (normalized === 'yes' || normalized === 'no') {
    return {
      outcome: normalized === side ? 'win' : 'lose',
      resultSide: normalized,
    };
  }
  return { outcome: 'pending' };
}

/**
 * Check whether `nowMs` falls within [startMin, endMin] elapsed minutes inside a 15-minute contract.
 */
export function isInsideMinuteWindow(
  closeTimeIso: string,
  nowMs: number = Date.now(),
  startMin = 7,
  endMin = 13
): boolean {
  const closeMs = Date.parse(closeTimeIso);
  if (!Number.isFinite(closeMs)) return false;
  const openMs = closeMs - 15 * 60 * 1000;
  const elapsedMs = nowMs - openMs;
  return elapsedMs >= startMin * 60 * 1000 && elapsedMs <= endMin * 60 * 1000;
}

/**
 * Update lowest bid watermark only while inside the 7–13m window.
 * Outside the window, preserves the existing watermark unchanged.
 */
export function updateTrackedLowBid(
  currentLow: number | null | undefined,
  observedBidCents: number,
  closeTimeIso: string,
  nowMs: number = Date.now()
): number | null | undefined {
  if (!isInsideMinuteWindow(closeTimeIso, nowMs, 7, 13)) {
    return currentLow;
  }
  const clamped = clampCents(observedBidCents);
  return typeof currentLow === 'number' ? Math.min(currentLow, clamped) : clamped;
}

/**
 * Update lowest bid watermark and its reached timestamp inside the 7–13m window.
 */
export function updateTrackedLowWithTime(
  currentLow: number | null | undefined,
  currentLowAt: string | null | undefined,
  observedBidCents: number,
  closeTimeIso: string,
  nowMs: number = Date.now()
): { lowestBidCents: number | null | undefined; lowestBidAt: string | null | undefined } {
  if (!isInsideMinuteWindow(closeTimeIso, nowMs, 7, 13)) {
    return { lowestBidCents: currentLow, lowestBidAt: currentLowAt };
  }
  const clamped = clampCents(observedBidCents);
  const nowIso = new Date(nowMs).toISOString();
  if (typeof currentLow !== 'number' || clamped < currentLow) {
    return { lowestBidCents: clamped, lowestBidAt: nowIso };
  }
  if (!currentLowAt && clamped === currentLow) {
    return { lowestBidCents: currentLow, lowestBidAt: nowIso };
  }
  return { lowestBidCents: currentLow, lowestBidAt: currentLowAt };
}

/**
 * Update highest bid watermark and its reached timestamp while the 15m contract is open (up to closeTimeIso).
 */
export function updateTrackedHighWithTime(
  currentHigh: number | null | undefined,
  currentHighAt: string | null | undefined,
  observedBidCents: number,
  closeTimeIso: string,
  nowMs: number = Date.now(),
  minStartMs?: number
): { highestBidCents: number | null | undefined; highestBidAt: string | null | undefined } {
  const closeMs = Date.parse(closeTimeIso);
  if (!Number.isFinite(closeMs) || nowMs > closeMs) {
    return { highestBidCents: currentHigh, highestBidAt: currentHighAt };
  }
  if (typeof minStartMs === 'number' && Number.isFinite(minStartMs) && nowMs < minStartMs) {
    return { highestBidCents: currentHigh, highestBidAt: currentHighAt };
  }
  const clamped = clampCents(observedBidCents);
  const nowIso = new Date(nowMs).toISOString();
  if (typeof currentHigh !== 'number' || clamped > currentHigh) {
    return { highestBidCents: clamped, highestBidAt: nowIso };
  }
  if (!currentHighAt && clamped === currentHigh) {
    return { highestBidCents: currentHigh, highestBidAt: nowIso };
  }
  return { highestBidCents: currentHigh, highestBidAt: currentHighAt };
}

/**
 * Format elapsed minute:second (e.g. "Mnt 11:24") within a 15-minute contract window.
 */
export function formatContractElapsedMinute(
  eventAtIso: string | null | undefined,
  contractReferenceIso?: string | null
): string | null {
  if (!eventAtIso) return null;
  const eventMs = Date.parse(eventAtIso);
  if (!Number.isFinite(eventMs)) return null;

  const refMs = contractReferenceIso ? Date.parse(contractReferenceIso) : NaN;
  const openMs = Number.isFinite(refMs)
    ? Math.floor(refMs / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS
    : Math.floor((eventMs - 1) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;

  const elapsedSec = Math.max(0, Math.min(15 * 60, Math.round((eventMs - openMs) / 1000)));
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  return `Mnt ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export interface CalendarDayCell {
  dateKey: string;
  dayNumber: number;
  inCurrentMonth: boolean;
  isToday: boolean;
  record: DailyPnlRecord | null;
}

export interface CalendarMonthGrid {
  year: number;
  monthIndex0: number;
  monthLabel: string;
  cells: CalendarDayCell[];
  monthPnlUsd: number;
  monthEntries: number;
  monthExits: number;
  monthWins: number;
  monthLosses: number;
  activeDays: number;
}

/**
 * Build a Monday-first 7-column calendar month grid (35 or 42 cells) mapped to dailyHistory records.
 */
export function buildCalendarMonthGrid(
  year: number,
  monthIndex0: number,
  dailyHistory: Record<string, DailyPnlRecord> | undefined,
  todayKey: string
): CalendarMonthGrid {
  const safeYear = Number.isFinite(year) ? year : 2026;
  const safeMonth = ((monthIndex0 % 12) + 12) % 12;
  const firstDayUtc = new Date(Date.UTC(safeYear, safeMonth, 1));
  // JS getUTCDay(): 0 = Sun, 1 = Mon ... 6 = Sat -> convert to Monday-first index (0 = Mon ... 6 = Sun)
  const startWeekdayMon0 = (firstDayUtc.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(safeYear, safeMonth + 1, 0)).getUTCDate();
  const totalCells = startWeekdayMon0 + daysInMonth > 35 ? 42 : 35;

  const fmtMonth = new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(firstDayUtc);
  const monthLabel = fmtMonth.charAt(0).toUpperCase() + fmtMonth.slice(1);

  const historyMap = dailyHistory ?? {};
  const cells: CalendarDayCell[] = [];
  let monthPnlUsd = 0;
  let monthEntries = 0;
  let monthExits = 0;
  let monthWins = 0;
  let monthLosses = 0;
  let activeDays = 0;

  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(Date.UTC(safeYear, safeMonth, 1 - startWeekdayMon0 + i));
    const cellYear = cellDate.getUTCFullYear();
    const cellMonth0 = cellDate.getUTCMonth();
    const cellDay = cellDate.getUTCDate();
    const dateKey = `${cellYear}-${String(cellMonth0 + 1).padStart(2, '0')}-${String(cellDay).padStart(2, '0')}`;
    const inCurrentMonth = cellYear === safeYear && cellMonth0 === safeMonth;
    const record = historyMap[dateKey] ?? null;

    if (inCurrentMonth && record && (record.entriesCount > 0 || record.exitsCount > 0 || record.realizedPnlUsd !== 0)) {
      monthPnlUsd += record.realizedPnlUsd;
      monthEntries += record.entriesCount;
      monthExits += record.exitsCount;
      monthWins += record.wins;
      monthLosses += record.losses;
      activeDays += 1;
    }

    cells.push({
      dateKey,
      dayNumber: cellDay,
      inCurrentMonth,
      isToday: dateKey === todayKey,
      record,
    });
  }

  return {
    year: safeYear,
    monthIndex0: safeMonth,
    monthLabel,
    cells,
    monthPnlUsd: Number(monthPnlUsd.toFixed(2)),
    monthEntries,
    monthExits,
    monthWins,
    monthLosses,
    activeDays,
  };
}


/**
 * Kalshi standard taker fee schedule:
 * ceil(0.07 * contracts * p * (1 - p) * 100) / 100
 * where p = priceCents / 100.
 */
export function calcKalshiFee(contracts: number, priceCents: number): number {
  if (contracts <= 0) return 0;
  const clamped = clampCents(priceCents);
  const p = clamped / 100;
  const rawFee = 0.07 * contracts * p * (1 - p);
  return Math.ceil(rawFee * 100 - 1e-9) / 100;
}

/**
 * Total USD cost to buy `contracts` at `priceCents` (excluding fees).
 */
export function calcContractCost(contracts: number, priceCents: number): number {
  if (contracts <= 0) return 0;
  const clamped = clampCents(priceCents);
  return Number(((contracts * clamped) / 100).toFixed(2));
}

/**
 * Gross USD payout if contract settles in-the-money ($1.00 per contract).
 */
export function calcMaxPayout(contracts: number): number {
  if (contracts <= 0) return 0;
  return Number(contracts.toFixed(2));
}

/**
 * Compute mark-to-market value and unrealized PnL for an open position.
 */
export function calcPositionPnl(
  position: Position,
  yesBidCents: number,
  noBidCents: number
): {
  markPriceCents: number;
  marketValueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  returnPct: number;
} {
  const markPriceCents = position.side === 'yes' ? clampCents(yesBidCents) : clampCents(noBidCents);
  const marketValueUsd = Number(((position.contracts * markPriceCents) / 100).toFixed(2));
  const costBasisUsd = Number(((position.contracts * position.avgEntryCents) / 100).toFixed(2));
  const unrealizedPnlUsd = Number((marketValueUsd - costBasisUsd).toFixed(2));
  const returnPct = costBasisUsd > 0 ? Number(((unrealizedPnlUsd / costBasisUsd) * 100).toFixed(2)) : 0;

  return {
    markPriceCents,
    marketValueUsd,
    costBasisUsd,
    unrealizedPnlUsd,
    returnPct,
  };
}

/**
 * Derive YES/NO implied asks, spread, mid-price, and top-3 bid depth imbalance
 * from Kalshi's dual-bid binary orderbook (YES bid at X implies NO ask at 100 - X).
 */
export function calcOrderbookMetrics(orderbook: OrderBook): OrderbookMetrics {
  const sortedYes = [...orderbook.yesBids].sort((a, b) => b.price - a.price);
  const sortedNo = [...orderbook.noBids].sort((a, b) => b.price - a.price);

  const bestYesBid = sortedYes.length > 0 ? clampCents(sortedYes[0].price) : sortedNo.length > 0 ? 1 : 49;
  const bestNoBid = sortedNo.length > 0 ? clampCents(sortedNo[0].price) : sortedYes.length > 0 ? 1 : 49;

  // In a binary market, a YES ask exists wherever someone bids NO at (100 - price)
  const bestYesAsk = clampCents(100 - bestNoBid);
  const bestNoAsk = clampCents(100 - bestYesBid);

  const spreadCents = Math.max(0, bestYesAsk - bestYesBid);
  const midPriceCents = Number(((bestYesBid + bestYesAsk) / 2).toFixed(1));

  const yesDepthTop3 = sortedYes.slice(0, 3).reduce((acc, lvl) => acc + Math.max(0, lvl.quantity), 0);
  const noDepthTop3 = sortedNo.slice(0, 3).reduce((acc, lvl) => acc + Math.max(0, lvl.quantity), 0);
  const totalDepth = yesDepthTop3 + noDepthTop3;
  const imbalanceRatio =
    totalDepth > 0 ? Number(((yesDepthTop3 - noDepthTop3) / totalDepth).toFixed(3)) : 0;

  return {
    bestYesBid,
    bestYesAsk,
    bestNoBid,
    bestNoAsk,
    spreadCents,
    midPriceCents,
    yesDepthTop3,
    noDepthTop3,
    imbalanceRatio,
  };
}

/**
 * Compute Simple Moving Average for the trailing `window` prices.
 */
export function calcSma(prices: number[], window: number): number {
  if (prices.length === 0) return 50;
  const slice = prices.slice(-Math.max(1, window));
  const sum = slice.reduce((acc, val) => acc + val, 0);
  return Number((sum / slice.length).toFixed(2));
}

/**
 * Compute maximum drawdown percentage from an equity curve array.
 */
export function calcMaxDrawdownPct(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return Number(maxDd.toFixed(2));
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Compute the next exact 15-minute UTC interval boundary (:00, :15, :30, :45).
 */
export function getNext15mBoundaryIso(nowMs: number = Date.now()): string {
  const nextBucketMs = (Math.floor(nowMs / FIFTEEN_MINUTES_MS) + 1) * FIFTEEN_MINUTES_MS;
  return new Date(nextBucketMs).toISOString();
}

/**
 * Format remaining time until closeTimeIso as MM:SS plus urgency flags.
 */
export function formatRemainingTime(
  closeTimeIso: string,
  nowMs: number = Date.now()
): { remainingMs: number; formatted: string; isExpiringSoon: boolean } {
  const closeMs = Date.parse(closeTimeIso);
  if (!Number.isFinite(closeMs)) {
    return { remainingMs: 0, formatted: '00:00', isExpiringSoon: true };
  }
  const remainingMs = Math.max(0, closeMs - nowMs);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return {
    remainingMs,
    formatted,
    isExpiringSoon: remainingMs <= 120_000,
  };
}

/**
 * Format timestamp (or current time) as YYYY-MM-DD in Asia/Jakarta (WIB) for daily PnL grouping.
 */
export function getDateKeyWib(msOrIso: number | string = Date.now()): string {
  const date = typeof msOrIso === 'number' ? new Date(msOrIso) : new Date(msOrIso);
  if (!Number.isFinite(date.getTime())) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
}

export interface Kalshi15mSeriesSpec {
  seriesTicker: string;
  label: string;
  category: 'Crypto' | 'Commodities' | 'Forex';
  pairSymbol: string;
  fallbackTitle: string;
}

export const KALSHI_15M_SERIES: Kalshi15mSeriesSpec[] = [
  { seriesTicker: 'KXBTC15M', label: 'BTC', category: 'Crypto', pairSymbol: 'BTC/USD', fallbackTitle: 'BTC price up in next 15 mins?' },
  { seriesTicker: 'KXETH15M', label: 'ETH', category: 'Crypto', pairSymbol: 'ETH/USD', fallbackTitle: 'ETH price up in next 15 mins?' },
  { seriesTicker: 'KXSOL15M', label: 'SOL', category: 'Crypto', pairSymbol: 'SOL/USD', fallbackTitle: 'SOL price up in next 15 mins?' },
  { seriesTicker: 'KXBNB15M', label: 'BNB', category: 'Crypto', pairSymbol: 'BNB/USD', fallbackTitle: 'BNB price up in next 15 mins?' },
  { seriesTicker: 'KXDOGE15M', label: 'DOGE', category: 'Crypto', pairSymbol: 'DOGE/USD', fallbackTitle: 'DOGE price up in next 15 mins?' },
  { seriesTicker: 'KXHYPE15M', label: 'HYPE', category: 'Crypto', pairSymbol: 'HYPE/USD', fallbackTitle: 'HYPE price up in next 15 mins?' },
  { seriesTicker: 'KXNEAR15M', label: 'NEAR', category: 'Crypto', pairSymbol: 'NEAR/USD', fallbackTitle: 'NEAR price up in next 15 mins?' },
  { seriesTicker: 'KXXRP15M', label: 'XRP', category: 'Crypto', pairSymbol: 'XRP/USD', fallbackTitle: 'XRP price up in next 15 mins?' },
  { seriesTicker: 'KXZEC15M', label: 'ZEC', category: 'Crypto', pairSymbol: 'ZEC/USD', fallbackTitle: 'ZEC price up in next 15 mins?' },
  { seriesTicker: 'KXGOLD15M', label: 'Gold', category: 'Commodities', pairSymbol: 'XAU/USD', fallbackTitle: 'Gold price up in next 15 mins?' },
  { seriesTicker: 'KXWTI15M', label: 'WTI', category: 'Commodities', pairSymbol: 'WTI/USD', fallbackTitle: 'WTI Oil price up in next 15 mins?' },
  { seriesTicker: 'KXSILVER15M', label: 'Silver', category: 'Commodities', pairSymbol: 'XAG/USD', fallbackTitle: 'Silver price up in next 15 mins?' },
  { seriesTicker: 'KXEURUSD15M', label: 'EUR/USD', category: 'Forex', pairSymbol: 'EUR/USD', fallbackTitle: 'EUR/USD price up in next 15 mins?' },
  { seriesTicker: 'KXUSDJPY15M', label: 'USD/JPY', category: 'Forex', pairSymbol: 'USD/JPY', fallbackTitle: 'USD/JPY price up in next 15 mins?' },
  { seriesTicker: 'KXGBPUSD15M', label: 'GBP/USD', category: 'Forex', pairSymbol: 'GBP/USD', fallbackTitle: 'GBP/USD price up in next 15 mins?' },
];

const PAIR_LABEL_MAP: Record<string, string> = {
  KXBTC15M: 'BTC',
  'KXBTC15M-UP': 'BTC',
  KXETH15M: 'ETH',
  'KXETH15M-UP': 'ETH',
  KXSOL15M: 'SOL',
  'KXSOL15M-UP': 'SOL',
  KXBNB15M: 'BNB',
  'KXBNB15M-UP': 'BNB',
  KXDOGE15M: 'DOGE',
  'KXDOGE15M-UP': 'DOGE',
  KXHYPE15M: 'HYPE',
  'KXHYPE15M-UP': 'HYPE',
  KXNEAR15M: 'NEAR',
  'KXNEAR15M-UP': 'NEAR',
  KXXRP15M: 'XRP',
  'KXXRP15M-UP': 'XRP',
  KXZEC15M: 'ZEC',
  'KXZEC15M-UP': 'ZEC',
  KXGOLD15M: 'Gold',
  'KXXAU15M-UP': 'Gold',
  KXWTI15M: 'WTI',
  'KXWTI15M-UP': 'WTI',
  KXSILVER15M: 'Silver',
  'KXXAG15M-UP': 'Silver',
  KXEURUSD15M: 'EUR/USD',
  'KXEURUSD15M-UP': 'EUR/USD',
  KXUSDJPY15M: 'USD/JPY',
  'KXUSDJPY15M-UP': 'USD/JPY',
  KXGBPUSD15M: 'GBP/USD',
  'KXGBPUSD15M-UP': 'GBP/USD',
};

/**
 * Extract canonical Kalshi 15m series ticker from a full dynamic contract ticker or legacy alias.
 */
export function getSeriesTicker(tickerOrSeries: string): string {
  const upper = tickerOrSeries.trim().toUpperCase();
  if (upper.startsWith('KXBTC15M') || upper.includes('BTC')) return 'KXBTC15M';
  if (upper.startsWith('KXETH15M') || upper.includes('ETH')) return 'KXETH15M';
  if (upper.startsWith('KXSOL15M') || upper.includes('SOL')) return 'KXSOL15M';
  if (upper.startsWith('KXBNB15M') || upper.includes('BNB')) return 'KXBNB15M';
  if (upper.startsWith('KXDOGE15M') || upper.includes('DOGE')) return 'KXDOGE15M';
  if (upper.startsWith('KXHYPE15M') || upper.includes('HYPE')) return 'KXHYPE15M';
  if (upper.startsWith('KXNEAR15M') || upper.includes('NEAR')) return 'KXNEAR15M';
  if (upper.startsWith('KXXRP15M') || upper.includes('XRP')) return 'KXXRP15M';
  if (upper.startsWith('KXZEC15M') || upper.includes('ZEC')) return 'KXZEC15M';
  if (upper.startsWith('KXGOLD15M') || upper.includes('XAU') || upper.includes('GOLD')) return 'KXGOLD15M';
  if (upper.startsWith('KXWTI15M') || upper.includes('WTI') || upper.includes('OIL')) return 'KXWTI15M';
  if (upper.startsWith('KXSILVER15M') || upper.includes('XAG') || upper.includes('SILVER')) return 'KXSILVER15M';
  if (upper.startsWith('KXEURUSD15M') || upper.includes('EURUSD')) return 'KXEURUSD15M';
  if (upper.startsWith('KXUSDJPY15M') || upper.includes('USDJPY')) return 'KXUSDJPY15M';
  if (upper.startsWith('KXGBPUSD15M') || upper.includes('GBPUSD')) return 'KXGBPUSD15M';
  return upper.split('-')[0];
}

/**
 * Convert internal Kalshi ticker codes (e.g. KXBTC15M-26NOV131045-45, KXGOLD15M-...) into clean readable pair names.
 */
export function formatPairLabel(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  if (PAIR_LABEL_MAP[upper]) return PAIR_LABEL_MAP[upper];
  const series = getSeriesTicker(upper);
  if (PAIR_LABEL_MAP[series]) return PAIR_LABEL_MAP[series];
  return upper.replace(/^KX/, '').replace(/15M.*$/, '');
}

/**
 * Resolve strategy variant ('A' or 'B') from explicit variant, strategy, botId, or botName.
 */
export function resolveStrategyVariant(
  botId?: string | null,
  botName?: string,
  strategy?: BotConfig['strategy'],
  explicitVariant?: StrategyVariant
): StrategyVariant | undefined {
  if (
    explicitVariant === 'B' ||
    strategy === 'preopen_spike' ||
    (botId && botId.startsWith('bot-varb-')) ||
    (botName && botName.includes('Varian B'))
  ) {
    return 'B';
  }
  if (
    explicitVariant === 'A' ||
    (botId && botId.startsWith('bot-15m-')) ||
    (botName && (botName.includes('Varian A') || botName.includes('15m') || botName.includes('Bot 15m')))
  ) {
    return 'A';
  }
  if (strategy) return 'A';
  return undefined;
}

function getRawTickerFromTradedKey(key: string): string {
  const sepIdx = key.indexOf('::');
  return sepIdx >= 0 ? key.slice(sepIdx + 2) : key;
}

/**
 * Remove all trade history, orders, open positions, tradedTickers, and cash/PnL impact
 * belonging to the specified strategy variant ('A' or 'B'), preserving all other variants
 * and maintaining the accounting invariant:
 * dailyRealizedPnlUsd = cashUsd + openCostBasis - startingCashUsd.
 */
export function clearVariantHistoryAndPnl(
  state: PortfolioState,
  targetVariant: StrategyVariant
): PortfolioState {
  const botStrategyById = new Map<string, BotConfig['strategy']>();
  const variantBotIds = new Set<string>();
  for (const b of state.bots) {
    botStrategyById.set(b.id, b.strategy);
    if (resolveStrategyVariant(b.id, b.name, b.strategy) === targetVariant) {
      variantBotIds.add(b.id);
    }
  }

  const matchesTarget = (params: {
    botId?: string | null;
    botName?: string;
    explicitVariant?: StrategyVariant;
  }): boolean => {
    const strat = params.botId ? botStrategyById.get(params.botId) : undefined;
    return (
      resolveStrategyVariant(params.botId, params.botName, strat, params.explicitVariant) ===
      targetVariant
    );
  };

  const keptPositions: Position[] = [];
  const removedPositions: Position[] = [];
  for (const pos of state.positions) {
    if (matchesTarget({ botId: pos.botId, explicitVariant: pos.variant })) {
      removedPositions.push(pos);
    } else {
      keptPositions.push(pos);
    }
  }

  const keptOrders: OrderRecord[] = [];
  const removedOrders: OrderRecord[] = [];
  const removedOrderIds = new Set<string>();
  for (const ord of state.orders) {
    if (matchesTarget({ botId: ord.botId, botName: ord.botName })) {
      removedOrders.push(ord);
      removedOrderIds.add(ord.id);
    } else {
      keptOrders.push(ord);
    }
  }

  const removedOrdersFilled = removedOrders.filter((o) => o.status === 'filled').length;
  const keptOrdersFilled = keptOrders.filter((o) => o.status === 'filled').length;

  // Check if all removed dailyHistory entries exist in removedOrders for exact cash reconciliation
  let allRemovedEntriesInOrders = true;
  let removedEntriesSellNetSum = 0;
  let removedEntriesOpenFeesSum = 0;
  const nextDailyHistory: Record<string, DailyPnlRecord> = {};

  for (const [dateKey, dayRec] of Object.entries(state.dailyHistory ?? {})) {
    const keptEntries: DailyTradeEntry[] = [];
    const removedEntries: DailyTradeEntry[] = [];
    for (const entry of dayRec.entries) {
      if (matchesTarget({ botId: entry.botId, botName: entry.botName, explicitVariant: entry.variant })) {
        removedEntries.push(entry);
        if (!removedOrderIds.has(entry.id)) {
          allRemovedEntriesInOrders = false;
        }
      } else {
        keptEntries.push(entry);
      }
    }

    if (removedEntries.length === 0) {
      nextDailyHistory[dateKey] = dayRec;
      continue;
    }

    const removedBuys = removedEntries.filter((e) => e.action === 'buy');
    const removedSells = removedEntries.filter((e) => e.action === 'sell');
    const closedKeys = new Set(
      removedSells.map((e) => `${e.botId ?? e.botName}::${e.ticker}::${e.side}`)
    );
    const openRemovedFees = removedBuys
      .filter((e) => !closedKeys.has(`${e.botId ?? e.botName}::${e.ticker}::${e.side}`))
      .reduce((sum, e) => sum + e.feeUsd, 0);
    const sellNet = removedSells.reduce((sum, e) => sum + (e.netPnlUsd ?? 0), 0);
    removedEntriesSellNetSum += sellNet;
    removedEntriesOpenFeesSum += openRemovedFees;

    const removedFees = removedEntries.reduce((sum, e) => sum + e.feeUsd, 0);
    const removedWins = removedSells.filter((e) => (e.netPnlUsd ?? 0) > 0).length;
    const removedLosses = removedSells.filter((e) => (e.netPnlUsd ?? 0) <= 0).length;

    const nextEntriesByTicker: Record<string, number> = { ...dayRec.entriesByTicker };
    for (const b of removedBuys) {
      const nextCount = (nextEntriesByTicker[b.ticker] ?? 0) - 1;
      if (nextCount <= 0) {
        delete nextEntriesByTicker[b.ticker];
      } else {
        nextEntriesByTicker[b.ticker] = nextCount;
      }
    }

    const nextEntriesCount = Math.max(0, dayRec.entriesCount - removedBuys.length);
    const nextExitsCount = Math.max(0, dayRec.exitsCount - removedSells.length);
    const nextWins = Math.max(0, dayRec.wins - removedWins);
    const nextLosses = Math.max(0, dayRec.losses - removedLosses);
    const nextFeesUsd = Number(Math.max(0, dayRec.feesUsd - removedFees).toFixed(2));

    // Exact cash delta on this date from orders if available, else from entry net PnL
    const removedOrdersOnDate = removedOrders.filter((o) =>
      removedEntries.some((e) => e.id === o.id)
    );
    const dayRealizedRemoved =
      removedOrdersOnDate.length === removedEntries.length
        ? removedOrdersOnDate
            .filter((o) => o.status === 'filled')
            .reduce((sum, o) => sum + (o.action === 'buy' ? -o.totalUsd : o.totalUsd), 0) +
          removedPositions
            .filter((p) => removedBuys.some((b) => b.ticker === p.ticker && b.side === p.side && (b.botId ?? null) === (p.botId ?? null)))
            .reduce((sum, p) => sum + calcContractCost(p.contracts, p.avgEntryCents), 0)
        : sellNet - openRemovedFees;

    const nextDayRealized = Number((dayRec.realizedPnlUsd - dayRealizedRemoved).toFixed(2));

    if (nextEntriesCount === 0 && nextExitsCount === 0 && keptEntries.length === 0) {
      continue;
    }

    nextDailyHistory[dateKey] = {
      date: dayRec.date,
      realizedPnlUsd: nextDayRealized,
      feesUsd: nextFeesUsd,
      entriesCount: nextEntriesCount,
      exitsCount: nextExitsCount,
      wins: nextWins,
      losses: nextLosses,
      entriesByTicker: nextEntriesByTicker,
      entries: keptEntries,
    };
  }

  const removedOpenCostBasis = removedPositions.reduce(
    (sum, p) => sum + calcContractCost(p.contracts, p.avgEntryCents),
    0
  );

  let removedCashImpact: number;
  if (allRemovedEntriesInOrders) {
    removedCashImpact = removedOrders
      .filter((o) => o.status === 'filled')
      .reduce((sum, o) => sum + (o.action === 'buy' ? -o.totalUsd : o.totalUsd), 0);
  } else {
    removedCashImpact = removedEntriesSellNetSum - removedEntriesOpenFeesSum - removedOpenCostBasis;
  }

  const nextCashUsd = Number(Math.max(0, state.cashUsd - removedCashImpact).toFixed(2));
  const nextOpenCostBasis = keptPositions.reduce(
    (sum, p) => sum + calcContractCost(p.contracts, p.avgEntryCents),
    0
  );
  const nextDailyRealizedPnlUsd = Number(
    (nextCashUsd + nextOpenCostBasis - state.startingCashUsd).toFixed(2)
  );

  // Align single active day's realizedPnlUsd with exact portfolio realized invariant if needed
  const remainingDayKeys = Object.keys(nextDailyHistory);
  if (remainingDayKeys.length === 1) {
    const onlyKey = remainingDayKeys[0];
    nextDailyHistory[onlyKey] = {
      ...nextDailyHistory[onlyKey],
      realizedPnlUsd: nextDailyRealizedPnlUsd,
    };
  }

  const nextTradedTickers = (state.tradedTickers ?? []).filter((key) => {
    const sepIdx = key.indexOf('::');
    if (sepIdx > 0) {
      const botId = key.slice(0, sepIdx);
      if (variantBotIds.has(botId)) return false;
      if (targetVariant === 'B' && botId.startsWith('bot-varb-')) return false;
      if (targetVariant === 'A' && botId.startsWith('bot-15m-')) return false;
    }
    const rawTicker = getRawTickerFromTradedKey(key);
    return Boolean(rawTicker);
  });

  const nextBots = state.bots.map((b) => {
    if (resolveStrategyVariant(b.id, b.name, b.strategy) !== targetVariant) {
      return b;
    }
    return {
      ...b,
      tradesExecuted: 0,
      realizedPnlUsd: 0,
      lastRunAt: null,
      lastSignalReason:
        b.strategy === 'preopen_spike'
          ? 'Riwayat & PnL Varian B dihapus — siap pantau market 15m berikutnya.'
          : 'Riwayat & PnL Varian A dihapus — siap pantau market 15m berikutnya.',
    };
  });

  return {
    ...state,
    cashUsd: nextCashUsd,
    dailyRealizedPnlUsd: nextDailyRealizedPnlUsd,
    totalFilledOrders: Math.max(
      keptOrdersFilled,
      (state.totalFilledOrders ?? keptOrdersFilled + removedOrdersFilled) - removedOrdersFilled
    ),
    tradedTickers: nextTradedTickers,
    dailyHistory: nextDailyHistory,
    positions: keptPositions,
    orders: keptOrders,
    bots: nextBots,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Derive non-stale, non-inverted top-of-book YES/NO bid & ask cents from sorted orderbook levels.
 * Returns null if both sides are empty.
 */
export function deriveTopOfBookFromOrderbook(
  yesBids: Array<{ price: number; quantity: number }>,
  noBids: Array<{ price: number; quantity: number }>
): { yesBid: number; yesAsk: number; noBid: number; noAsk: number } | null {
  if (yesBids.length === 0 && noBids.length === 0) return null;
  const bestYesBid = yesBids.length > 0 ? clampCents(yesBids[0].price) : 1;
  const bestNoBid = noBids.length > 0 ? clampCents(noBids[0].price) : 1;
  const yesAsk = noBids.length > 0 ? clampCents(100 - bestNoBid) : 99;
  const noAsk = yesBids.length > 0 ? clampCents(100 - bestYesBid) : 99;
  return {
    yesBid: Math.min(bestYesBid, yesAsk),
    yesAsk,
    noBid: Math.min(bestNoBid, noAsk),
    noAsk,
  };
}

/**
 * Reconcile existing trade history so Varian A trades closed early via TP / Trailing Stop
 * reflect waiting until official Kalshi 15m Fix Settle (No TP, $1.00 WIN / $0.00 LOSE, $0.00 exit fee),
 * deduplicate any accidental duplicate settlement exits, and recalculate all daily/bot/cash aggregates.
 */
export function reconcileHistoryToHoldSettle(state: PortfolioState): {
  state: PortfolioState;
  convertedCount: number;
  dedupedCount: number;
} {
  const botById = new Map<string, BotConfig>();
  for (const bot of state.bots) {
    botById.set(bot.id, bot);
  }

  const shouldConvertTrade = (
    botId: string | null | undefined,
    botName: string,
    explicitVariant?: StrategyVariant
  ): boolean => {
    const bot = botId ? botById.get(botId) : undefined;
    const variant = resolveStrategyVariant(botId, botName, bot?.strategy, explicitVariant);
    if (variant !== 'A') return false;
    if (bot && bot.holdToSettle === false && (bot.takeProfitCents > 0 || (bot.takeProfitTargetCents ?? 0) >= 50)) {
      return false;
    }
    return true;
  };

  // Global buy lookup in case a buy entry occurred before 00:00 WIB and settled after 00:00 WIB
  const globalBuyByKey = new Map<string, DailyTradeEntry>();
  for (const dayRec of Object.values(state.dailyHistory ?? {})) {
    for (const e of dayRec.entries) {
      if (e.action === 'buy') {
        const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
        if (!globalBuyByKey.has(key)) {
          globalBuyByKey.set(key, e);
        }
      }
    }
  }

  let convertedCount = 0;
  let dedupedCount = 0;
  const orderUpdates = new Map<string, Partial<OrderRecord>>();
  const removedOrderIds = new Set<string>();
  const removedDupSellKeys = new Map<string, number>();

  const nextDailyHistory: Record<string, DailyPnlRecord> = {};

  for (const [dateKey, dayRec] of Object.entries(state.dailyHistory ?? {})) {
    const buys = dayRec.entries.filter((e) => e.action === 'buy');
    const buyByKey = new Map<string, DailyTradeEntry>();
    for (const b of buys) {
      const key = `${b.botId ?? b.botName}::${b.ticker}::${b.side}`;
      if (!buyByKey.has(key)) {
        buyByKey.set(key, b);
      }
    }

    // Deduplicate multiple sell exits for the exact same trade key (e.g., race condition double settle)
    const seenSellKeys = new Set<string>();
    const dedupedEntries: DailyTradeEntry[] = [];
    const chronological = [...dayRec.entries].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    );
    for (const entry of chronological) {
      if (entry.action !== 'sell') {
        dedupedEntries.push(entry);
        continue;
      }
      const key = `${entry.botId ?? entry.botName}::${entry.ticker}::${entry.side}`;
      if (seenSellKeys.has(key)) {
        dedupedCount += 1;
        removedOrderIds.add(entry.id);
        removedDupSellKeys.set(key, (removedDupSellKeys.get(key) ?? 0) + 1);
        continue;
      }
      seenSellKeys.add(key);
      dedupedEntries.push(entry);
    }

    const updatedEntries: DailyTradeEntry[] = dedupedEntries.map((entry) => {
      if (entry.action !== 'sell') return entry;
      if (!shouldConvertTrade(entry.botId, entry.botName, entry.variant)) return entry;

      const key = `${entry.botId ?? entry.botName}::${entry.ticker}::${entry.side}`;
      const buyEntry = buyByKey.get(key) ?? globalBuyByKey.get(key);
      if (!buyEntry) return entry;

      const outcome = entry.settleOutcome ?? buyEntry.settleOutcome;
      if (outcome !== 'win' && outcome !== 'lose') {
        return entry;
      }

      const won = outcome === 'win';
      const settleSide: OrderSide =
        entry.settleResultSide ??
        buyEntry.settleResultSide ??
        (won ? entry.side : entry.side === 'yes' ? 'no' : 'yes');
      const payoutUsd = won ? Number(entry.contracts.toFixed(2)) : 0;
      const costBasis = calcContractCost(entry.contracts, buyEntry.priceCents);
      const roundTripNet = Number((payoutUsd - costBasis - buyEntry.feeUsd).toFixed(2));
      const isAlreadySettlement = entry.reason.includes('Settlement Kalshi');

      const mergedLowCents = entry.lowestBidCents ?? buyEntry.lowestBidCents ?? null;
      const mergedLowAt = entry.lowestBidAt ?? buyEntry.lowestBidAt ?? null;
      const mergedHighCents = entry.highestBidCents ?? buyEntry.highestBidCents ?? null;
      const mergedHighAt = entry.highestBidAt ?? buyEntry.highestBidAt ?? null;

      if (!isAlreadySettlement) {
        convertedCount += 1;
        const buyMs = Date.parse(buyEntry.createdAt);
        const settleIso = Number.isFinite(buyMs)
          ? new Date(Date.parse(getNext15mBoundaryIso(buyMs)) + 5_000).toISOString()
          : entry.createdAt;
        const bot = entry.botId ? botById.get(entry.botId) : undefined;
        const settleBotName = bot
          ? `Settle · ${bot.name}`
          : entry.botName.startsWith('Settle · ')
            ? entry.botName
            : `Settle · ${entry.botName}`;
        const settleReason = `Settlement Kalshi (${settleSide.toUpperCase()}): ${won ? 'WIN $1.00' : 'LOSS $0.00'}`;

        orderUpdates.set(entry.id, {
          botName: settleBotName,
          priceCents: won ? 99 : 1,
          feeUsd: 0,
          totalUsd: payoutUsd,
          reason: `Kontrak 15m selesai (${settleSide.toUpperCase()})`,
          createdAt: settleIso,
        });

        return {
          ...entry,
          botName: settleBotName,
          priceCents: won ? 100 : 0,
          ...(mergedLowCents !== null ? { lowestBidCents: mergedLowCents } : {}),
          ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
          ...(mergedHighCents !== null ? { highestBidCents: mergedHighCents } : {}),
          ...(mergedHighAt !== null ? { highestBidAt: mergedHighAt } : {}),
          feeUsd: 0,
          netPnlUsd: roundTripNet,
          settleOutcome: outcome,
          settleResultSide: settleSide,
          reason: settleReason,
          createdAt: settleIso,
        };
      }

      // Reconcile netPnlUsd on already-settled entries so entry fee is included consistently
      if (
        entry.netPnlUsd !== roundTripNet ||
        entry.feeUsd !== 0 ||
        entry.lowestBidCents !== mergedLowCents ||
        entry.lowestBidAt !== mergedLowAt ||
        entry.highestBidCents !== mergedHighCents ||
        entry.highestBidAt !== mergedHighAt
      ) {
        return {
          ...entry,
          ...(mergedLowCents !== null ? { lowestBidCents: mergedLowCents } : {}),
          ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
          ...(mergedHighCents !== null ? { highestBidCents: mergedHighCents } : {}),
          ...(mergedHighAt !== null ? { highestBidAt: mergedHighAt } : {}),
          feeUsd: 0,
          netPnlUsd: roundTripNet,
          settleOutcome: outcome,
          settleResultSide: settleSide,
        };
      }
      return entry;
    });

    // Sort newest first; at identical timestamps place exit (sell) above entry (buy)
    updatedEntries.sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0) return diff;
      if (a.action === b.action) return 0;
      return a.action === 'sell' ? -1 : 1;
    });

    const dayBuys = updatedEntries.filter((e) => e.action === 'buy');
    const daySells = updatedEntries.filter((e) => e.action === 'sell');
    const closedKeys = new Set(
      daySells.map((s) => `${s.botId ?? s.botName}::${s.ticker}::${s.side}`)
    );
    const openFees = dayBuys
      .filter((b) => !closedKeys.has(`${b.botId ?? b.botName}::${b.ticker}::${b.side}`))
      .reduce((sum, b) => sum + b.feeUsd, 0);
    const sellNetSum = daySells.reduce((sum, s) => sum + (s.netPnlUsd ?? 0), 0);
    const dayFeesUsd = Number(
      updatedEntries.reduce((sum, e) => sum + e.feeUsd, 0).toFixed(2)
    );
    const nextEntriesByTicker: Record<string, number> = {};
    for (const b of dayBuys) {
      nextEntriesByTicker[b.ticker] = (nextEntriesByTicker[b.ticker] ?? 0) + 1;
    }

    nextDailyHistory[dateKey] = {
      date: dayRec.date,
      realizedPnlUsd: Number((sellNetSum - openFees).toFixed(2)),
      feesUsd: dayFeesUsd,
      entriesCount: dayBuys.length,
      exitsCount: daySells.length,
      wins: daySells.filter((s) => (s.netPnlUsd ?? 0) > 0).length,
      losses: daySells.filter((s) => (s.netPnlUsd ?? 0) <= 0).length,
      entriesByTicker: nextEntriesByTicker,
      entries: updatedEntries,
    };
  }

  // Reconcile state.orders with converted exits and remove duplicate settlement sell orders
  const dupSellCounter = new Map<string, number>();
  const chronologicalOrders = [...state.orders].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  const nextOrders: OrderRecord[] = [];
  for (const ord of chronologicalOrders) {
    if (removedOrderIds.has(ord.id)) continue;
    if (ord.action === 'sell' && ord.status === 'filled') {
      const key = `${ord.botId ?? ord.botName}::${ord.ticker}::${ord.side}`;
      if (dupSellCounter.has(key) && (removedDupSellKeys.get(key) ?? 0) > 0) {
        removedDupSellKeys.set(key, (removedDupSellKeys.get(key) ?? 1) - 1);
        continue;
      }
      dupSellCounter.set(key, 1);
    }
    const patch = orderUpdates.get(ord.id);
    nextOrders.push(patch ? { ...ord, ...patch } : ord);
  }
  nextOrders.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  // Recompute cashUsd, dailyRealizedPnlUsd, and per-bot stats from reconciled dailyHistory
  const allEntries = Object.values(nextDailyHistory).flatMap((d) => d.entries);
  const totalRealizedAllDays = Object.values(nextDailyHistory).reduce(
    (sum, d) => sum + d.realizedPnlUsd,
    0
  );
  const openCostBasis = state.positions.reduce(
    (sum, pos) => sum + calcContractCost(pos.contracts, pos.avgEntryCents),
    0
  );
  const nextCashUsd = Number(
    Math.max(0, state.startingCashUsd + totalRealizedAllDays - openCostBasis).toFixed(2)
  );
  const nextDailyRealizedPnlUsd = Number(
    (nextCashUsd + openCostBasis - state.startingCashUsd).toFixed(2)
  );

  // Recompute bot tradesExecuted & realizedPnlUsd cleanly from reconciled ledger
  const botEntriesMap = new Map<string, DailyTradeEntry[]>();
  for (const e of allEntries) {
    if (!e.botId) continue;
    const list = botEntriesMap.get(e.botId);
    if (list) list.push(e);
    else botEntriesMap.set(e.botId, [e]);
  }
  const nextBots = state.bots.map((bot) => {
    const entries = botEntriesMap.get(bot.id);
    if (!entries || entries.length === 0) return bot;
    const botBuys = entries.filter((e) => e.action === 'buy');
    const botSells = entries.filter((e) => e.action === 'sell');
    const botClosedKeys = new Set(
      botSells.map((s) => `${s.botId ?? s.botName}::${s.ticker}::${s.side}`)
    );
    const botOpenFees = botBuys
      .filter((b) => !botClosedKeys.has(`${b.botId ?? b.botName}::${b.ticker}::${b.side}`))
      .reduce((sum, b) => sum + b.feeUsd, 0);
    const botSellNet = botSells.reduce((sum, s) => sum + (s.netPnlUsd ?? 0), 0);
    return {
      ...bot,
      tradesExecuted: entries.length,
      realizedPnlUsd: Number((botSellNet - botOpenFees).toFixed(2)),
    };
  });

  const filledOrdersCount = nextOrders.filter((o) => o.status === 'filled').length;

  return {
    state: {
      ...state,
      cashUsd: nextCashUsd,
      dailyRealizedPnlUsd: nextDailyRealizedPnlUsd,
      totalFilledOrders: Math.max(
        filledOrdersCount,
        (state.totalFilledOrders ?? filledOrdersCount + dedupedCount) - dedupedCount
      ),
      dailyHistory: nextDailyHistory,
      orders: nextOrders,
      bots: nextBots,
      updatedAt: new Date().toISOString(),
    },
    convertedCount,
    dedupedCount,
  };
}

/**
 * Recalculate Varian A trade history using fixed Take Profit target (default 99c):
 * - Any closed Varian A trade whose post-entry highestBidCents reached >= tpTarget
 *   is reconciled as a TP exit at tpTarget (with taker exit fee calcKalshiFee(contracts, tpTarget)),
 *   preserving underlying settleOutcome/settleResultSide and highest/lowest marks.
 * - Any closed Varian A trade that never reached tpTarget falls back to official Kalshi 15m Fix Settle.
 * - Recomputes dailyHistory, orders, cashUsd, dailyRealizedPnlUsd, and per-bot realizedPnlUsd idempotently.
 */
export function reconcileHistoryToTpTarget(
  state: PortfolioState,
  defaultTpTargetCents = 99
): {
  state: PortfolioState;
  convertedCount: number;
  dedupedCount: number;
} {
  const botById = new Map<string, BotConfig>();
  for (const bot of state.bots) {
    botById.set(bot.id, bot);
  }

  const resolveTpTargetForTrade = (
    botId: string | null | undefined,
    botName: string,
    explicitVariant?: StrategyVariant
  ): number | null => {
    const bot = botId ? botById.get(botId) : undefined;
    const variant = resolveStrategyVariant(botId, botName, bot?.strategy, explicitVariant);
    if (variant !== 'A') return null;
    if (bot) {
      if (bot.holdToSettle) return null;
      if (typeof bot.takeProfitTargetCents === 'number' && bot.takeProfitTargetCents >= 50) {
        return clampCents(bot.takeProfitTargetCents);
      }
      if (bot.takeProfitCents > 0 || bot.useTrailingStop) return null;
    }
    return clampCents(defaultTpTargetCents);
  };

  const globalBuyByKey = new Map<string, DailyTradeEntry>();
  for (const dayRec of Object.values(state.dailyHistory ?? {})) {
    for (const e of dayRec.entries) {
      if (e.action === 'buy') {
        const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
        if (!globalBuyByKey.has(key)) {
          globalBuyByKey.set(key, e);
        }
      }
    }
  }

  let convertedCount = 0;
  let dedupedCount = 0;
  const orderUpdates = new Map<string, Partial<OrderRecord>>();
  const removedOrderIds = new Set<string>();
  const removedDupSellKeys = new Map<string, number>();

  const nextDailyHistory: Record<string, DailyPnlRecord> = {};

  for (const [dateKey, dayRec] of Object.entries(state.dailyHistory ?? {})) {
    const buys = dayRec.entries.filter((e) => e.action === 'buy');
    const buyByKey = new Map<string, DailyTradeEntry>();
    for (const b of buys) {
      const key = `${b.botId ?? b.botName}::${b.ticker}::${b.side}`;
      if (!buyByKey.has(key)) {
        buyByKey.set(key, b);
      }
    }

    const seenSellKeys = new Set<string>();
    const dedupedEntries: DailyTradeEntry[] = [];
    const chronological = [...dayRec.entries].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    );
    for (const entry of chronological) {
      if (entry.action !== 'sell') {
        dedupedEntries.push(entry);
        continue;
      }
      const key = `${entry.botId ?? entry.botName}::${entry.ticker}::${entry.side}`;
      if (seenSellKeys.has(key)) {
        dedupedCount += 1;
        removedOrderIds.add(entry.id);
        removedDupSellKeys.set(key, (removedDupSellKeys.get(key) ?? 0) + 1);
        continue;
      }
      seenSellKeys.add(key);
      dedupedEntries.push(entry);
    }

    const updatedEntries: DailyTradeEntry[] = dedupedEntries.map((entry) => {
      if (entry.action !== 'sell') return entry;
      const tpTarget = resolveTpTargetForTrade(entry.botId, entry.botName, entry.variant);
      if (tpTarget === null) return entry;

      const key = `${entry.botId ?? entry.botName}::${entry.ticker}::${entry.side}`;
      const buyEntry = buyByKey.get(key) ?? globalBuyByKey.get(key);
      if (!buyEntry) return entry;

      const mergedLowCents = entry.lowestBidCents ?? buyEntry.lowestBidCents ?? null;
      const mergedLowAt = entry.lowestBidAt ?? buyEntry.lowestBidAt ?? null;
      const mergedHighCents = entry.highestBidCents ?? buyEntry.highestBidCents ?? null;
      const mergedHighAt = entry.highestBidAt ?? buyEntry.highestBidAt ?? null;

      const effectiveHigh =
        mergedHighCents ??
        (entry.reason.includes('TP Varian A') && entry.priceCents >= tpTarget ? entry.priceCents : null);

      const costBasis = calcContractCost(entry.contracts, buyEntry.priceCents);
      const bot = entry.botId ? botById.get(entry.botId) : undefined;

      if (effectiveHigh !== null && effectiveHigh >= tpTarget) {
        const exitFeeUsd = calcKalshiFee(entry.contracts, tpTarget);
        const grossProceeds = calcContractCost(entry.contracts, tpTarget);
        const netProceeds = Number((grossProceeds - exitFeeUsd).toFixed(2));
        const roundTripNet = Number((netProceeds - costBasis - buyEntry.feeUsd).toFixed(2));
        const tpReason = `TP Varian A (Target ${tpTarget}¢) tercapai @ ${tpTarget}¢`;
        const tpBotName = bot
          ? bot.name
          : entry.botName.startsWith('Settle · ')
            ? entry.botName.slice('Settle · '.length)
            : entry.botName;

        const buyMs = Date.parse(buyEntry.createdAt);
        const highMs = mergedHighAt ? Date.parse(mergedHighAt) : NaN;
        const exitIso =
          Number.isFinite(highMs) && (!Number.isFinite(buyMs) || highMs >= buyMs)
            ? new Date(highMs).toISOString()
            : entry.createdAt;

        const alreadyTpMatched =
          entry.priceCents === tpTarget &&
          entry.feeUsd === exitFeeUsd &&
          entry.netPnlUsd === roundTripNet &&
          entry.reason === tpReason &&
          entry.botName === tpBotName &&
          entry.createdAt === exitIso;

        if (!alreadyTpMatched) {
          if (entry.reason.includes('Settlement Kalshi') || entry.priceCents !== tpTarget) {
            convertedCount += 1;
          }
          orderUpdates.set(entry.id, {
            botName: tpBotName,
            priceCents: tpTarget,
            feeUsd: exitFeeUsd,
            totalUsd: netProceeds,
            reason: tpReason,
            createdAt: exitIso,
          });
          return {
            ...entry,
            botName: tpBotName,
            priceCents: tpTarget,
            ...(mergedLowCents !== null ? { lowestBidCents: mergedLowCents } : {}),
            ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
            ...(mergedHighCents !== null ? { highestBidCents: mergedHighCents } : {}),
            ...(mergedHighAt !== null ? { highestBidAt: mergedHighAt } : {}),
            feeUsd: exitFeeUsd,
            netPnlUsd: roundTripNet,
            reason: tpReason,
            createdAt: exitIso,
          };
        }

        if (
          entry.lowestBidCents !== mergedLowCents ||
          entry.lowestBidAt !== mergedLowAt ||
          entry.highestBidCents !== mergedHighCents ||
          entry.highestBidAt !== mergedHighAt
        ) {
          return {
            ...entry,
            ...(mergedLowCents !== null ? { lowestBidCents: mergedLowCents } : {}),
            ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
            ...(mergedHighCents !== null ? { highestBidCents: mergedHighCents } : {}),
            ...(mergedHighAt !== null ? { highestBidAt: mergedHighAt } : {}),
          };
        }
        return entry;
      }

      // Never touched tpTarget -> wait until official Kalshi 15m Fix Settle
      const outcome = entry.settleOutcome ?? buyEntry.settleOutcome;
      if (outcome !== 'win' && outcome !== 'lose') {
        return entry;
      }
      const won = outcome === 'win';
      const settleSide: OrderSide =
        entry.settleResultSide ??
        buyEntry.settleResultSide ??
        (won ? entry.side : entry.side === 'yes' ? 'no' : 'yes');
      const payoutUsd = won ? Number(entry.contracts.toFixed(2)) : 0;
      const roundTripNet = Number((payoutUsd - costBasis - buyEntry.feeUsd).toFixed(2));
      const isAlreadySettlement = entry.reason.includes('Settlement Kalshi');

      if (!isAlreadySettlement) {
        convertedCount += 1;
        const buyMs = Date.parse(buyEntry.createdAt);
        const settleIso = Number.isFinite(buyMs)
          ? new Date(Date.parse(getNext15mBoundaryIso(buyMs)) + 5_000).toISOString()
          : entry.createdAt;
        const settleBotName = bot
          ? `Settle · ${bot.name}`
          : entry.botName.startsWith('Settle · ')
            ? entry.botName
            : `Settle · ${entry.botName}`;
        const settleReason = `Settlement Kalshi (${settleSide.toUpperCase()}): ${won ? 'WIN $1.00' : 'LOSS $0.00'}`;

        orderUpdates.set(entry.id, {
          botName: settleBotName,
          priceCents: won ? 99 : 1,
          feeUsd: 0,
          totalUsd: payoutUsd,
          reason: `Kontrak 15m selesai (${settleSide.toUpperCase()})`,
          createdAt: settleIso,
        });

        return {
          ...entry,
          botName: settleBotName,
          priceCents: won ? 100 : 0,
          ...(mergedLowCents !== null ? { lowestBidCents: mergedLowCents } : {}),
          ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
          ...(mergedHighCents !== null ? { highestBidCents: mergedHighCents } : {}),
          ...(mergedHighAt !== null ? { highestBidAt: mergedHighAt } : {}),
          feeUsd: 0,
          netPnlUsd: roundTripNet,
          settleOutcome: outcome,
          settleResultSide: settleSide,
          reason: settleReason,
          createdAt: settleIso,
        };
      }

      if (
        entry.netPnlUsd !== roundTripNet ||
        entry.feeUsd !== 0 ||
        entry.lowestBidCents !== mergedLowCents ||
        entry.lowestBidAt !== mergedLowAt ||
        entry.highestBidCents !== mergedHighCents ||
        entry.highestBidAt !== mergedHighAt
      ) {
        return {
          ...entry,
          ...(mergedLowCents !== null ? { lowestBidCents: mergedLowCents } : {}),
          ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
          ...(mergedHighCents !== null ? { highestBidCents: mergedHighCents } : {}),
          ...(mergedHighAt !== null ? { highestBidAt: mergedHighAt } : {}),
          feeUsd: 0,
          netPnlUsd: roundTripNet,
          settleOutcome: outcome,
          settleResultSide: settleSide,
        };
      }
      return entry;
    });

    updatedEntries.sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0) return diff;
      if (a.action === b.action) return 0;
      return a.action === 'sell' ? -1 : 1;
    });

    const dayBuys = updatedEntries.filter((e) => e.action === 'buy');
    const daySells = updatedEntries.filter((e) => e.action === 'sell');
    const closedKeys = new Set(
      daySells.map((s) => `${s.botId ?? s.botName}::${s.ticker}::${s.side}`)
    );
    const openFees = dayBuys
      .filter((b) => !closedKeys.has(`${b.botId ?? b.botName}::${b.ticker}::${b.side}`))
      .reduce((sum, b) => sum + b.feeUsd, 0);
    const sellNetSum = daySells.reduce((sum, s) => sum + (s.netPnlUsd ?? 0), 0);
    const dayFeesUsd = Number(
      updatedEntries.reduce((sum, e) => sum + e.feeUsd, 0).toFixed(2)
    );
    const nextEntriesByTicker: Record<string, number> = {};
    for (const b of dayBuys) {
      nextEntriesByTicker[b.ticker] = (nextEntriesByTicker[b.ticker] ?? 0) + 1;
    }

    nextDailyHistory[dateKey] = {
      date: dayRec.date,
      realizedPnlUsd: Number((sellNetSum - openFees).toFixed(2)),
      feesUsd: dayFeesUsd,
      entriesCount: dayBuys.length,
      exitsCount: daySells.length,
      wins: daySells.filter((s) => (s.netPnlUsd ?? 0) > 0).length,
      losses: daySells.filter((s) => (s.netPnlUsd ?? 0) <= 0).length,
      entriesByTicker: nextEntriesByTicker,
      entries: updatedEntries,
    };
  }

  const dupSellCounter = new Map<string, number>();
  const chronologicalOrders = [...state.orders].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  const nextOrders: OrderRecord[] = [];
  for (const ord of chronologicalOrders) {
    if (removedOrderIds.has(ord.id)) continue;
    if (ord.action === 'sell' && ord.status === 'filled') {
      const key = `${ord.botId ?? ord.botName}::${ord.ticker}::${ord.side}`;
      if (dupSellCounter.has(key) && (removedDupSellKeys.get(key) ?? 0) > 0) {
        removedDupSellKeys.set(key, (removedDupSellKeys.get(key) ?? 1) - 1);
        continue;
      }
      dupSellCounter.set(key, 1);
    }
    const patch = orderUpdates.get(ord.id);
    nextOrders.push(patch ? { ...ord, ...patch } : ord);
  }
  nextOrders.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const allEntries = Object.values(nextDailyHistory).flatMap((d) => d.entries);
  const totalRealizedAllDays = Object.values(nextDailyHistory).reduce(
    (sum, d) => sum + d.realizedPnlUsd,
    0
  );
  const openCostBasis = state.positions.reduce(
    (sum, pos) => sum + calcContractCost(pos.contracts, pos.avgEntryCents),
    0
  );
  const nextCashUsd = Number(
    Math.max(0, state.startingCashUsd + totalRealizedAllDays - openCostBasis).toFixed(2)
  );
  const nextDailyRealizedPnlUsd = Number(
    (nextCashUsd + openCostBasis - state.startingCashUsd).toFixed(2)
  );

  const botEntriesMap = new Map<string, DailyTradeEntry[]>();
  for (const e of allEntries) {
    if (!e.botId) continue;
    const list = botEntriesMap.get(e.botId);
    if (list) list.push(e);
    else botEntriesMap.set(e.botId, [e]);
  }
  const nextBots = state.bots.map((bot) => {
    const entries = botEntriesMap.get(bot.id);
    if (!entries || entries.length === 0) return bot;
    const botBuys = entries.filter((e) => e.action === 'buy');
    const botSells = entries.filter((e) => e.action === 'sell');
    const botClosedKeys = new Set(
      botSells.map((s) => `${s.botId ?? s.botName}::${s.ticker}::${s.side}`)
    );
    const botOpenFees = botBuys
      .filter((b) => !botClosedKeys.has(`${b.botId ?? b.botName}::${b.ticker}::${b.side}`))
      .reduce((sum, b) => sum + b.feeUsd, 0);
    const botSellNet = botSells.reduce((sum, s) => sum + (s.netPnlUsd ?? 0), 0);
    return {
      ...bot,
      tradesExecuted: entries.length,
      realizedPnlUsd: Number((botSellNet - botOpenFees).toFixed(2)),
    };
  });

  const filledOrdersCount = nextOrders.filter((o) => o.status === 'filled').length;

  return {
    state: {
      ...state,
      cashUsd: nextCashUsd,
      dailyRealizedPnlUsd: nextDailyRealizedPnlUsd,
      totalFilledOrders: Math.max(
        filledOrdersCount,
        (state.totalFilledOrders ?? filledOrdersCount + dedupedCount) - dedupedCount
      ),
      dailyHistory: nextDailyHistory,
      orders: nextOrders,
      bots: nextBots,
      updatedAt: new Date().toISOString(),
    },
    convertedCount,
    dedupedCount,
  };
}



