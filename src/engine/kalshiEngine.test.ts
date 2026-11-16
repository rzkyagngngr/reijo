import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalendarMonthGrid,
  calcContractCost,
  calcKalshiFee,
  calcMaxDrawdownPct,
  calcOrderbookMetrics,
  calcPositionPnl,
  clearVariantHistoryAndPnl,
  deriveTopOfBookFromOrderbook,
  formatContractElapsedMinute,
  formatPairLabel,
  formatRemainingTime,
  getDateKeyWib,
  getNext15mBoundaryIso,
  getSeriesTicker,
  isInsideMinuteWindow,
  reconcileHistoryToHoldSettle,
  reconcileHistoryToTpTarget,
  resolveSettleOutcome,
  updateTrackedHighWithTime,
  updateTrackedLowBid,
  updateTrackedLowWithTime,
} from './kalshiMath.ts';
import {
  aggregateCandlesTo5m,
  analyze1mEntryConfirmation,
  analyzeCandlesAndPredict,
  analyzePreOpenSetup,
  detectCandlePatterns,
  parseKalshiTargetPrice,
} from './candleAnalyzer.ts';
import { evaluateBotSignal, evaluateRisingPriceMomentum, runBacktest, validateBotConfig } from './strategyEngine.ts';
import {
  buildOrderbookFromMarket,
  DEFAULT_15M_TRAILING_BOTS,
  DEFAULT_BOTS,
  DEFAULT_VARIAN_B_BOTS,
  INITIAL_PORTFOLIO_STATE,
  MARKETS_15M_SEED,
  SEED_MARKETS,
} from './seedMarkets.ts';
import type { BotConfig, KalshiMarket, OhlcCandle, PortfolioState, RiskLimits } from './types.ts';

const baseRisk: RiskLimits = {
  maxDailyLossUsd: 200,
  maxExposurePerMarketUsd: 500,
  maxOpenOrders: 16,
  killSwitchActive: false,
};

const baseBot: BotConfig = {
  id: 'bot-test',
  name: 'Test Mean Reversion',
  ticker: 'KXSILVER15M',
  strategy: 'mean_reversion',
  status: 'running',
  executionMode: 'paper',
  targetSide: 'auto',
  fairValueCents: 80,
  entryEdgeCents: 5,
  takeProfitCents: 6,
  stopLossCents: 5,
  maxContractsPerOrder: 20,
  maxPositionContracts: 60,
  maxSpreadCents: 6,
  intervalSeconds: 10,
  createdAt: '2026-11-12T00:00:00Z',
  lastRunAt: null,
  lastSignalReason: '',
  tradesExecuted: 0,
  realizedPnlUsd: 0,
};

const trailingBot: BotConfig = {
  ...DEFAULT_15M_TRAILING_BOTS[0],
  id: 'bot-trail-test',
};

const holdSettleBot: BotConfig = {
  ...trailingBot,
  id: 'bot-hold-settle-test',
  name: 'Varian A Hold Settle · BTC',
  holdToSettle: true,
  takeProfitCents: 0,
  takeProfitTargetCents: 0,
  useTrailingStop: false,
};

const tpTrailingBot: BotConfig = {
  ...trailingBot,
  id: 'bot-trail-tp-override',
  holdToSettle: false,
  takeProfitCents: 10,
  takeProfitTargetCents: 0,
  useTrailingStop: true,
};

function makeBullPred(currentYesCents = 80) {
  // Realistic healthy 5m uptrend with pullbacks (RSI ~72.6 <= 78) + matching 1m active bullish confirmation
  const diffs5m = [45, 60, -54, 66, -48, -63, 78, 72, 78, 84];
  let level5m = 68000;
  const candles5m: OhlcCandle[] = diffs5m.map((d, idx) => {
    const open = level5m;
    const close = level5m + d;
    level5m = close;
    return {
      timeSec: 1794615000 + idx * 300,
      open,
      high: Math.max(open, close) + 12,
      low: Math.min(open, close) - 12,
      close,
      volume: 100,
    };
  });

  const diffs1m = [15, 20, -18, 22, -16, -21, 26, 24, 26, 28];
  let level1m = 68150;
  const candles1m: OhlcCandle[] = diffs1m.map((d, idx) => {
    const open = level1m;
    const close = level1m + d;
    level1m = close;
    return {
      timeSec: 1794617400 + idx * 60,
      open,
      high: Math.max(open, close) + 6,
      low: Math.min(open, close) - 6,
      close,
      volume: 20,
    };
  });

  return analyzeCandlesAndPredict({
    candles: candles5m,
    candles1m,
    symbol: 'BTC/USD',
    currentYesCents,
    targetPrice: 68120,
    source: 'spot_5m',
    timeframe: '5m',
  })!;
}

function makeBearPred(currentYesCents = 20) {
  // Realistic healthy 5m downtrend with pullbacks (RSI ~27.4 >= 22) + matching 1m active bearish confirmation
  const diffs5m = [-45, -60, 54, -66, 48, 63, -78, -72, -78, -84];
  let level5m = 68500;
  const candles5m: OhlcCandle[] = diffs5m.map((d, idx) => {
    const open = level5m;
    const close = level5m + d;
    level5m = close;
    return {
      timeSec: 1794615000 + idx * 300,
      open,
      high: Math.max(open, close) + 12,
      low: Math.min(open, close) - 12,
      close,
      volume: 110,
    };
  });

  const diffs1m = [-15, -20, 18, -22, 16, 21, -26, -24, -26, -28];
  let level1m = 68350;
  const candles1m: OhlcCandle[] = diffs1m.map((d, idx) => {
    const open = level1m;
    const close = level1m + d;
    level1m = close;
    return {
      timeSec: 1794617400 + idx * 60,
      open,
      high: Math.max(open, close) + 6,
      low: Math.min(open, close) - 6,
      close,
      volume: 25,
    };
  });

  return analyzeCandlesAndPredict({
    candles: candles5m,
    candles1m,
    symbol: 'BTC/USD',
    currentYesCents,
    targetPrice: 68400,
    source: 'spot_5m',
    timeframe: '5m',
  })!;
}

test('Kalshi fee formula rounds up to nearest cent correctly', () => {
  assert.equal(calcKalshiFee(10, 50), 0.18);
  assert.equal(calcKalshiFee(100, 50), 1.75);
  assert.equal(calcKalshiFee(0, 50), 0);
});

test('Contract cost and position unrealized PnL compute accurately', () => {
  assert.equal(calcContractCost(25, 62), 15.5);
  const pnl = calcPositionPnl(
    {
      ticker: 'KXBTC15M-UP',
      marketTitle: 'Bitcoin (BTC/USD) 15-Minute Price Up',
      side: 'yes',
      contracts: 50,
      avgEntryCents: 55,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    63,
    37
  );
  assert.equal(pnl.costBasisUsd, 27.5);
  assert.equal(pnl.marketValueUsd, 31.5);
  assert.equal(pnl.unrealizedPnlUsd, 4);
});

test('Orderbook metrics derive best asks, spread, and positive imbalance', () => {
  const market = SEED_MARKETS.find((m) => m.ticker === 'KXSILVER15M')!; // yesBid 69, noBid 29 -> yesAsk 71, spread 2
  const book = buildOrderbookFromMarket(market);
  const metrics = calcOrderbookMetrics(book);
  assert.equal(metrics.bestYesBid, 69);
  assert.equal(metrics.bestYesAsk, 71);
  assert.equal(metrics.spreadCents, 2);
  assert.ok(metrics.imbalanceRatio > 0);
});

test('Mean reversion strategy triggers BUY YES when ask is below fair value by >= edge', () => {
  const market = SEED_MARKETS.find((m) => m.ticker === 'KXSILVER15M')!; // yesAsk 71
  const book = buildOrderbookFromMarket(market);
  const decision = evaluateBotSignal({
    bot: baseBot,
    market,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: Date.parse(market.closeTime) - 300_000,
  });

  assert.equal(decision.shouldTrade, true);
  assert.equal(decision.action, 'buy');
  assert.equal(decision.side, 'yes');
  assert.equal(decision.priceCents, 71);
  assert.equal(decision.contracts, 20);
});

test('Strategy triggers Take Profit sell when position gain >= takeProfitCents', () => {
  const market = SEED_MARKETS.find((m) => m.ticker === 'KXSILVER15M')!; // yesBid 69
  const book = buildOrderbookFromMarket(market);
  const decision = evaluateBotSignal({
    bot: baseBot,
    market,
    orderbook: book,
    position: {
      ticker: market.ticker,
      marketTitle: market.title,
      side: 'yes',
      contracts: 20,
      avgEntryCents: 60,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });

  assert.equal(decision.shouldTrade, true);
  assert.equal(decision.action, 'sell');
  assert.equal(decision.priceCents, 69);
});

test('Risk kill switch and daily loss guardrail block trades', () => {
  const market = SEED_MARKETS.find((m) => m.ticker === 'KXSILVER15M')!;
  const book = buildOrderbookFromMarket(market);

  const killed = evaluateBotSignal({
    bot: baseBot,
    market,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: { ...baseRisk, killSwitchActive: true },
  });
  assert.equal(killed.shouldTrade, false);
  assert.equal(killed.blockedByRisk, true);

  const lossBlocked = evaluateBotSignal({
    bot: baseBot,
    market,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: -250,
    riskLimits: baseRisk,
  });
  assert.equal(lossBlocked.shouldTrade, false);
  assert.equal(lossBlocked.blockedByRisk, true);
});

test('Varian A requires 85-91c entry, aligned candle prediction, and tight spread', () => {
  const btc15m: KalshiMarket = {
    ...MARKETS_15M_SEED[0],
    yesBid: 84,
    yesAsk: 85,
    noBid: 15,
    noAsk: 16,
    lastPrice: 85,
    previousPrice: 83,
    priceHistory: [74, 76, 78, 80, 82, 84, 85],
    candlePrediction: makeBullPred(85),
  };
  const book = buildOrderbookFromMarket(btc15m);
  const insideWindowNow = Date.parse(btc15m.closeTime) - 5 * 60_000;

  const buyDecision = evaluateBotSignal({
    bot: trailingBot,
    market: btc15m,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(buyDecision.shouldTrade, true);
  assert.equal(buyDecision.action, 'buy');
  assert.equal(buyDecision.side, 'yes');
  assert.equal(buyDecision.priceCents, 85);

  // Ask < 85c (84c) -> must NOT buy
  const below85Market: KalshiMarket = {
    ...btc15m,
    yesBid: 83,
    yesAsk: 84,
    noBid: 16,
    noAsk: 17,
  };
  const below85Decision = evaluateBotSignal({
    bot: trailingBot,
    market: below85Market,
    orderbook: buildOrderbookFromMarket(below85Market),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(below85Decision.shouldTrade, false);
  assert.ok(below85Decision.reason.includes('< min entry 85¢'));

  // Bearish candle + NO ask in 85-91c with falling YES (rising NO) -> buys NO @ 91c
  const bearMarket: KalshiMarket = {
    ...btc15m,
    yesBid: 9,
    yesAsk: 10,
    noBid: 90,
    noAsk: 91,
    lastPrice: 10,
    previousPrice: 12,
    priceHistory: [24, 22, 20, 18, 16, 14, 12, 10],
    candlePrediction: makeBearPred(10),
  };
  const bearBuy = evaluateBotSignal({
    bot: trailingBot,
    market: bearMarket,
    orderbook: buildOrderbookFromMarket(bearMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(bearBuy.shouldTrade, true);
  assert.equal(bearBuy.side, 'no');
  assert.equal(bearBuy.priceCents, 91);

  // Missing candle prediction -> must NOT buy
  const noCandleDecision = evaluateBotSignal({
    bot: trailingBot,
    market: { ...btc15m, candlePrediction: undefined },
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(noCandleDecision.shouldTrade, false);

  // Wide spread (4c > maxSpread 2c) -> must NOT buy
  const wideMarket: KalshiMarket = {
    ...btc15m,
    yesBid: 81,
    yesAsk: 85,
    noBid: 15,
    noAsk: 19,
  };
  const wideDecision = evaluateBotSignal({
    bot: trailingBot,
    market: wideMarket,
    orderbook: buildOrderbookFromMarket(wideMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 1000,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(wideDecision.shouldTrade, false);
});

test('Varian A default targets TP 99c (holds below 99c until Settle, No SL) while Hold Settle and manual TP +10c work cleanly', () => {
  const btc15m = MARKETS_15M_SEED[0];

  // Default Varian A (TP 99c): Entry 85c, bid rallies to 95c -> holds waiting for 99c or Fix Settle
  const m95: KalshiMarket = { ...btc15m, yesBid: 95, yesAsk: 96, noBid: 4, noAsk: 5, lastPrice: 95 };
  const defaultHoldAt95 = evaluateBotSignal({
    bot: trailingBot,
    market: m95,
    orderbook: buildOrderbookFromMarket(m95),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 85,
      peakBidCents: 97,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(defaultHoldAt95.shouldTrade, false);
  assert.ok(defaultHoldAt95.reason.includes('Target TP 99¢'));
  assert.ok(defaultHoldAt95.reason.includes('No SL'));

  // Explicit Hold Settle bot also holds without TP at 95c
  const explicitHold = evaluateBotSignal({
    bot: holdSettleBot,
    market: m95,
    orderbook: buildOrderbookFromMarket(m95),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 85,
      peakBidCents: 95,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(explicitHold.shouldTrade, false);
  assert.ok(explicitHold.reason.includes('Hold sampai Settle'));
  assert.ok(explicitHold.reason.includes('Tanpa TP'));

  // Entry 85c, bid crashes to 10c (-75c) -> No SL, must NOT stop out
  const m10: KalshiMarket = { ...btc15m, yesBid: 10, yesAsk: 11, noBid: 89, noAsk: 90, lastPrice: 10 };
  const noSlHold = evaluateBotSignal({
    bot: trailingBot,
    market: m10,
    orderbook: buildOrderbookFromMarket(m10),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 85,
      peakBidCents: 85,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(noSlHold.shouldTrade, false);

  // Manual override bot (holdToSettle: false, takeProfitCents: 10): bid hits 92c (+10c from 82c) -> triggers TP SELL @ 92c
  const m92: KalshiMarket = { ...btc15m, yesBid: 92, yesAsk: 93, noBid: 7, noAsk: 8, lastPrice: 92 };
  const tpExit = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m92,
    orderbook: buildOrderbookFromMarket(m92),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 82,
      peakBidCents: 92,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(tpExit.shouldTrade, true);
  assert.equal(tpExit.action, 'sell');
  assert.equal(tpExit.priceCents, 92);
  assert.ok(tpExit.reason.includes('TP Varian A (+10¢)'));
});

test('Only 15m Crypto/Commodities/Forex pairs and Varian A + Varian B 15m bots exist with $20 capital and 1 contract', () => {
  assert.equal(SEED_MARKETS.length, 15);
  assert.equal(DEFAULT_15M_TRAILING_BOTS.length, 15);
  assert.equal(DEFAULT_VARIAN_B_BOTS.length, 15);
  assert.equal(DEFAULT_BOTS.length, 30);
  assert.equal(INITIAL_PORTFOLIO_STATE.cashUsd, 20);
  assert.equal(INITIAL_PORTFOLIO_STATE.startingCashUsd, 20);
  assert.equal(INITIAL_PORTFOLIO_STATE.riskLimits.maxOpenOrders, 40);
  assert.equal(INITIAL_PORTFOLIO_STATE.orders.length, 0);
  assert.equal(INITIAL_PORTFOLIO_STATE.positions.length, 0);
  const cryptoLabels = SEED_MARKETS.filter((m) => m.category === 'Crypto').map((m) => formatPairLabel(m.ticker));
  assert.deepEqual(
    cryptoLabels.sort(),
    ['BNB', 'BTC', 'DOGE', 'ETH', 'HYPE', 'NEAR', 'SOL', 'XRP', 'ZEC']
  );
  for (const m of SEED_MARKETS) {
    assert.equal(m.timeframe, '15m');
    assert.ok(['Crypto', 'Commodities', 'Forex'].includes(m.category));
    const botA = DEFAULT_BOTS.find((b) => b.ticker === m.ticker && b.strategy === 'trailing_momentum');
    const botB = DEFAULT_BOTS.find((b) => b.ticker === m.ticker && b.strategy === 'preopen_spike');
    assert.ok(botA);
    assert.ok(botB);
    assert.equal(botA.maxContractsPerOrder, 1);
    assert.equal(botA.maxPositionContracts, 1);
    assert.equal(botA.entryTriggerCents, 85);
    assert.equal(botA.maxEntryPriceCents, 91);
    assert.equal(botA.takeProfitCents, 15);
    assert.equal(botA.takeProfitTargetCents, 99);
    assert.equal(botA.stopLossCents, 0);
    assert.equal(botA.noStopLoss, true);
    assert.equal(botA.holdToSettle, false);
    assert.equal(botA.useTrailingStop, false);
    assert.equal(botA.trailingActivationDeltaCents, 3);
    assert.equal(botA.trailingMinProfitCents, 3);
    assert.equal(botA.trailingDistanceCents, 2);
    assert.equal(botB.maxContractsPerOrder, 1);
    assert.equal(botB.maxPositionContracts, 1);
    assert.equal(botB.maxEntryPriceCents, 65);
    assert.equal(botB.takeProfitCents, 16);
    assert.equal(botB.stopLossCents, 0);
    assert.equal(botB.noStopLoss, true);
    assert.equal(botB.trailingActivationDeltaCents, 10);
    assert.equal(botB.trailingDistanceCents, 2);
    assert.equal(botB.hardCloseMinute, 6);
    assert.equal(botB.entryDelayMinSec, 5);
    assert.equal(botB.entryDelayMaxSec, 15);
  }
});

test('Backtest simulates Varian A (85-91c + Hold Settle & manual TP +10c) and mean reversion', () => {
  const trailingSeries = [62, 65, 64, 67, 70, 69, 73, 76, 75, 81, 86, 89, 92, 95, 98, 99];
  const holdSettleResult = runBacktest(
    {
      strategy: 'trailing_momentum',
      ticker: 'KXBTC15M-UP',
      fairValueCents: 85,
      entryEdgeCents: 2,
      takeProfitCents: 0,
      holdToSettle: true,
      stopLossCents: 0,
      noStopLoss: true,
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      minCandleConfidence: 58,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    trailingSeries
  );
  assert.ok(holdSettleResult.totalTrades >= 1);
  assert.ok(holdSettleResult.trades.every((t) => t.action !== 'buy' || (t.priceCents >= 85 && t.priceCents <= 91)));
  assert.ok(holdSettleResult.trades.some((t) => t.action === 'sell' && t.reason.includes('Hold sampai Settle')));
  assert.equal(holdSettleResult.winRatePct, 100);
  assert.ok(holdSettleResult.finalEquityUsd > 20);

  const trResult = runBacktest(
    {
      strategy: 'trailing_momentum',
      ticker: 'KXBTC15M-UP',
      fairValueCents: 85,
      entryEdgeCents: 2,
      takeProfitCents: 10,
      holdToSettle: false,
      stopLossCents: 0,
      noStopLoss: true,
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      minCandleConfidence: 58,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    trailingSeries
  );
  assert.ok(trResult.totalTrades >= 1);
  assert.ok(trResult.trades.every((t) => t.action !== 'buy' || (t.priceCents >= 85 && t.priceCents <= 91)));
  assert.equal(trResult.winRatePct, 100);
  assert.ok(trResult.finalEquityUsd > 20);

  const series = [50, 44, 41, 46, 52, 58, 55, 43, 49, 55];
  const result = runBacktest(
    {
      strategy: 'mean_reversion',
      ticker: 'KXXAG15M-UP',
      fairValueCents: 52,
      entryEdgeCents: 6,
      takeProfitCents: 8,
      stopLossCents: 6,
      contractsPerTrade: 50,
      initialCapitalUsd: 1000,
    },
    series
  );

  assert.equal(result.equityCurve.length, series.length);
  assert.ok(result.totalTrades >= 1);
  assert.ok(result.finalEquityUsd > 1000);
  assert.equal(calcMaxDrawdownPct([1000, 900, 950, 1100]), 10);
});

test('Bot config validation rejects invalid inputs including Varian A parameters', () => {
  assert.ok(validateBotConfig({ name: 'A', ticker: 'KX' }) !== null);
  assert.ok(validateBotConfig({ name: 'Valid Bot', ticker: 'KXBTC15M-UP', fairValueCents: 105 }) !== null);
  assert.ok(
    validateBotConfig({
      name: 'Invalid Var A MinEntry',
      ticker: 'KXBTC15M-UP',
      strategy: 'trailing_momentum',
      entryTriggerCents: 40,
      takeProfitCents: 0,
      holdToSettle: true,
      noStopLoss: true,
    }) !== null
  );
  assert.ok(
    validateBotConfig({
      name: 'Invalid Var A MaxBelowMin',
      ticker: 'KXBTC15M-UP',
      strategy: 'trailing_momentum',
      entryTriggerCents: 85,
      maxEntryPriceCents: 83,
      takeProfitCents: 0,
      holdToSettle: true,
      noStopLoss: true,
    }) !== null
  );
  assert.equal(
    validateBotConfig({
      name: 'Valid Varian A Hold Settle',
      ticker: 'KXBTC15M-UP',
      strategy: 'trailing_momentum',
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      takeProfitCents: 0,
      holdToSettle: true,
      noStopLoss: true,
      stopLossCents: 0,
      minCandleConfidence: 60,
      maxContractsPerOrder: 1,
      maxPositionContracts: 1,
    }),
    null
  );
  assert.equal(
    validateBotConfig({
      name: 'Valid Varian A Manual TP',
      ticker: 'KXBTC15M-UP',
      strategy: 'trailing_momentum',
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      takeProfitCents: 10,
      holdToSettle: false,
      noStopLoss: true,
      stopLossCents: 0,
      minCandleConfidence: 60,
      maxContractsPerOrder: 1,
      maxPositionContracts: 1,
    }),
    null
  );
});

test('15m boundary and remaining time formatter compute exact MM:SS countdown', () => {
  const sampleNow = Date.parse('2026-11-12T22:18:30Z');
  const nextClose = getNext15mBoundaryIso(sampleNow);
  assert.equal(nextClose, '2026-11-12T22:30:00.000Z');

  const rem = formatRemainingTime(nextClose, sampleNow);
  assert.equal(rem.formatted, '11:30');
  assert.equal(rem.isExpiringSoon, false);

  const urgent = formatRemainingTime(nextClose, Date.parse('2026-11-12T22:28:45Z'));
  assert.equal(urgent.formatted, '01:15');
  assert.equal(urgent.isExpiringSoon, true);
});

test('Varian A rejects Ask > 91c (e.g. 92c, 94c) and Neutral candle, enters at 91c with TP capped at 99c ceiling', () => {
  const btc15m = MARKETS_15M_SEED[0];
  const insideWindowNow = Date.parse(btc15m.closeTime) - 5 * 60_000;

  // Ask 92c (> 91c max entry cap) -> must NOT buy
  const ask92Market: KalshiMarket = {
    ...btc15m,
    yesBid: 91,
    yesAsk: 92,
    noBid: 8,
    noAsk: 9,
    lastPrice: 92,
    priceHistory: [78, 80, 83, 86, 89, 92],
    candlePrediction: makeBullPred(91),
  };
  const ask92Decision = evaluateBotSignal({
    bot: trailingBot,
    market: ask92Market,
    orderbook: buildOrderbookFromMarket(ask92Market),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(ask92Decision.shouldTrade, false);
  assert.ok(ask92Decision.reason.includes('91¢'));

  // Ask 94c -> must NOT buy
  const ask94Market: KalshiMarket = {
    ...btc15m,
    yesBid: 93,
    yesAsk: 94,
    noBid: 6,
    noAsk: 7,
    lastPrice: 94,
    priceHistory: [80, 84, 88, 91, 94],
    candlePrediction: makeBullPred(93),
  };
  const ask94Decision = evaluateBotSignal({
    bot: trailingBot,
    market: ask94Market,
    orderbook: buildOrderbookFromMarket(ask94Market),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(ask94Decision.shouldTrade, false);

  // Neutral candle -> must NOT buy
  const neutralMarket: KalshiMarket = {
    ...btc15m,
    yesBid: 86,
    yesAsk: 87,
    noBid: 13,
    noAsk: 14,
    candlePrediction: {
      ...makeBullPred(87),
      direction: 'NEUTRAL',
      predictedSide: 'neutral',
      confidencePct: 52,
    },
  };
  const neutralDecision = evaluateBotSignal({
    bot: trailingBot,
    market: neutralMarket,
    orderbook: buildOrderbookFromMarket(neutralMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(neutralDecision.shouldTrade, false);

  // Ask 91c + Bullish candle + rising YES -> enters BUY YES @ 91c (at exact max cap)
  const entry91Market: KalshiMarket = {
    ...btc15m,
    yesBid: 90,
    yesAsk: 91,
    noBid: 9,
    noAsk: 10,
    lastPrice: 91,
    previousPrice: 89,
    priceHistory: [77, 80, 82, 85, 87, 89, 91],
    candlePrediction: makeBullPred(91),
  };
  const buy91 = evaluateBotSignal({
    bot: trailingBot,
    market: entry91Market,
    orderbook: buildOrderbookFromMarket(entry91Market),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(buy91.shouldTrade, true);
  assert.equal(buy91.action, 'buy');
  assert.equal(buy91.priceCents, 91);

  // Default Varian A (TP 99c): at 99c immediately triggers TP SELL @ 99c
  const m99: KalshiMarket = { ...btc15m, yesBid: 99, yesAsk: 99, noBid: 1, noAsk: 1, lastPrice: 99 };
  const sellAt99Default = evaluateBotSignal({
    bot: trailingBot,
    market: m99,
    orderbook: buildOrderbookFromMarket(m99),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 86,
      peakBidCents: 99,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(sellAt99Default.shouldTrade, true);
  assert.equal(sellAt99Default.action, 'sell');
  assert.equal(sellAt99Default.priceCents, 99);
  assert.ok(sellAt99Default.reason.includes('TP Varian A (99¢)'));

  // Explicit Hold Settle bot: at 99c holds until settlement
  const holdAt99 = evaluateBotSignal({
    bot: holdSettleBot,
    market: m99,
    orderbook: buildOrderbookFromMarket(m99),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 91,
      peakBidCents: 99,
      trailingActivated: true,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(holdAt99.shouldTrade, false);
  assert.ok(holdAt99.reason.includes('Hold sampai Settle'));

  // Manual TP override exits at Kalshi 99c ceiling when entry was 91c (+8c capped TP, does not get stuck waiting for 101c)
  const tp99Exit = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m99,
    orderbook: buildOrderbookFromMarket(m99),
    position: {
      ticker: btc15m.ticker,
      marketTitle: btc15m.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 91,
      peakBidCents: 99,
      trailingActivated: true,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(tp99Exit.shouldTrade, true);
  assert.equal(tp99Exit.action, 'sell');
  assert.equal(tp99Exit.priceCents, 99);
  assert.ok(tp99Exit.reason.includes('TP Varian A'));
  const netProfitUsd =
    calcContractCost(1, 99) -
    calcContractCost(1, 91) -
    calcKalshiFee(1, 91) -
    calcKalshiFee(1, 99);
  assert.ok(netProfitUsd > 0);
});

test('Backtest realized PnL per trade sums cleanly to finalEquity - initialCapital including entry & exit fees', () => {
  const series = [64, 66, 68, 70, 72, 74, 76, 78, 82, 86, 89, 93, 97, 99];
  const res = runBacktest(
    {
      strategy: 'trailing_momentum',
      ticker: 'KXBTC15M-UP',
      fairValueCents: 85,
      entryEdgeCents: 2,
      takeProfitCents: 10,
      stopLossCents: 0,
      noStopLoss: true,
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      minCandleConfidence: 58,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    series
  );

  const sumTradePnl = Number(
    res.trades.filter((t) => t.action === 'sell').reduce((s, t) => s + t.pnlUsd, 0).toFixed(2)
  );
  const equityDelta = Number((res.finalEquityUsd - 20).toFixed(2));
  assert.equal(sumTradePnl, equityDelta);
});

test('getDateKeyWib groups UTC timestamps accurately into Asia/Jakarta YYYY-MM-DD', () => {
  // 2026-11-12T17:30:00Z is 2026-11-13 00:30:00 WIB (UTC+7)
  assert.equal(getDateKeyWib('2026-11-12T17:30:00.000Z'), '2026-11-13');
  assert.equal(getDateKeyWib('2026-11-12T16:30:00.000Z'), '2026-11-12');
});

test('formatPairLabel and getSeriesTicker handle live dynamic Kalshi 15m tickers cleanly', () => {
  assert.equal(formatPairLabel('KXBTC15M-26NOV131045-45'), 'BTC');
  assert.equal(formatPairLabel('KXBNB15M-26NOV131045-45'), 'BNB');
  assert.equal(formatPairLabel('KXDOGE15M-26NOV131045-45'), 'DOGE');
  assert.equal(formatPairLabel('KXHYPE15M-26NOV131045-45'), 'HYPE');
  assert.equal(formatPairLabel('KXNEAR15M-26NOV131045-45'), 'NEAR');
  assert.equal(formatPairLabel('KXXRP15M-26NOV131045-45'), 'XRP');
  assert.equal(formatPairLabel('KXZEC15M-26NOV131045-45'), 'ZEC');
  assert.equal(formatPairLabel('KXWTI15M-26NOV131045-45'), 'WTI');
  assert.equal(formatPairLabel('KXGOLD15M-26NOV131045-45'), 'Gold');
  assert.equal(formatPairLabel('KXSILVER15M-26NOV131045-45'), 'Silver');
  assert.equal(formatPairLabel('KXEURUSD15M-26NOV131045-30'), 'EUR/USD');
  assert.equal(formatPairLabel('KXUSDJPY15M-26NOV131045-30'), 'USD/JPY');
  assert.equal(getSeriesTicker('KXBNB15M-26NOV131045-45'), 'KXBNB15M');
  assert.equal(getSeriesTicker('KXDOGE15M-26NOV131045-45'), 'KXDOGE15M');
  assert.equal(getSeriesTicker('KXHYPE15M-26NOV131045-45'), 'KXHYPE15M');
  assert.equal(getSeriesTicker('KXNEAR15M-26NOV131045-45'), 'KXNEAR15M');
  assert.equal(getSeriesTicker('KXXRP15M-26NOV131045-45'), 'KXXRP15M');
  assert.equal(getSeriesTicker('KXZEC15M-26NOV131045-45'), 'KXZEC15M');
  assert.equal(getSeriesTicker('KXGOLD15M-26NOV131045-45'), 'KXGOLD15M');
  assert.equal(getSeriesTicker('KXSILVER15M-26NOV131045-45'), 'KXSILVER15M');
});

test('Entry window restricts new buys to minutes 7:00–13:00 while allowing exits anytime', () => {
  const btc: KalshiMarket = {
    ...MARKETS_15M_SEED[0],
    yesBid: 84,
    yesAsk: 85,
    noBid: 15,
    noAsk: 16,
    lastPrice: 85,
    previousPrice: 83,
    priceHistory: [74, 76, 78, 80, 82, 84, 85],
    candlePrediction: makeBullPred(85),
  };
  const closeMs = Date.parse(btc.closeTime);
  const openMs = closeMs - 15 * 60_000;
  const book = buildOrderbookFromMarket(btc);

  // Minute 04:00 (< 07:00) must NOT enter
  const tooEarly = evaluateBotSignal({
    bot: trailingBot,
    market: btc,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 4 * 60_000,
  });
  assert.equal(tooEarly.shouldTrade, false);
  assert.ok(tooEarly.reason.includes('07:00–13:00'));

  // Minute 07:00 (start boundary) MUST allow entry
  const atMin7 = evaluateBotSignal({
    bot: trailingBot,
    market: btc,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 7 * 60_000,
  });
  assert.equal(atMin7.shouldTrade, true);
  assert.equal(atMin7.action, 'buy');

  // Minute 13:00 (end boundary) MUST allow entry
  const atMin13 = evaluateBotSignal({
    bot: trailingBot,
    market: btc,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 13 * 60_000,
  });
  assert.equal(atMin13.shouldTrade, true);
  assert.equal(atMin13.action, 'buy');

  // Minute 13:30 (> 13:00) must NOT enter
  const tooLate = evaluateBotSignal({
    bot: trailingBot,
    market: btc,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 13 * 60_000 + 30_000,
  });
  assert.equal(tooLate.shouldTrade, false);
  assert.ok(tooLate.reason.includes('13:00'));

  // Open position at 95c holds under TP 99c waiting for 99c or Settle, and still exits under manual +10c TP override even at minute 14:30
  const tpMarket: KalshiMarket = { ...btc, yesBid: 95, yesAsk: 96, noBid: 4, noAsk: 5, lastPrice: 95 };
  const defaultHoldAt1430 = evaluateBotSignal({
    bot: trailingBot,
    market: tpMarket,
    orderbook: buildOrderbookFromMarket(tpMarket),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 85,
      peakBidCents: 95,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 14 * 60_000 + 30_000,
  });
  assert.equal(defaultHoldAt1430.shouldTrade, false);

  const exitAllowed = evaluateBotSignal({
    bot: tpTrailingBot,
    market: tpMarket,
    orderbook: buildOrderbookFromMarket(tpMarket),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 85,
      peakBidCents: 95,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 14 * 60_000 + 30_000,
  });
  assert.equal(exitAllowed.shouldTrade, true);
  assert.equal(exitAllowed.action, 'sell');
});

test('Max 1x trade per pair blocks second entry on same 15m contract while allowing Hold Settle / manual TP', () => {
  const btc: KalshiMarket = {
    ...MARKETS_15M_SEED[0],
    yesBid: 84,
    yesAsk: 85,
    noBid: 15,
    noAsk: 16,
    lastPrice: 85,
    priceHistory: [74, 76, 78, 80, 82, 84, 85],
    candlePrediction: makeBullPred(85),
  };
  const closeMs = Date.parse(btc.closeTime);
  const insideWindowNow = closeMs - 5 * 60_000; // minute 10:00
  const book = buildOrderbookFromMarket(btc);

  const reEntryBlocked = evaluateBotSignal({
    bot: trailingBot,
    market: btc,
    orderbook: book,
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
    hasTradedCurrentMarket: true,
  });
  assert.equal(reEntryBlocked.shouldTrade, false);
  assert.ok(reEntryBlocked.reason.includes('1x'));

  // Holding open position with hasTradedCurrentMarket=true holds on dip (No SL)
  const holdDipMarket: KalshiMarket = { ...btc, yesBid: 50, yesAsk: 51, noBid: 49, noAsk: 50, lastPrice: 50 };
  const holdsAt50 = evaluateBotSignal({
    bot: trailingBot,
    market: holdDipMarket,
    orderbook: buildOrderbookFromMarket(holdDipMarket),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 80,
      peakBidCents: 80,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
    hasTradedCurrentMarket: true,
  });
  assert.equal(holdsAt50.shouldTrade, false);

  // Manual TP +10c (90c) still exits cleanly
  const tp90Market: KalshiMarket = { ...btc, yesBid: 90, yesAsk: 91, noBid: 9, noAsk: 10, lastPrice: 90 };
  const exitStillWorks = evaluateBotSignal({
    bot: tpTrailingBot,
    market: tp90Market,
    orderbook: buildOrderbookFromMarket(tp90Market),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 80,
      peakBidCents: 90,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
    hasTradedCurrentMarket: true,
  });
  assert.equal(exitStillWorks.shouldTrade, true);
  assert.equal(exitStillWorks.action, 'sell');
  assert.equal(exitStillWorks.priceCents, 90);
  assert.ok(exitStillWorks.reason.includes('TP Varian A'));
});

test('resolveSettleOutcome and updatedLowBidCents track contract settlement and lowest trade bid', () => {
  assert.deepEqual(resolveSettleOutcome('yes', 'yes'), { outcome: 'win', resultSide: 'yes' });
  assert.deepEqual(resolveSettleOutcome('yes', 'no'), { outcome: 'lose', resultSide: 'no' });
  assert.deepEqual(resolveSettleOutcome('no', 'no'), { outcome: 'win', resultSide: 'no' });
  assert.deepEqual(resolveSettleOutcome('yes', ''), { outcome: 'pending' });
  assert.deepEqual(resolveSettleOutcome('no', undefined), { outcome: 'pending' });

  const btc = MARKETS_15M_SEED[0];
  const min10Ms = Date.parse(btc.closeTime) - 5 * 60_000;
  const dippedMarket: KalshiMarket = { ...btc, yesBid: 72, yesAsk: 74, noBid: 26, noAsk: 28, lastPrice: 73 };
  const holdDip = evaluateBotSignal({
    bot: trailingBot,
    market: dippedMarket,
    orderbook: buildOrderbookFromMarket(dippedMarket),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 80,
      peakBidCents: 80,
      lowestBidCents: 76,
      trailingActivated: false,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min10Ms,
  });
  assert.equal(holdDip.shouldTrade, false);
  assert.equal(holdDip.updatedLowBidCents, 72);

  // Even if price recovers to 90c, lowestBidCents preserves the 72c low watermark in Hold Settle AND TP modes
  const tpMarket: KalshiMarket = { ...btc, yesBid: 90, yesAsk: 91, noBid: 9, noAsk: 10, lastPrice: 90 };
  const holdAfterDip = evaluateBotSignal({
    bot: trailingBot,
    market: tpMarket,
    orderbook: buildOrderbookFromMarket(tpMarket),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 80,
      peakBidCents: 88,
      lowestBidCents: 72,
      trailingActivated: true,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min10Ms + 60_000,
  });
  assert.equal(holdAfterDip.shouldTrade, false);
  assert.equal(holdAfterDip.updatedLowBidCents, 72);

  const tpAfterDip = evaluateBotSignal({
    bot: tpTrailingBot,
    market: tpMarket,
    orderbook: buildOrderbookFromMarket(tpMarket),
    position: {
      ticker: btc.ticker,
      marketTitle: btc.title,
      side: 'yes',
      contracts: 1,
      avgEntryCents: 80,
      peakBidCents: 88,
      lowestBidCents: 72,
      trailingActivated: true,
      realizedPnlUsd: 0,
      updatedAt: '2026-11-12T00:00:00Z',
    },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min10Ms + 60_000,
  });
  assert.equal(tpAfterDip.shouldTrade, true);
  assert.equal(tpAfterDip.action, 'sell');
  assert.equal(tpAfterDip.updatedLowBidCents, 72);
});

test('updateTrackedLowBid monitors 7-13m continuously and freezes outside minutes 7-13', () => {
  const closeIso = '2026-11-13T18:00:00.000Z'; // open at 17:45:00Z
  const openMs = Date.parse(closeIso) - 15 * 60_000;

  assert.equal(isInsideMinuteWindow(closeIso, openMs + 6 * 60_000, 7, 13), false);
  assert.equal(isInsideMinuteWindow(closeIso, openMs + 7 * 60_000, 7, 13), true);
  assert.equal(isInsideMinuteWindow(closeIso, openMs + 13 * 60_000, 7, 13), true);
  assert.equal(isInsideMinuteWindow(closeIso, openMs + 13 * 60_000 + 1000, 7, 13), false);

  // Entry at 80c, exited at SL 65c at min 09:00, continues dropping to 42c at min 11:30 -> tracks 42c
  let low: number | null | undefined = 80;
  low = updateTrackedLowBid(low, 65, closeIso, openMs + 9 * 60_000);
  assert.equal(low, 65);
  low = updateTrackedLowBid(low, 42, closeIso, openMs + 11 * 60_000 + 30_000);
  assert.equal(low, 42);
  // Recovery to 86c at min 12:30 keeps low at 42c
  low = updateTrackedLowBid(low, 86, closeIso, openMs + 12 * 60_000 + 30_000);
  assert.equal(low, 42);
  // Drop to 10c at min 14:20 (> 13:00) does NOT overwrite 7-13m low
  low = updateTrackedLowBid(low, 10, closeIso, openMs + 14 * 60_000 + 20_000);
  assert.equal(low, 42);
});

test('Varian A default uses TP 99c (takeProfitTargetCents: 99) + No SL while Hold Settle & optional explicit SL still work', () => {
  const defaultVarA = DEFAULT_15M_TRAILING_BOTS[0];
  assert.equal(defaultVarA.holdToSettle, false);
  assert.equal(defaultVarA.useTrailingStop, false);
  assert.equal(defaultVarA.noStopLoss, true);
  assert.equal(defaultVarA.stopLossCents, 0);
  assert.equal(defaultVarA.takeProfitTargetCents, 99);
  assert.equal(defaultVarA.takeProfitCents, 15);

  const holdBot: BotConfig = {
    ...defaultVarA,
    holdToSettle: true,
    noStopLoss: false,
    stopLossCents: 70,
  };

  const btc = MARKETS_15M_SEED[0];
  const min11Ms = Date.parse(btc.closeTime) - 4 * 60_000;
  const openPos = {
    ticker: btc.ticker,
    marketTitle: btc.title,
    side: 'yes' as const,
    contracts: 1,
    avgEntryCents: 80,
    peakBidCents: 80,
    lowestBidCents: 80,
    trailingActivated: false,
    realizedPnlUsd: 0,
    updatedAt: '2026-11-13T00:00:00Z',
  };

  // Explicit holdBot rallies to 95c -> holds for Settle
  const rallyMarket: KalshiMarket = { ...btc, yesBid: 95, yesAsk: 96, noBid: 4, noAsk: 5, lastPrice: 95 };
  const holdRally = evaluateBotSignal({
    bot: holdBot,
    market: rallyMarket,
    orderbook: buildOrderbookFromMarket(rallyMarket),
    position: openPos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min11Ms,
  });
  assert.equal(holdRally.shouldTrade, false);
  assert.ok(holdRally.reason.includes('Hold sampai Settle'));

  // Default Varian A crashes to 10c -> holds (No SL)
  const crash10Market: KalshiMarket = { ...btc, yesBid: 10, yesAsk: 11, noBid: 89, noAsk: 90, lastPrice: 10 };
  const defaultNoSl = evaluateBotSignal({
    bot: defaultVarA,
    market: crash10Market,
    orderbook: buildOrderbookFromMarket(crash10Market),
    position: openPos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min11Ms + 60_000,
  });
  assert.equal(defaultNoSl.shouldTrade, false);

  // Explicit holdBot crashes to 10c -> triggers Hard Stop Loss SELL @ 10c
  const sl10 = evaluateBotSignal({
    bot: holdBot,
    market: crash10Market,
    orderbook: buildOrderbookFromMarket(crash10Market),
    position: openPos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min11Ms + 60_000,
  });
  assert.equal(sl10.shouldTrade, true);
  assert.equal(sl10.action, 'sell');
  assert.equal(sl10.priceCents, 10);
  assert.ok(sl10.reason.includes('Hard Stop Loss'));

  // Empty YES bids while NO side has bids still evaluates bestYesBid = 1c
  const emptyYesMetrics = calcOrderbookMetrics({
    ticker: btc.ticker,
    yesBids: [],
    noBids: [{ price: 98, quantity: 500 }],
    updatedAt: '2026-11-13T00:00:00Z',
  });
  assert.equal(emptyYesMetrics.bestYesBid, 1);
});

test('parseKalshiTargetPrice extracts crypto and forex target prices accurately', () => {
  assert.equal(parseKalshiTargetPrice('Target Price: $68,252.69 · Kalshi Live 15m'), 68252.69);
  assert.equal(parseKalshiTargetPrice('Target Price: 1.0542'), 1.0542);
  assert.equal(parseKalshiTargetPrice('Kalshi Exchange Live'), null);
});

test('analyzeCandlesAndPredict detects bullish engulfing + upward trend and projects higher price', () => {
  const baseTs = 1794616000;
  const bullCandles: OhlcCandle[] = [
    { timeSec: baseTs + 60, open: 68100, high: 68120, low: 68090, close: 68115, volume: 10 },
    { timeSec: baseTs + 120, open: 68115, high: 68135, low: 68110, close: 68130, volume: 12 },
    { timeSec: baseTs + 180, open: 68130, high: 68150, low: 68125, close: 68145, volume: 15 },
    { timeSec: baseTs + 240, open: 68145, high: 68165, low: 68140, close: 68160, volume: 14 },
    { timeSec: baseTs + 300, open: 68160, high: 68180, low: 68155, close: 68175, volume: 16 },
    { timeSec: baseTs + 360, open: 68185, high: 68190, low: 68160, close: 68165, volume: 18 }, // small red pullback
    { timeSec: baseTs + 420, open: 68162, high: 68240, low: 68160, close: 68235, volume: 32 }, // bullish engulfing
  ];
  const pat = detectCandlePatterns(bullCandles);
  assert.ok(pat.patterns.includes('Bullish Engulfing'));

  const pred = analyzeCandlesAndPredict({
    candles: bullCandles,
    symbol: 'BTC/USD',
    currentYesCents: 78,
    targetPrice: 68180,
    source: 'spot_1m',
  });
  assert.ok(pred);
  assert.equal(pred.direction, 'BULLISH');
  assert.equal(pred.predictedSide, 'yes');
  assert.ok(pred.confidencePct >= 65);
  assert.ok(pred.predictedPrice > pred.currentPrice);
  assert.ok(pred.predictedYesCents > 78);
});

test('candle_prediction strategy enters BUY YES when bullish confidence meets threshold', () => {
  const btc = MARKETS_15M_SEED[0];
  const min10Ms = Date.parse(btc.closeTime) - 5 * 60_000;
  const pred = makeBullPred(76);

  const market: KalshiMarket = {
    ...btc,
    yesBid: 75,
    yesAsk: 76,
    noBid: 24,
    noAsk: 25,
    lastPrice: 76,
    previousPrice: 74,
    priceHistory: [64, 66, 68, 70, 72, 74, 76],
    candlePrediction: pred,
    source: 'kalshi_live',
  };
  const candleBot: BotConfig = {
    ...DEFAULT_15M_TRAILING_BOTS[0],
    id: 'bot-candle-test',
    strategy: 'candle_prediction',
    minCandleConfidence: 60,
    holdToSettle: true,
    stopLossCents: 70,
  };
  const decision = evaluateBotSignal({
    bot: candleBot,
    market,
    orderbook: buildOrderbookFromMarket(market),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min10Ms,
  });
  assert.equal(decision.shouldTrade, true);
  assert.equal(decision.action, 'buy');
  assert.equal(decision.side, 'yes');
  assert.ok(decision.reason.includes('Baca Candle 5m BULLISH'));
});

test('Varian A requires candle direction aligned with entry side (blocks BUY YES when BEARISH)', () => {
  const btc = MARKETS_15M_SEED[0];
  const min10Ms = Date.parse(btc.closeTime) - 5 * 60_000;
  const bearPred = makeBearPred(80);
  assert.equal(bearPred.direction, 'BEARISH');

  const market: KalshiMarket = {
    ...btc,
    yesBid: 79,
    yesAsk: 80,
    noBid: 20,
    noAsk: 21,
    lastPrice: 80,
    candlePrediction: bearPred,
    source: 'kalshi_live',
  };
  // BEARISH prediction tries NO @ 21c which is < 85c min entry -> does NOT buy YES or NO
  const decision = evaluateBotSignal({
    bot: DEFAULT_15M_TRAILING_BOTS[0],
    market,
    orderbook: buildOrderbookFromMarket(market),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: min10Ms,
  });
  assert.equal(decision.shouldTrade, false);
  assert.ok(decision.reason.includes('< min entry 85¢'));
});

test('analyzePreOpenSetup boosts fresh pre-open momentum with volume spike and penalizes overbought RSI > 78', () => {
  const baseTs = 1794616000;
  // Fresh bullish pre-open setup with mild pullback then strong volume spike candle
  const freshCandles: OhlcCandle[] = [
    { timeSec: baseTs + 60, open: 68100, high: 68115, low: 68090, close: 68105, volume: 10 },
    { timeSec: baseTs + 120, open: 68105, high: 68118, low: 68095, close: 68100, volume: 11 },
    { timeSec: baseTs + 180, open: 68100, high: 68122, low: 68098, close: 68115, volume: 12 },
    { timeSec: baseTs + 240, open: 68115, high: 68125, low: 68102, close: 68108, volume: 11 },
    { timeSec: baseTs + 300, open: 68108, high: 68130, low: 68105, close: 68122, volume: 12 },
    { timeSec: baseTs + 360, open: 68125, high: 68128, low: 68110, close: 68114, volume: 11 },
    { timeSec: baseTs + 420, open: 68112, high: 68170, low: 68110, close: 68168, volume: 40 },
  ];
  const freshSetup = analyzePreOpenSetup(freshCandles, 'BTC/USD', 52, 'spot_1m');
  assert.ok(freshSetup);
  assert.equal(freshSetup.direction, 'BULLISH');
  assert.ok(freshSetup.confidencePct >= 62);
  assert.ok(freshSetup.patterns.includes('Volume Spike Pre-Open'));

  // Extreme RSI > 78 overbought exhaustion must be penalized vs raw base prediction
  const overboughtCandles: OhlcCandle[] = Array.from({ length: 14 }, (_, idx) => ({
    timeSec: baseTs + idx * 60,
    open: 68000 + idx * 45,
    high: 68050 + idx * 45,
    low: 67998 + idx * 45,
    close: 68048 + idx * 45,
    volume: 20,
  }));
  const rawPred = analyzeCandlesAndPredict({
    candles: overboughtCandles,
    symbol: 'BTC/USD',
    currentYesCents: 55,
    source: 'spot_1m',
  })!;
  const preOpenOverbought = analyzePreOpenSetup(overboughtCandles, 'BTC/USD', 55, 'spot_1m')!;
  assert.ok(rawPred.rsi > 78);
  assert.ok(preOpenOverbought.bullishScore < rawPred.bullishScore);
  assert.ok(preOpenOverbought.patterns.some((p) => p.includes('Jenuh Beli')));
});

test('Varian B preopen_spike enforces 5-15s safe entry wait, 65c max entry cap, and post-open reversal guard', () => {
  const btc = MARKETS_15M_SEED[0];
  const closeMs = Date.parse(btc.closeTime);
  const openMs = closeMs - 15 * 60_000;
  const varBBot: BotConfig = {
    ...DEFAULT_VARIAN_B_BOTS[0],
  };

  const bullPreOpen = analyzePreOpenSetup(
    [
      { timeSec: 1794616060, open: 68100, high: 68115, low: 68090, close: 68105, volume: 10 },
      { timeSec: 1794616120, open: 68105, high: 68118, low: 68095, close: 68100, volume: 11 },
      { timeSec: 1794616180, open: 68100, high: 68122, low: 68098, close: 68115, volume: 12 },
      { timeSec: 1794616240, open: 68115, high: 68125, low: 68102, close: 68108, volume: 11 },
      { timeSec: 1794616300, open: 68108, high: 68130, low: 68105, close: 68122, volume: 12 },
      { timeSec: 1794616360, open: 68125, high: 68128, low: 68110, close: 68114, volume: 11 },
      { timeSec: 1794616420, open: 68112, high: 68170, low: 68110, close: 68168, volume: 40 },
    ],
    'BTC/USD',
    52,
    'spot_1m'
  )!;

  const tightMarket64: KalshiMarket = {
    ...btc,
    yesBid: 62,
    yesAsk: 64,
    noBid: 36,
    noAsk: 38,
    lastPrice: 63,
    preOpenPrediction: bullPreOpen,
    source: 'kalshi_live',
  };

  // 1. At 00:02 (< 5s): must wait
  const at2s = evaluateBotSignal({
    bot: varBBot,
    market: tightMarket64,
    orderbook: buildOrderbookFromMarket(tightMarket64),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 2_000,
  });
  assert.equal(at2s.shouldTrade, false);
  assert.ok(at2s.reason.includes('jeda aman'));

  // 2. At 00:08 with wide spread (3c > 2c): must wait up to 15s for spread stabilization
  const wideOpenMarket: KalshiMarket = {
    ...tightMarket64,
    yesBid: 61,
    yesAsk: 64,
    noBid: 36,
    noAsk: 39,
  };
  const at8sWide = evaluateBotSignal({
    bot: varBBot,
    market: wideOpenMarket,
    orderbook: buildOrderbookFromMarket(wideOpenMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 8_000,
  });
  assert.equal(at8sWide.shouldTrade, false);
  assert.ok(at8sWide.reason.includes('stabilisasi'));

  // 3. At 00:08 with tight spread (2c <= 2c) and Ask 64c <= 65c: MUST BUY YES
  const at8sTight = evaluateBotSignal({
    bot: varBBot,
    market: tightMarket64,
    orderbook: buildOrderbookFromMarket(tightMarket64),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 8_000,
  });
  assert.equal(at8sTight.shouldTrade, true);
  assert.equal(at8sTight.action, 'buy');
  assert.equal(at8sTight.side, 'yes');
  assert.equal(at8sTight.priceCents, 64);

  // 4. Ask > 65c (66c) MUST be blocked by max 65c entry cap
  const priceyMarket66: KalshiMarket = {
    ...tightMarket64,
    yesBid: 65,
    yesAsk: 66,
    noBid: 34,
    noAsk: 35,
    lastPrice: 65,
  };
  const blocked66 = evaluateBotSignal({
    bot: varBBot,
    market: priceyMarket66,
    orderbook: buildOrderbookFromMarket(priceyMarket66),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 16_000,
  });
  assert.equal(blocked66.shouldTrade, false);
  assert.ok(blocked66.reason.includes('35–65¢'));

  // 5. After 01:30 cutoff (01:45): must NOT enter
  const afterWindow = evaluateBotSignal({
    bot: varBBot,
    market: tightMarket64,
    orderbook: buildOrderbookFromMarket(tightMarket64),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 105_000,
  });
  assert.equal(afterWindow.shouldTrade, false);
  assert.ok(afterWindow.reason.includes('01:30'));

  // 6. Strong opposing post-open candle (>= 68% BEARISH) blocks BULLISH pre-open entry
  const reversalMarket: KalshiMarket = {
    ...tightMarket64,
    candlePrediction: {
      ...bullPreOpen,
      direction: 'BEARISH',
      predictedSide: 'no',
      confidencePct: 72,
    },
  };
  const reversalBlocked = evaluateBotSignal({
    bot: varBBot,
    market: reversalMarket,
    orderbook: buildOrderbookFromMarket(reversalMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 16_000,
  });
  assert.equal(reversalBlocked.shouldTrade, false);
  assert.ok(reversalBlocked.reason.includes('berbalik BEARISH'));
});

test('Varian B preopen_spike executes TP +16c, Trailing +10c/-2c, skips SL (No SL), and Hard Closes after minute 6', () => {
  const btc = MARKETS_15M_SEED[0];
  const closeMs = Date.parse(btc.closeTime);
  const openMs = closeMs - 15 * 60_000;
  const varBBot: BotConfig = {
    ...DEFAULT_VARIAN_B_BOTS[0],
  };
  const basePos = {
    ticker: btc.ticker,
    marketTitle: btc.title,
    side: 'yes' as const,
    botId: varBBot.id,
    variant: 'B' as const,
    contracts: 1,
    avgEntryCents: 50,
    peakBidCents: 50,
    lowestBidCents: 50,
    trailingActivated: false,
    realizedPnlUsd: 0,
    updatedAt: '2026-11-14T00:00:00Z',
  };

  // A. Peak hits +10c (60c) -> trailingActivated = true, holds at 60c
  const m60: KalshiMarket = { ...btc, yesBid: 60, yesAsk: 61, noBid: 39, noAsk: 40, lastPrice: 60 };
  const trailArmed = evaluateBotSignal({
    bot: varBBot,
    market: m60,
    orderbook: buildOrderbookFromMarket(m60),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 2 * 60_000,
  });
  assert.equal(trailArmed.shouldTrade, false);
  assert.equal(trailArmed.trailingActivated, true);
  assert.equal(trailArmed.updatedPeakBidCents, 60);

  // B. Pullback -2c from 60c peak to 58c -> auto-closes via Trailing Stop
  const m58: KalshiMarket = { ...btc, yesBid: 58, yesAsk: 59, noBid: 41, noAsk: 42, lastPrice: 58 };
  const trailTriggered = evaluateBotSignal({
    bot: varBBot,
    market: m58,
    orderbook: buildOrderbookFromMarket(m58),
    position: { ...basePos, peakBidCents: 60, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 2 * 60_000 + 15_000,
  });
  assert.equal(trailTriggered.shouldTrade, true);
  assert.equal(trailTriggered.action, 'sell');
  assert.equal(trailTriggered.priceCents, 58);
  assert.ok(trailTriggered.reason.includes('Trailing Stop Varian B'));

  // C. Direct spike to +16c TP (66c) -> closes at TP
  const m66: KalshiMarket = { ...btc, yesBid: 66, yesAsk: 67, noBid: 33, noAsk: 34, lastPrice: 66 };
  const tpExit = evaluateBotSignal({
    bot: varBBot,
    market: m66,
    orderbook: buildOrderbookFromMarket(m66),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 90_000,
  });
  assert.equal(tpExit.shouldTrade, true);
  assert.equal(tpExit.action, 'sell');
  assert.equal(tpExit.priceCents, 66);
  assert.ok(tpExit.reason.includes('Target TP Varian B'));

  // D. Drop -30c (20c) at minute 3:00 -> NO Stop Loss, holds waiting for recovery or Hard Close 6m
  const m20: KalshiMarket = { ...btc, yesBid: 20, yesAsk: 21, noBid: 79, noAsk: 80, lastPrice: 20 };
  const noSlHold = evaluateBotSignal({
    bot: varBBot,
    market: m20,
    orderbook: buildOrderbookFromMarket(m20),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 3 * 60_000,
  });
  assert.equal(noSlHold.shouldTrade, false);
  assert.ok(noSlHold.reason.includes('No SL'));

  // E. Hard Close at minute 6:00 -> forces SELL even at flat/loss (20c or 52c)
  const m52: KalshiMarket = { ...btc, yesBid: 52, yesAsk: 53, noBid: 47, noAsk: 48, lastPrice: 52 };
  const beforeHardClose = evaluateBotSignal({
    bot: varBBot,
    market: m52,
    orderbook: buildOrderbookFromMarket(m52),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 5 * 60_000 + 55_000,
  });
  assert.equal(beforeHardClose.shouldTrade, false);

  const atHardClose = evaluateBotSignal({
    bot: varBBot,
    market: m20,
    orderbook: buildOrderbookFromMarket(m20),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: openMs + 6 * 60_000,
  });
  assert.equal(atHardClose.shouldTrade, true);
  assert.equal(atHardClose.action, 'sell');
  assert.equal(atHardClose.priceCents, 20);
  assert.ok(atHardClose.reason.includes('Hard Close Menit 6:00'));
});

test('validateBotConfig and runBacktest support Varian B preopen_spike constraints (max 65c, No SL, Hard Close 6m)', () => {
  assert.ok(
    validateBotConfig({
      name: 'Invalid Var B MaxEntry',
      ticker: 'KXBTC15M',
      strategy: 'preopen_spike',
      maxEntryPriceCents: 90,
      takeProfitCents: 16,
      stopLossCents: 0,
      noStopLoss: true,
      trailingActivationDeltaCents: 10,
      trailingDistanceCents: 2,
      hardCloseMinute: 6,
    }) !== null
  );
  assert.equal(
    validateBotConfig({
      name: 'Valid Var B',
      ticker: 'KXBTC15M',
      strategy: 'preopen_spike',
      maxEntryPriceCents: 65,
      takeProfitCents: 16,
      stopLossCents: 0,
      noStopLoss: true,
      trailingActivationDeltaCents: 10,
      trailingDistanceCents: 2,
      hardCloseMinute: 6,
      entryDelayMinSec: 5,
      entryDelayMaxSec: 15,
      minCandleConfidence: 58,
      maxContractsPerOrder: 1,
      maxPositionContracts: 1,
    }),
    null
  );

  // Price series rises from 42 to 63 (under 65c max entry) then spikes to 79 (+16c TP)
  const varBSeries = [
    42, 44, 46, 45, 48, 50, 49, 52, 54, 56, 58, 60, 61, 62, 63,
    68, 74, 80, 77, 74, 70, 68,
  ];
  const btRes = runBacktest(
    {
      strategy: 'preopen_spike',
      ticker: 'KXBTC15M',
      fairValueCents: 50,
      entryEdgeCents: 2,
      takeProfitCents: 16,
      stopLossCents: 0,
      noStopLoss: true,
      trailingActivationDeltaCents: 10,
      trailingDistanceCents: 2,
      hardCloseMinute: 6,
      maxEntryPriceCents: 65,
      minCandleConfidence: 55,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    varBSeries
  );
  assert.equal(btRes.equityCurve.length, varBSeries.length);
  assert.ok(btRes.trades.every((t) => t.action !== 'buy' || t.priceCents <= 65));
});

test('clearVariantHistoryAndPnl removes all Varian B orders, dailyHistory, open positions, and PnL while keeping Varian A intact', () => {
  const botA = {
    ...DEFAULT_15M_TRAILING_BOTS[0],
    tradesExecuted: 2,
    realizedPnlUsd: 0.08,
  };
  const botB = {
    ...DEFAULT_VARIAN_B_BOTS[0],
    tradesExecuted: 3,
    realizedPnlUsd: -0.25,
  };
  // Starting cash $20.00
  // Var A closed trade: buy @ 80c (+$0.02 fee = $0.82), sell @ 90c (-$0.01 fee = $0.89) -> net +$0.07
  // Var A open pos: buy @ 84c (+$0.01 fee = $0.85) -> openCost $0.84, realized -$0.01
  // Var B closed trade: buy @ 55c (+$0.02 fee = $0.57), sell @ 34c (-$0.02 fee = $0.32) -> net -$0.25
  // Var B open pos: buy @ 50c (+$0.02 fee = $0.52) -> openCost $0.50, realized -$0.02
  // Total cash = 20 - 0.82 + 0.89 - 0.85 - 0.57 + 0.32 - 0.52 = 18.45
  // Total openCost = 0.84 + 0.50 = 1.34
  // Total dailyRealizedPnlUsd = 18.45 + 1.34 - 20 = -0.21
  const mixedState: PortfolioState = {
    ...INITIAL_PORTFOLIO_STATE,
    cashUsd: 18.45,
    startingCashUsd: 20,
    dailyRealizedPnlUsd: -0.21,
    totalFilledOrders: 6,
    tradedTickers: [
      `${botA.id}::KXBTC15M-A1`,
      `${botA.id}::KXBTC15M-A2`,
      `${botB.id}::KXBTC15M-B1`,
      `${botB.id}::KXBTC15M-B2`,
    ],
    bots: [botA, botB],
    positions: [
      {
        ticker: 'KXBTC15M-A2',
        marketTitle: 'BTC 15m',
        side: 'yes',
        botId: botA.id,
        variant: 'A',
        contracts: 1,
        avgEntryCents: 84,
        realizedPnlUsd: 0,
        updatedAt: '2026-11-14T14:05:00.000Z',
      },
      {
        ticker: 'KXBTC15M-B2',
        marketTitle: 'BTC 15m',
        side: 'no',
        botId: botB.id,
        variant: 'B',
        contracts: 1,
        avgEntryCents: 50,
        realizedPnlUsd: 0,
        updatedAt: '2026-11-14T14:06:00.000Z',
      },
    ],
    orders: [
      {
        id: 'ord-a1-buy',
        clientOrderId: 'c1',
        botId: botA.id,
        botName: botA.name,
        ticker: 'KXBTC15M-A1',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 80,
        feeUsd: 0.02,
        totalUsd: 0.82,
        mode: 'paper',
        status: 'filled',
        reason: 'Var A entry',
        createdAt: '2026-11-14T14:01:00.000Z',
      },
      {
        id: 'ord-a1-sell',
        clientOrderId: 'c2',
        botId: botA.id,
        botName: botA.name,
        ticker: 'KXBTC15M-A1',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 90,
        feeUsd: 0.01,
        totalUsd: 0.89,
        mode: 'paper',
        status: 'filled',
        reason: 'Var A TP',
        createdAt: '2026-11-14T14:02:00.000Z',
      },
      {
        id: 'ord-a2-buy',
        clientOrderId: 'c3',
        botId: botA.id,
        botName: botA.name,
        ticker: 'KXBTC15M-A2',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 84,
        feeUsd: 0.01,
        totalUsd: 0.85,
        mode: 'paper',
        status: 'filled',
        reason: 'Var A open entry',
        createdAt: '2026-11-14T14:05:00.000Z',
      },
      {
        id: 'ord-b1-buy',
        clientOrderId: 'c4',
        botId: botB.id,
        botName: botB.name,
        ticker: 'KXBTC15M-B1',
        side: 'no',
        action: 'buy',
        contracts: 1,
        priceCents: 55,
        feeUsd: 0.02,
        totalUsd: 0.57,
        mode: 'paper',
        status: 'filled',
        reason: 'Var B entry',
        createdAt: '2026-11-14T14:00:10.000Z',
      },
      {
        id: 'ord-b1-sell',
        clientOrderId: 'c5',
        botId: botB.id,
        botName: botB.name,
        ticker: 'KXBTC15M-B1',
        side: 'no',
        action: 'sell',
        contracts: 1,
        priceCents: 34,
        feeUsd: 0.02,
        totalUsd: 0.32,
        mode: 'paper',
        status: 'filled',
        reason: 'Hard Close Menit 6:00',
        createdAt: '2026-11-14T14:06:00.000Z',
      },
      {
        id: 'ord-b2-buy',
        clientOrderId: 'c6',
        botId: botB.id,
        botName: botB.name,
        ticker: 'KXBTC15M-B2',
        side: 'no',
        action: 'buy',
        contracts: 1,
        priceCents: 50,
        feeUsd: 0.02,
        totalUsd: 0.52,
        mode: 'paper',
        status: 'filled',
        reason: 'Var B open entry',
        createdAt: '2026-11-14T14:06:10.000Z',
      },
    ],
    dailyHistory: {
      '2026-11-14': {
        date: '2026-11-14',
        realizedPnlUsd: -0.21,
        feesUsd: 0.09,
        entriesCount: 4,
        exitsCount: 2,
        wins: 1,
        losses: 1,
        entriesByTicker: {
          'KXBTC15M-A1': 1,
          'KXBTC15M-A2': 1,
          'KXBTC15M-B1': 1,
          'KXBTC15M-B2': 1,
        },
        entries: [
          {
            id: 'ord-a1-buy',
            dateKey: '2026-11-14',
            ticker: 'KXBTC15M-A1',
            botId: botA.id,
            botName: botA.name,
            variant: 'A',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 80,
            feeUsd: 0.02,
            netPnlUsd: -0.02,
            mode: 'paper',
            reason: 'Var A entry',
            createdAt: '2026-11-14T14:01:00.000Z',
          },
          {
            id: 'ord-a1-sell',
            dateKey: '2026-11-14',
            ticker: 'KXBTC15M-A1',
            botId: botA.id,
            botName: botA.name,
            variant: 'A',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 90,
            feeUsd: 0.01,
            netPnlUsd: 0.07,
            mode: 'paper',
            reason: 'Var A TP',
            createdAt: '2026-11-14T14:02:00.000Z',
          },
          {
            id: 'ord-a2-buy',
            dateKey: '2026-11-14',
            ticker: 'KXBTC15M-A2',
            botId: botA.id,
            botName: botA.name,
            variant: 'A',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 84,
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            mode: 'paper',
            reason: 'Var A open entry',
            createdAt: '2026-11-14T14:05:00.000Z',
          },
          {
            id: 'ord-b1-buy',
            dateKey: '2026-11-14',
            ticker: 'KXBTC15M-B1',
            botId: botB.id,
            botName: botB.name,
            variant: 'B',
            side: 'no',
            action: 'buy',
            contracts: 1,
            priceCents: 55,
            feeUsd: 0.02,
            netPnlUsd: -0.02,
            mode: 'paper',
            reason: 'Var B entry',
            createdAt: '2026-11-14T14:00:10.000Z',
          },
          {
            id: 'ord-b1-sell',
            dateKey: '2026-11-14',
            ticker: 'KXBTC15M-B1',
            botId: botB.id,
            botName: botB.name,
            variant: 'B',
            side: 'no',
            action: 'sell',
            contracts: 1,
            priceCents: 34,
            feeUsd: 0.02,
            netPnlUsd: -0.25,
            mode: 'paper',
            reason: 'Hard Close Menit 6:00',
            createdAt: '2026-11-14T14:06:00.000Z',
          },
          {
            id: 'ord-b2-buy',
            dateKey: '2026-11-14',
            ticker: 'KXBTC15M-B2',
            botId: botB.id,
            botName: botB.name,
            variant: 'B',
            side: 'no',
            action: 'buy',
            contracts: 1,
            priceCents: 50,
            feeUsd: 0.02,
            netPnlUsd: -0.02,
            mode: 'paper',
            reason: 'Var B open entry',
            createdAt: '2026-11-14T14:06:10.000Z',
          },
        ],
      },
    },
  };

  const cleaned = clearVariantHistoryAndPnl(mixedState, 'B');
  // Var B orders/positions/entries completely removed
  assert.equal(cleaned.orders.length, 3);
  assert.equal(cleaned.totalFilledOrders, 3);
  assert.equal(cleaned.positions.length, 1);
  assert.equal(cleaned.positions[0].botId, botA.id);
  assert.deepEqual(cleaned.tradedTickers, [`${botA.id}::KXBTC15M-A1`, `${botA.id}::KXBTC15M-A2`]);

  // Cash & PnL reflect ONLY Var A: 20 - 0.82 + 0.89 - 0.85 = 19.22; realized = 19.22 + 0.84 - 20 = +0.06
  assert.equal(cleaned.cashUsd, 19.22);
  assert.equal(cleaned.dailyRealizedPnlUsd, 0.06);

  const day = cleaned.dailyHistory?.['2026-11-14'];
  assert.ok(day);
  assert.equal(day.entries.length, 3);
  assert.equal(day.entriesCount, 2);
  assert.equal(day.exitsCount, 1);
  assert.equal(day.wins, 1);
  assert.equal(day.losses, 0);
  assert.equal(day.feesUsd, 0.03);
  assert.equal(day.realizedPnlUsd, 0.06);
  assert.deepEqual(day.entriesByTicker, { 'KXBTC15M-A1': 1, 'KXBTC15M-A2': 1 });

  // Bot B stats zeroed, Bot A stats untouched
  const cleanedBotA = cleaned.bots.find((b) => b.id === botA.id);
  const cleanedBotB = cleaned.bots.find((b) => b.id === botB.id);
  assert.equal(cleanedBotA?.tradesExecuted, 2);
  assert.equal(cleanedBotA?.realizedPnlUsd, 0.08);
  assert.equal(cleanedBotB?.tradesExecuted, 0);
  assert.equal(cleanedBotB?.realizedPnlUsd, 0);
});

test('deriveTopOfBookFromOrderbook computes live bid/ask without stale or inverted quotes on one-sided books', () => {
  // Two-sided normal book
  assert.deepEqual(
    deriveTopOfBookFromOrderbook([{ price: 38, quantity: 100 }], [{ price: 61, quantity: 50 }]),
    { yesBid: 38, yesAsk: 39, noBid: 61, noAsk: 62 }
  );

  // One-sided NO book (empty YES bids) must NOT invert or preserve stale YES bid
  assert.deepEqual(
    deriveTopOfBookFromOrderbook([], [{ price: 99, quantity: 900 }]),
    { yesBid: 1, yesAsk: 1, noBid: 99, noAsk: 99 }
  );

  // One-sided YES book (empty NO bids)
  assert.deepEqual(
    deriveTopOfBookFromOrderbook([{ price: 99, quantity: 900 }], []),
    { yesBid: 99, yesAsk: 99, noBid: 1, noAsk: 1 }
  );

  // Completely empty book returns null
  assert.equal(deriveTopOfBookFromOrderbook([], []), null);
});

test('evaluateRisingPriceMomentum blocks falling knives, dead-cat bounces, and flat chop while confirming genuine uptrends', () => {
  // 1. Falling knife on YES -> rejected
  const fallingYes = evaluateRisingPriceMomentum([91, 88, 85, 83], 81, 'yes');
  assert.equal(fallingYes.ok, false);
  assert.ok(fallingYes.reason.includes('Anti pisau jatuh'));

  // 2. Dead-cat bounce on YES after drop from 92c -> rejected
  const deadCatYes = evaluateRisingPriceMomentum([92, 87, 83, 80, 81], 82, 'yes');
  assert.equal(deadCatYes.ok, false);
  assert.ok(deadCatYes.reason.includes('Anti pisau jatuh') || deadCatYes.reason.includes('belum naik'));

  // 3. Flat / stagnant repeated trades -> rejected
  const flatYes = evaluateRisingPriceMomentum([81, 81, 81, 81], 81, 'yes');
  assert.equal(flatYes.ok, false);

  // 4. Genuine rising YES price -> accepted
  const risingYes = evaluateRisingPriceMomentum([73, 75, 77, 79, 80], 82, 'yes');
  assert.equal(risingYes.ok, true);
  assert.equal(risingYes.currPrice, 82);

  // 5. Falling knife on NO (when YES is climbing 12 -> 15 -> 18 -> 20, so NO drops 88 -> 85 -> 82 -> 80) -> rejected
  const fallingNo = evaluateRisingPriceMomentum([12, 15, 18, 19], 20, 'no');
  assert.equal(fallingNo.ok, false);

  // 6. Genuine rising NO price (YES falling 28 -> 25 -> 22 -> 20 -> 18) -> accepted
  const risingNo = evaluateRisingPriceMomentum([28, 25, 22, 20], 18, 'no');
  assert.equal(risingNo.ok, true);
  assert.equal(risingNo.currPrice, 82);
});

test('Varian A rejects falling knives, lagging EMA counter-candles, Doji consolidation, and RSI exhaustion traps', () => {
  const btc = MARKETS_15M_SEED[0];
  const insideWindowNow = Date.parse(btc.closeTime) - 5 * 60_000;

  // A. Falling knife on YES (dropped 94 -> 91 -> 88 -> 86) even with bullish spot EMA -> BLOCKED
  const fallingYesMarket: KalshiMarket = {
    ...btc,
    yesBid: 85,
    yesAsk: 86,
    noBid: 14,
    noAsk: 15,
    lastPrice: 86,
    previousPrice: 88,
    priceHistory: [94, 92, 91, 88, 86],
    candlePrediction: makeBullPred(86),
  };
  const fallingDecision = evaluateBotSignal({
    bot: trailingBot,
    market: fallingYesMarket,
    orderbook: buildOrderbookFromMarket(fallingYesMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(fallingDecision.shouldTrade, false);
  assert.ok(fallingDecision.reason.includes('Anti pisau jatuh'));

  // B. Falling knife on NO (YES rising 6 -> 9 -> 12 -> 14 -> 15 => NO dropping 94 -> 85) -> BLOCKED
  const fallingNoMarket: KalshiMarket = {
    ...btc,
    yesBid: 14,
    yesAsk: 15,
    noBid: 85,
    noAsk: 86,
    lastPrice: 15,
    previousPrice: 13,
    priceHistory: [6, 8, 11, 13, 15],
    candlePrediction: makeBearPred(15),
  };
  const fallingNoDecision = evaluateBotSignal({
    bot: trailingBot,
    market: fallingNoMarket,
    orderbook: buildOrderbookFromMarket(fallingNoMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(fallingNoDecision.shouldTrade, false);
  assert.ok(fallingNoDecision.reason.includes('Anti pisau jatuh'));

  // C. Lagging EMA5 > EMA13 BULLISH prediction when latest candle reversed BEARISH -> BLOCKED
  const reversalCandleMarket: KalshiMarket = {
    ...btc,
    yesBid: 85,
    yesAsk: 86,
    noBid: 14,
    noAsk: 15,
    lastPrice: 86,
    priceHistory: [78, 80, 82, 84, 86],
    candlePrediction: {
      ...makeBullPred(86),
      lastCandleDir: 'BEARISH',
      patterns: ['Candle Momentum Bearish', 'EMA5 > EMA13'],
    },
  };
  const revDecision = evaluateBotSignal({
    bot: trailingBot,
    market: reversalCandleMarket,
    orderbook: buildOrderbookFromMarket(reversalCandleMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(revDecision.shouldTrade, false);

  // D. RSI Oversold bounce trap (< 22) for BUY NO -> BLOCKED
  const oversoldNoMarket: KalshiMarket = {
    ...btc,
    yesBid: 12,
    yesAsk: 13,
    noBid: 87,
    noAsk: 88,
    lastPrice: 13,
    priceHistory: [24, 21, 18, 15, 13],
    candlePrediction: {
      ...makeBearPred(13),
      rsi: 17,
    },
  };
  const oversoldDecision = evaluateBotSignal({
    bot: trailingBot,
    market: oversoldNoMarket,
    orderbook: buildOrderbookFromMarket(oversoldNoMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(oversoldDecision.shouldTrade, false);
  assert.ok(oversoldDecision.reason.includes('Oversold'));
});

test('Varian A Hold Settle skips trailing exits on pullbacks while optional TP/Trailing mode locks >= +3c', () => {
  const btc = MARKETS_15M_SEED[0];
  const basePos = {
    ticker: btc.ticker,
    marketTitle: btc.title,
    side: 'yes' as const,
    contracts: 1,
    avgEntryCents: 85,
    peakBidCents: 85,
    trailingActivated: false,
    realizedPnlUsd: 0,
    updatedAt: '2026-11-12T00:00:00Z',
  };

  // 1. At +2c (87c < +3c activation): trailing NOT armed yet, holds
  const m87: KalshiMarket = { ...btc, yesBid: 87, yesAsk: 88, noBid: 12, noAsk: 13, lastPrice: 87 };
  const holdAt87 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m87,
    orderbook: buildOrderbookFromMarket(m87),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(holdAt87.shouldTrade, false);
  assert.equal(holdAt87.trailingActivated, false);

  // 2. Reaches +3c (88c): trailing ARMS (trailingActivated = true), still holds to let winners run to TP
  const m88: KalshiMarket = { ...btc, yesBid: 88, yesAsk: 89, noBid: 11, noAsk: 12, lastPrice: 88 };
  const armAt88 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m88,
    orderbook: buildOrderbookFromMarket(m88),
    position: basePos,
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(armAt88.shouldTrade, false);
  assert.equal(armAt88.trailingActivated, true);
  assert.equal(armAt88.updatedPeakBidCents, 88);

  // 3. Climbs to 92c (+7c, below +10c TP 95c), then dips 1c to 91c -> holds (trailStopLevel = 92 - 2 = 90c)
  const m91: KalshiMarket = { ...btc, yesBid: 91, yesAsk: 92, noBid: 8, noAsk: 9, lastPrice: 91 };
  const dip1At91 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m91,
    orderbook: buildOrderbookFromMarket(m91),
    position: { ...basePos, peakBidCents: 92, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(dip1At91.shouldTrade, false);
  assert.equal(dip1At91.trailingActivated, true);

  // 4. Drops -2c from peak 92c -> 90c (+5c >= +3c min sell):
  //    Default TP 99c bot (useTrailingStop: false) HOLDS waiting for 99c/Settle; manual TP/Trailing bot triggers Trailing Stop SELL @ 90c
  const m90: KalshiMarket = { ...btc, yesBid: 90, yesAsk: 91, noBid: 9, noAsk: 10, lastPrice: 90 };
  const defaultHoldOnPullback = evaluateBotSignal({
    bot: trailingBot,
    market: m90,
    orderbook: buildOrderbookFromMarket(m90),
    position: { ...basePos, peakBidCents: 92, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: undefined,
  });
  assert.equal(defaultHoldOnPullback.shouldTrade, false);
  assert.ok(defaultHoldOnPullback.reason.includes('Target TP 99¢'));

  const trailSell90 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m90,
    orderbook: buildOrderbookFromMarket(m90),
    position: { ...basePos, peakBidCents: 92, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(trailSell90.shouldTrade, true);
  assert.equal(trailSell90.action, 'sell');
  assert.equal(trailSell90.priceCents, 90);
  assert.ok(trailSell90.reason.includes('Trailing Stop Varian A'));

  // 5. Peaked at 89c (+4c) then pulled back to 88c (+3c min floor) -> manual TP/Trailing SELL @ 88c (+3c)
  const floorSell88 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m88,
    orderbook: buildOrderbookFromMarket(m88),
    position: { ...basePos, peakBidCents: 89, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(floorSell88.shouldTrade, true);
  assert.equal(floorSell88.action, 'sell');
  assert.equal(floorSell88.priceCents, 88);

  // 6. Gaps below +3c (to 87c = +2c or 82c = -3c) -> NEVER sells below +3c on trailing stop (respects min +3c & No SL)
  const gapDownBelow3 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m87,
    orderbook: buildOrderbookFromMarket(m87),
    position: { ...basePos, peakBidCents: 90, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(gapDownBelow3.shouldTrade, false);

  // 7. Entry 91c rallies to 96c (+5c) then pulls back to 94c (+3c) -> manual Trailing Stop locks +3c @ 94c
  const m94: KalshiMarket = { ...btc, yesBid: 94, yesAsk: 95, noBid: 5, noAsk: 6, lastPrice: 94 };
  const trailFrom91 = evaluateBotSignal({
    bot: tpTrailingBot,
    market: m94,
    orderbook: buildOrderbookFromMarket(m94),
    position: { ...basePos, avgEntryCents: 91, peakBidCents: 96, trailingActivated: true },
    allPositions: [],
    openOrderCount: 1,
    availableCashUsd: 19,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
  });
  assert.equal(trailFrom91.shouldTrade, true);
  assert.equal(trailFrom91.action, 'sell');
  assert.equal(trailFrom91.priceCents, 94);

  // 8. Validate config rejects invalid trailingMinProfitCents >= takeProfitCents when Hold Settle is OFF and useTrailingStop is ON
  assert.ok(
    validateBotConfig({
      name: 'Invalid Trail Min',
      ticker: 'KXBTC15M',
      strategy: 'trailing_momentum',
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      holdToSettle: false,
      useTrailingStop: true,
      takeProfitCents: 10,
      trailingActivationDeltaCents: 3,
      trailingMinProfitCents: 10,
      trailingDistanceCents: 2,
      noStopLoss: true,
    }) !== null
  );
});

test('Backtest Varian A Hold Settle holds through +6c->+4c pullback while manual TP/Trailing mode locks >= +3c', () => {
  // Climbs into 85-91c window (86c entry), peaks at 92c (+6c, fails to touch 96c TP), pulls back to 90c then 75c
  const stallSeries = [62, 65, 64, 67, 70, 69, 73, 76, 75, 81, 86, 89, 92, 91, 90, 84, 79, 75];
  const holdRes = runBacktest(
    {
      strategy: 'trailing_momentum',
      ticker: 'KXBTC15M',
      fairValueCents: 85,
      entryEdgeCents: 2,
      takeProfitCents: 0,
      holdToSettle: true,
      stopLossCents: 0,
      noStopLoss: true,
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      minCandleConfidence: 58,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    stallSeries
  );
  const holdBuy = holdRes.trades.find((t) => t.action === 'buy');
  const holdSell = holdRes.trades.find((t) => t.action === 'sell');
  assert.ok(holdBuy);
  assert.ok(holdSell);
  assert.ok(holdSell.reason.includes('Hold sampai Settle'));
  assert.equal(holdSell.priceCents, 75);

  const res = runBacktest(
    {
      strategy: 'trailing_momentum',
      ticker: 'KXBTC15M',
      fairValueCents: 85,
      entryEdgeCents: 2,
      takeProfitCents: 10,
      holdToSettle: false,
      stopLossCents: 0,
      noStopLoss: true,
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      trailingActivationDeltaCents: 3,
      trailingMinProfitCents: 3,
      trailingDistanceCents: 2,
      minCandleConfidence: 58,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    stallSeries
  );
  const sellTrade = res.trades.find((t) => t.action === 'sell');
  const buyTrade = res.trades.find((t) => t.action === 'buy');
  assert.ok(buyTrade);
  assert.ok(sellTrade);
  assert.ok(sellTrade.reason.includes('Trailing Stop Varian A'));
  assert.ok(sellTrade.priceCents - buyTrade.priceCents >= 3);
  assert.ok(sellTrade.pnlUsd > 0);
  assert.equal(res.winRatePct, 100);
});

test('aggregateCandlesTo5m rolls 1m bars into aligned 5m OHLCV bars and analyzeCandlesAndPredict attaches confirm1m', () => {
  const baseBucket = 1794615000; // divisible by 300
  const bars1m: OhlcCandle[] = Array.from({ length: 25 }, (_, i) => {
    const open = 68000 + i * 10;
    const close = open + 12;
    return {
      timeSec: baseBucket + i * 60,
      open,
      high: close + 5,
      low: open - 4,
      close,
      volume: 10 + i,
    };
  });

  const bars5m = aggregateCandlesTo5m(bars1m);
  assert.equal(bars5m.length, 5);
  assert.equal(bars5m[0].timeSec, baseBucket);
  assert.equal(bars5m[0].open, bars1m[0].open);
  assert.equal(bars5m[0].close, bars1m[4].close);
  assert.equal(bars5m[0].high, Math.max(...bars1m.slice(0, 5).map((b) => b.high)));
  assert.equal(bars5m[0].low, Math.min(...bars1m.slice(0, 5).map((b) => b.low)));
  assert.equal(bars5m[0].volume, bars1m.slice(0, 5).reduce((s, b) => s + b.volume, 0));

  const confirm1m = analyze1mEntryConfirmation({
    candles1m: bars1m,
    symbol: 'BTC/USD',
    currentYesCents: 86,
  });
  assert.ok(confirm1m);
  assert.equal(confirm1m.lastCandleDir, 'BULLISH');
  assert.equal(confirm1m.direction, 'BULLISH');

  const pred = analyzeCandlesAndPredict({
    candles: bars5m,
    candles1m: bars1m,
    symbol: 'BTC/USD',
    currentYesCents: 86,
    targetPrice: 68050,
    source: 'spot_5m',
    timeframe: '5m',
  });
  assert.ok(pred);
  assert.equal(pred.timeframe, '5m');
  assert.equal(pred.direction, 'BULLISH');
  assert.ok(pred.confirm1m);
  assert.equal(pred.confirm1m.lastCandleDir, 'BULLISH');
});

test('Varian A requires 5m market direction AND 1m entry confirmation (blocks NEUTRAL 5m or counter 1m candle)', () => {
  const btc = MARKETS_15M_SEED[0];
  const insideWindowNow = Date.parse(btc.closeTime) - 5 * 60_000;
  const bull5mWithBull1m = makeBullPred(86);

  const risingMarket: KalshiMarket = {
    ...btc,
    yesBid: 85,
    yesAsk: 86,
    noBid: 14,
    noAsk: 15,
    lastPrice: 86,
    previousPrice: 84,
    priceHistory: [78, 80, 82, 84, 86],
    candlePrediction: bull5mWithBull1m,
  };

  // 1. 5m BULLISH + 1m BULLISH -> BUY YES allowed
  const okDecision = evaluateBotSignal({
    bot: trailingBot,
    market: risingMarket,
    orderbook: buildOrderbookFromMarket(risingMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(okDecision.shouldTrade, true);
  assert.equal(okDecision.side, 'yes');
  assert.equal(okDecision.action, 'buy');
  assert.ok(okDecision.reason.includes('5m'));
  assert.ok(okDecision.reason.includes('1m'));

  // 2. 5m NEUTRAL even when 1m is BULLISH -> BLOCKED
  const neutral5mMarket: KalshiMarket = {
    ...risingMarket,
    candlePrediction: {
      ...bull5mWithBull1m,
      direction: 'NEUTRAL',
      confidencePct: 50,
    },
  };
  const blockedNeutral = evaluateBotSignal({
    bot: trailingBot,
    market: neutral5mMarket,
    orderbook: buildOrderbookFromMarket(neutral5mMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(blockedNeutral.shouldTrade, false);
  assert.ok(blockedNeutral.reason.includes('5m'));

  // 3. 5m BULLISH but 1m candle is BEARISH -> BLOCKED by Konfirmasi 1m
  const counter1mMarket: KalshiMarket = {
    ...risingMarket,
    candlePrediction: {
      ...bull5mWithBull1m,
      confirm1m: {
        ...bull5mWithBull1m.confirm1m!,
        direction: 'BEARISH',
        lastCandleDir: 'BEARISH',
      },
    },
  };
  const blockedCounter1m = evaluateBotSignal({
    bot: trailingBot,
    market: counter1mMarket,
    orderbook: buildOrderbookFromMarket(counter1mMarket),
    position: undefined,
    allPositions: [],
    openOrderCount: 0,
    availableCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    riskLimits: baseRisk,
    nowMs: insideWindowNow,
  });
  assert.equal(blockedCounter1m.shouldTrade, false);
  assert.ok(blockedCounter1m.reason.includes('Konfirmasi 1m'));
});

test('reconcileHistoryToHoldSettle converts Varian A TP/Trailing exits to Fix Settle, deduplicates double settles, and is idempotent', () => {
  const botA1: BotConfig = {
    ...DEFAULT_15M_TRAILING_BOTS[0],
    id: 'bot-15m-kxbtc15m',
    name: 'Varian A Hold Settle · BTC',
    holdToSettle: true,
    takeProfitCents: 0,
  };
  const botA2: BotConfig = {
    ...DEFAULT_15M_TRAILING_BOTS[1],
    id: 'bot-15m-kxeth15m',
    name: 'Varian A Hold Settle · ETH',
    holdToSettle: true,
    takeProfitCents: 0,
  };

  // Trade 1 (BTC): bought @ 85c (fee 0.01), exited early via Trailing @ 88c (fee 0.01), official settle WIN -> should become WIN $1.00 (+$0.14 net, $0.00 exit fee)
  // Trade 2 (ETH): bought @ 86c (fee 0.01), exited early via TP @ 96c (fee 0.01), official settle LOSE -> should become LOSS $0.00 (-$0.87 net, $0.00 exit fee)
  // Trade 3 (BTC-2): bought @ 90c (fee 0.01), settled WIN twice due to race condition -> deduped to 1 exit (+$0.09 net)
  // Combined exact net: +0.14 - 0.87 + 0.09 = -0.64 -> cashUsd = 20 - 0.64 = 19.36
  const sampleState: PortfolioState = {
    ...INITIAL_PORTFOLIO_STATE,
    cashUsd: 20,
    startingCashUsd: 20,
    dailyRealizedPnlUsd: 0,
    totalFilledOrders: 7,
    bots: [botA1, botA2],
    positions: [],
    orders: [
      {
        id: 'ord-btc1-buy',
        clientOrderId: 'c1',
        botId: botA1.id,
        botName: botA1.name,
        ticker: 'KXBTC15M-26NOV150700-00',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 85,
        feeUsd: 0.01,
        totalUsd: 0.86,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry',
        createdAt: '2026-11-15T11:52:00.000Z',
      },
      {
        id: 'ord-btc1-sell',
        clientOrderId: 'c2',
        botId: botA1.id,
        botName: botA1.name,
        ticker: 'KXBTC15M-26NOV150700-00',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 88,
        feeUsd: 0.01,
        totalUsd: 0.87,
        mode: 'paper',
        status: 'filled',
        reason: 'Trailing Stop Varian A terpicu @ 88¢',
        createdAt: '2026-11-15T11:53:30.000Z',
      },
      {
        id: 'ord-eth1-buy',
        clientOrderId: 'c3',
        botId: botA2.id,
        botName: botA2.name,
        ticker: 'KXETH15M-26NOV150715-15',
        side: 'no',
        action: 'buy',
        contracts: 1,
        priceCents: 86,
        feeUsd: 0.01,
        totalUsd: 0.87,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry',
        createdAt: '2026-11-15T12:08:00.000Z',
      },
      {
        id: 'ord-eth1-sell',
        clientOrderId: 'c4',
        botId: botA2.id,
        botName: botA2.name,
        ticker: 'KXETH15M-26NOV150715-15',
        side: 'no',
        action: 'sell',
        contracts: 1,
        priceCents: 96,
        feeUsd: 0.01,
        totalUsd: 0.95,
        mode: 'paper',
        status: 'filled',
        reason: 'TP Varian A (+10¢) tercapai',
        createdAt: '2026-11-15T12:10:00.000Z',
      },
      {
        id: 'ord-btc2-buy',
        clientOrderId: 'c5',
        botId: botA1.id,
        botName: botA1.name,
        ticker: 'KXBTC15M-26NOV150730-30',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 90,
        feeUsd: 0.01,
        totalUsd: 0.91,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry',
        createdAt: '2026-11-15T12:22:00.000Z',
      },
      {
        id: 'stl-btc2-1',
        clientOrderId: 'c6',
        botId: botA1.id,
        botName: `Settle · ${botA1.name}`,
        ticker: 'KXBTC15M-26NOV150730-30',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 99,
        feeUsd: 0,
        totalUsd: 1,
        mode: 'paper',
        status: 'filled',
        reason: 'Kontrak 15m selesai (YES)',
        createdAt: '2026-11-15T12:30:05.000Z',
      },
      {
        id: 'stl-btc2-2',
        clientOrderId: 'c7',
        botId: botA1.id,
        botName: `Settle · ${botA1.name}`,
        ticker: 'KXBTC15M-26NOV150730-30',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 99,
        feeUsd: 0,
        totalUsd: 1,
        mode: 'paper',
        status: 'filled',
        reason: 'Kontrak 15m selesai (YES)',
        createdAt: '2026-11-15T12:30:06.000Z',
      },
    ],
    dailyHistory: {
      '2026-11-15': {
        date: '2026-11-15',
        realizedPnlUsd: 0,
        feesUsd: 0.05,
        entriesCount: 3,
        exitsCount: 4,
        wins: 3,
        losses: 1,
        entriesByTicker: {
          'KXBTC15M-26NOV150700-00': 1,
          'KXETH15M-26NOV150715-15': 1,
          'KXBTC15M-26NOV150730-30': 1,
        },
        entries: [
          {
            id: 'ord-btc1-buy',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV150700-00',
            botId: botA1.id,
            botName: botA1.name,
            variant: 'A',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 85,
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Varian A entry',
            createdAt: '2026-11-15T11:52:00.000Z',
          },
          {
            id: 'ord-btc1-sell',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV150700-00',
            botId: botA1.id,
            botName: botA1.name,
            variant: 'A',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 88,
            feeUsd: 0.01,
            netPnlUsd: 0.01,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Trailing Stop Varian A terpicu @ 88¢',
            createdAt: '2026-11-15T11:53:30.000Z',
          },
          {
            id: 'ord-eth1-buy',
            dateKey: '2026-11-15',
            ticker: 'KXETH15M-26NOV150715-15',
            botId: botA2.id,
            botName: botA2.name,
            variant: 'A',
            side: 'no',
            action: 'buy',
            contracts: 1,
            priceCents: 86,
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            settleOutcome: 'lose',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Varian A entry',
            createdAt: '2026-11-15T12:08:00.000Z',
          },
          {
            id: 'ord-eth1-sell',
            dateKey: '2026-11-15',
            ticker: 'KXETH15M-26NOV150715-15',
            botId: botA2.id,
            botName: botA2.name,
            variant: 'A',
            side: 'no',
            action: 'sell',
            contracts: 1,
            priceCents: 96,
            feeUsd: 0.01,
            netPnlUsd: 0.08,
            settleOutcome: 'lose',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'TP Varian A (+10¢) tercapai',
            createdAt: '2026-11-15T12:10:00.000Z',
          },
          {
            id: 'ord-btc2-buy',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV150730-30',
            botId: botA1.id,
            botName: botA1.name,
            variant: 'A',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 90,
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Varian A entry',
            createdAt: '2026-11-15T12:22:00.000Z',
          },
          {
            id: 'stl-btc2-1',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV150730-30',
            botId: botA1.id,
            botName: `Settle · ${botA1.name}`,
            variant: 'A',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 100,
            feeUsd: 0,
            netPnlUsd: 0.1,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Settlement Kalshi (YES): WIN $1.00',
            createdAt: '2026-11-15T12:30:05.000Z',
          },
          {
            id: 'stl-btc2-2',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV150730-30',
            botId: botA1.id,
            botName: `Settle · ${botA1.name}`,
            variant: 'A',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 100,
            feeUsd: 0,
            netPnlUsd: 0.1,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Settlement Kalshi (YES): WIN $1.00',
            createdAt: '2026-11-15T12:30:06.000Z',
          },
        ],
      },
    },
  };

  const first = reconcileHistoryToHoldSettle(sampleState);
  assert.equal(first.convertedCount, 2);
  assert.equal(first.dedupedCount, 1);

  const day = first.state.dailyHistory!['2026-11-15'];
  assert.equal(day.entriesCount, 3);
  assert.equal(day.exitsCount, 3);
  assert.equal(day.wins, 2);
  assert.equal(day.losses, 1);
  assert.equal(day.feesUsd, 0.03); // only 3 entry fees, 0 exit fees
  assert.equal(day.realizedPnlUsd, -0.64);
  assert.equal(first.state.cashUsd, 19.36);
  assert.equal(first.state.dailyRealizedPnlUsd, -0.64);
  assert.equal(first.state.orders.length, 6);
  assert.equal(first.state.totalFilledOrders, 6);

  const btc1Sell = day.entries.find((e) => e.id === 'ord-btc1-sell')!;
  assert.equal(btc1Sell.priceCents, 100);
  assert.equal(btc1Sell.feeUsd, 0);
  assert.equal(btc1Sell.netPnlUsd, 0.14);
  assert.equal(btc1Sell.createdAt, '2026-11-15T12:00:05.000Z');
  assert.ok(btc1Sell.reason.includes('Settlement Kalshi (YES): WIN $1.00'));

  const eth1Sell = day.entries.find((e) => e.id === 'ord-eth1-sell')!;
  assert.equal(eth1Sell.priceCents, 0);
  assert.equal(eth1Sell.feeUsd, 0);
  assert.equal(eth1Sell.netPnlUsd, -0.87);
  assert.equal(eth1Sell.createdAt, '2026-11-15T12:15:05.000Z');
  assert.ok(eth1Sell.reason.includes('Settlement Kalshi (YES): LOSS $0.00'));

  const btc2Sell = day.entries.find((e) => e.ticker === 'KXBTC15M-26NOV150730-30' && e.action === 'sell')!;
  assert.equal(btc2Sell.netPnlUsd, 0.09);

  const updatedBot1 = first.state.bots.find((b) => b.id === botA1.id)!;
  const updatedBot2 = first.state.bots.find((b) => b.id === botA2.id)!;
  assert.equal(updatedBot1.tradesExecuted, 4);
  assert.equal(updatedBot1.realizedPnlUsd, 0.23);
  assert.equal(updatedBot2.tradesExecuted, 2);
  assert.equal(updatedBot2.realizedPnlUsd, -0.87);

  // Idempotent on second run
  const second = reconcileHistoryToHoldSettle(first.state);
  assert.equal(second.convertedCount, 0);
  assert.equal(second.dedupedCount, 0);
  assert.equal(second.state.cashUsd, 19.36);
  assert.equal(second.state.dailyRealizedPnlUsd, -0.64);
});

test('updateTrackedLowWithTime, updateTrackedHighWithTime, and formatContractElapsedMinute track extremes and timestamps accurately', () => {
  const closeIso = '2026-11-15T16:00:00.000Z'; // 15:45:00Z .. 16:00:00Z
  const openMs = Date.parse(closeIso) - 15 * 60_000;
  const buyIso = new Date(openMs + 5 * 60_000 + 15_000).toISOString(); // Mnt 05:15
  const buyMs = Date.parse(buyIso);

  // Before min 7, Low (7-13m) does not update
  let lowRes = updateTrackedLowWithTime(null, null, 84, closeIso, openMs + 6 * 60_000);
  assert.equal(lowRes.lowestBidCents, null);
  assert.equal(lowRes.lowestBidAt, null);

  // Inside 7-13m: dips to 79c at Mnt 09:20, then 72c at Mnt 11:45, recovers to 90c at Mnt 12:30
  lowRes = updateTrackedLowWithTime(lowRes.lowestBidCents, lowRes.lowestBidAt, 79, closeIso, openMs + 9 * 60_000 + 20_000);
  assert.equal(lowRes.lowestBidCents, 79);
  assert.equal(formatContractElapsedMinute(lowRes.lowestBidAt, buyIso), 'Mnt 09:20');

  lowRes = updateTrackedLowWithTime(lowRes.lowestBidCents, lowRes.lowestBidAt, 72, closeIso, openMs + 11 * 60_000 + 45_000);
  assert.equal(lowRes.lowestBidCents, 72);
  assert.equal(formatContractElapsedMinute(lowRes.lowestBidAt, buyIso), 'Mnt 11:45');

  lowRes = updateTrackedLowWithTime(lowRes.lowestBidCents, lowRes.lowestBidAt, 90, closeIso, openMs + 12 * 60_000 + 30_000);
  assert.equal(lowRes.lowestBidCents, 72);
  assert.equal(formatContractElapsedMinute(lowRes.lowestBidAt, buyIso), 'Mnt 11:45');

  // Outside 7-13m (Mnt 14:10), 10c dip does NOT overwrite 7-13m low
  lowRes = updateTrackedLowWithTime(lowRes.lowestBidCents, lowRes.lowestBidAt, 10, closeIso, openMs + 14 * 60_000 + 10_000);
  assert.equal(lowRes.lowestBidCents, 72);
  assert.equal(formatContractElapsedMinute(lowRes.lowestBidAt, buyIso), 'Mnt 11:45');

  // Highest price tracks from buyMs up to closeMs
  let highRes = updateTrackedHighWithTime(86, buyIso, 95, closeIso, openMs + 2 * 60_000, buyMs);
  assert.equal(highRes.highestBidCents, 86); // pre-entry tick ignored
  highRes = updateTrackedHighWithTime(highRes.highestBidCents, highRes.highestBidAt, 93, closeIso, openMs + 6 * 60_000 + 10_000, buyMs);
  assert.equal(highRes.highestBidCents, 93);
  assert.equal(formatContractElapsedMinute(highRes.highestBidAt, buyIso), 'Mnt 06:10');

  highRes = updateTrackedHighWithTime(highRes.highestBidCents, highRes.highestBidAt, 99, closeIso, openMs + 14 * 60_000 + 5_000, buyMs);
  assert.equal(highRes.highestBidCents, 99);
  assert.equal(formatContractElapsedMinute(highRes.highestBidAt, buyIso), 'Mnt 14:05');

  // Equal price later does NOT overwrite earlier reached minute
  highRes = updateTrackedHighWithTime(highRes.highestBidCents, highRes.highestBidAt, 99, closeIso, openMs + 14 * 60_000 + 55_000, buyMs);
  assert.equal(formatContractElapsedMinute(highRes.highestBidAt, buyIso), 'Mnt 14:05');
});

test('buildCalendarMonthGrid builds Monday-first calendar cells and aggregates monthly PnL', () => {
  const history = {
    '2026-11-15': {
      date: '2026-11-15',
      realizedPnlUsd: 5.9,
      feesUsd: 0.9,
      entriesCount: 88,
      exitsCount: 88,
      wins: 80,
      losses: 8,
      entriesByTicker: {},
      entries: [],
    },
    '2026-11-10': {
      date: '2026-11-10',
      realizedPnlUsd: -1.1,
      feesUsd: 0.1,
      entriesCount: 5,
      exitsCount: 5,
      wins: 3,
      losses: 2,
      entriesByTicker: {},
      entries: [],
    },
    '2026-10-31': {
      date: '2026-10-31',
      realizedPnlUsd: 2.0,
      feesUsd: 0.05,
      entriesCount: 4,
      exitsCount: 4,
      wins: 4,
      losses: 0,
      entriesByTicker: {},
      entries: [],
    },
  };

  // Nov 2026 starts on Sunday (index 6 in Mon-first grid) + 30 days = 37 > 35 -> 42 cells
  const novGrid = buildCalendarMonthGrid(2026, 10, history, '2026-11-15');
  assert.equal(novGrid.cells.length, 42);
  assert.equal(novGrid.cells[0].dateKey, '2026-10-26');
  assert.equal(novGrid.cells[0].inCurrentMonth, false);
  assert.equal(novGrid.cells[5].dateKey, '2026-10-31');
  assert.equal(novGrid.cells[5].inCurrentMonth, false);
  assert.equal(novGrid.cells[6].dateKey, '2026-11-01');
  assert.equal(novGrid.cells[6].inCurrentMonth, true);

  const nov15 = novGrid.cells.find((c) => c.dateKey === '2026-11-15')!;
  assert.equal(nov15.isToday, true);
  assert.equal(nov15.record?.realizedPnlUsd, 5.9);

  // Month totals must exclude Oct 31 even though it appears in the leading padding row
  assert.equal(novGrid.monthPnlUsd, 4.8);
  assert.equal(novGrid.monthEntries, 93);
  assert.equal(novGrid.activeDays, 2);
});

test('Varian A TP 99c executes sell at 99c cleanly and strict anti-falling-knife blocks pullbacks, dead-cat bounces, dropping bids, and red Kalshi 1m bars', () => {
  // 1. Even a -1c pullback from recent 6-tick peak [78, 82, 85, 86] -> mid 85 is BLOCKED
  const oneCentDip = evaluateRisingPriceMomentum([78, 82, 85, 86], 85, 'yes');
  assert.equal(oneCentDip.ok, false);
  assert.ok(oneCentDip.reason.includes('Anti pisau jatuh'));

  // 2. Dead-cat bounce below broader 16-tick peak (92 -> 84 -> 86 -> mid 87) is BLOCKED
  const deadCat = evaluateRisingPriceMomentum([92, 90, 88, 84, 83, 84, 86], 87, 'yes');
  assert.equal(deadCat.ok, false);
  assert.ok(deadCat.reason.includes('dead-cat') || deadCat.reason.includes('Anti'));

  // 3. Dropping real-time Bid trajectory (bid 86 -> 85) even if mid looks stable is BLOCKED
  const droppingBid = evaluateRisingPriceMomentum([78, 80, 82, 84, 86], 86, 'yes', {
    sideBid: 85,
    sideAsk: 86,
    sideBidHistory: [81, 83, 86],
  });
  assert.equal(droppingBid.ok, false);
  assert.ok(droppingBid.reason.includes('Bid YES'));

  // 4. Weak bid / wide spread (bid 82 vs ask 86) is BLOCKED
  const weakBid = evaluateRisingPriceMomentum([78, 80, 82, 84], 84, 'yes', {
    sideBid: 82,
    sideAsk: 86,
  });
  assert.equal(weakBid.ok, false);

  // 5. Red/rejected live Kalshi 1m contract bar blocks entry even if mid climbed slightly
  const nowMs = Date.parse('2026-11-15T16:10:30Z');
  const redKalshiBar = evaluateRisingPriceMomentum([78, 80, 82, 84, 86], 87, 'yes', {
    sideBid: 86,
    sideAsk: 87,
    sideBidHistory: [80, 82, 84, 86],
    kalshiLast1mBar: {
      timeSec: Math.floor(nowMs / 1000) - 10,
      open: 89,
      high: 90,
      low: 85,
      close: 86,
      volume: 200,
    },
    nowMs,
  });
  assert.equal(redKalshiBar.ok, false);
  assert.ok(redKalshiBar.reason.includes('Candle kontrak Kalshi 1m'));

  // 6. Clean rising mid + rising bid + tight spread + green Kalshi 1m bar is ACCEPTED
  const cleanMomentum = evaluateRisingPriceMomentum([78, 80, 82, 84, 86], 87, 'yes', {
    sideBid: 86,
    sideAsk: 87,
    sideBidHistory: [80, 82, 84, 86],
    kalshiLast1mBar: {
      timeSec: Math.floor(nowMs / 1000) - 10,
      open: 83,
      high: 87,
      low: 83,
      close: 87,
      volume: 250,
    },
    nowMs,
  });
  assert.equal(cleanMomentum.ok, true);

  // 7. Backtest with TP 99c (useTrailingStop: false) exits at 99c instead of selling prematurely on a 96->94 pullback
  const tp99Series = [74, 76, 78, 80, 82, 84, 85, 86, 87, 88, 90, 93, 96, 94, 97, 99, 98];
  const bt99 = runBacktest(
    {
      strategy: 'trailing_momentum',
      ticker: 'KXBTC15M',
      fairValueCents: 85,
      entryEdgeCents: 2,
      takeProfitCents: 15,
      takeProfitTargetCents: 99,
      holdToSettle: false,
      useTrailingStop: false,
      stopLossCents: 0,
      noStopLoss: true,
      entryTriggerCents: 85,
      maxEntryPriceCents: 91,
      minCandleConfidence: 55,
      contractsPerTrade: 1,
      initialCapitalUsd: 20,
    },
    tp99Series
  );
  const tp99Sell = bt99.trades.find((t) => t.action === 'sell');
  assert.ok(tp99Sell);
  assert.equal(tp99Sell.priceCents, 99);
  assert.ok(tp99Sell.reason.includes('TP Varian A (99¢'));

  // 8. reconcileHistoryToHoldSettle preserves future TP 99c trades cleanly without overwriting them
  const bot99: BotConfig = {
    ...DEFAULT_15M_TRAILING_BOTS[0],
    id: 'bot-15m-kxbtc15m',
    name: 'Varian A TP 99¢ · BTC',
    takeProfitTargetCents: 99,
    holdToSettle: false,
  };
  const tp99State: PortfolioState = {
    ...INITIAL_PORTFOLIO_STATE,
    cashUsd: 20.12,
    startingCashUsd: 20,
    dailyRealizedPnlUsd: 0.12,
    totalFilledOrders: 2,
    bots: [bot99],
    positions: [],
    orders: [
      {
        id: 'buy-99',
        clientOrderId: 'c-buy-99',
        botId: bot99.id,
        botName: bot99.name,
        ticker: 'KXBTC15M-26NOV151100-00',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 86,
        feeUsd: 0.01,
        totalUsd: 0.87,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry @ 86c',
        createdAt: '2026-11-15T15:52:00.000Z',
      },
      {
        id: 'sell-99',
        clientOrderId: 'c-sell-99',
        botId: bot99.id,
        botName: bot99.name,
        ticker: 'KXBTC15M-26NOV151100-00',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 99,
        feeUsd: 0.01,
        totalUsd: 0.98,
        mode: 'paper',
        status: 'filled',
        reason: 'TP Varian A (99¢) tercapai',
        createdAt: '2026-11-15T15:58:00.000Z',
      },
    ],
    dailyHistory: {
      '2026-11-15': {
        date: '2026-11-15',
        realizedPnlUsd: 0.12,
        feesUsd: 0.02,
        entriesCount: 1,
        exitsCount: 1,
        wins: 1,
        losses: 0,
        entriesByTicker: { 'KXBTC15M-26NOV151100-00': 1 },
        entries: [],
      },
    },
  };
  const preserved = reconcileHistoryToHoldSettle(tp99State);
  assert.equal(preserved.convertedCount, 0);
  assert.equal(preserved.state.orders.find((o) => o.id === 'sell-99')?.priceCents, 99);
});

test('reconcileHistoryToTpTarget recalculates Varian A history, cash, PnL, and win/loss at TP 99c while preserving Fix Settle trades below 99c and Varian B', () => {
  const botA1: BotConfig = {
    ...DEFAULT_15M_TRAILING_BOTS[0],
    id: 'bot-15m-kxbtc15m',
    name: 'Varian A TP 99¢ · BTC',
    takeProfitTargetCents: 99,
    holdToSettle: false,
  };
  const botA2: BotConfig = {
    ...DEFAULT_15M_TRAILING_BOTS[1],
    id: 'bot-15m-kxeth15m',
    name: 'Varian A TP 99¢ · ETH',
    takeProfitTargetCents: 99,
    holdToSettle: false,
  };
  const botB: BotConfig = {
    ...DEFAULT_VARIAN_B_BOTS[0],
    id: 'bot-varb-kxsol15m',
    name: 'Varian B Pre-Open · SOL',
  };

  // Trade 1 (BTC): bought @ 88c (fee 0.01), settled LOSE ($0.00 -> -0.89), BUT highestBidCents=99 at 16:27:30Z -> TP 99c WIN (+0.98 - 0.88 - 0.01 = +0.09, fee 0.01)
  // Trade 2 (ETH): bought @ 85c (fee 0.01), settled WIN ($1.00 -> +0.14), highestBidCents=99 at 16:12:20Z -> TP 99c WIN (+0.98 - 0.85 - 0.01 = +0.12, fee 0.01)
  // Trade 3 (BTC-2): bought @ 86c (fee 0.01), settled LOSE ($0.00 -> -0.87), highestBidCents=87 (<99) -> stays Fix Settle LOSE (-0.87, fee 0.00)
  // Trade 4 (Varian B SOL): bought @ 50c (fee 0.02), TP +16c @ 66c (+0.12) -> untouched
  // Combined exact net: +0.09 + 0.12 - 0.87 + 0.12 = -0.54 -> cashUsd = 20 - 0.54 = 19.46
  const sampleState: PortfolioState = {
    ...INITIAL_PORTFOLIO_STATE,
    cashUsd: 18.49,
    startingCashUsd: 20,
    dailyRealizedPnlUsd: -1.51,
    totalFilledOrders: 8,
    bots: [botA1, botA2, botB],
    positions: [],
    orders: [
      {
        id: 'b1',
        clientOrderId: 'c1',
        botId: botA1.id,
        botName: botA1.name,
        ticker: 'KXBTC15M-26NOV151130-30',
        side: 'no',
        action: 'buy',
        contracts: 1,
        priceCents: 88,
        feeUsd: 0.01,
        totalUsd: 0.89,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry',
        createdAt: '2026-11-15T16:25:00.000Z',
      },
      {
        id: 's1',
        clientOrderId: 'c2',
        botId: botA1.id,
        botName: `Settle · ${botA1.name}`,
        ticker: 'KXBTC15M-26NOV151130-30',
        side: 'no',
        action: 'sell',
        contracts: 1,
        priceCents: 1,
        feeUsd: 0,
        totalUsd: 0,
        mode: 'paper',
        status: 'filled',
        reason: 'Kontrak 15m selesai (YES)',
        createdAt: '2026-11-15T16:30:05.000Z',
      },
      {
        id: 'b2',
        clientOrderId: 'c3',
        botId: botA2.id,
        botName: botA2.name,
        ticker: 'KXETH15M-26NOV151115-15',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 85,
        feeUsd: 0.01,
        totalUsd: 0.86,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry',
        createdAt: '2026-11-15T16:10:00.000Z',
      },
      {
        id: 's2',
        clientOrderId: 'c4',
        botId: botA2.id,
        botName: `Settle · ${botA2.name}`,
        ticker: 'KXETH15M-26NOV151115-15',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 99,
        feeUsd: 0,
        totalUsd: 1,
        mode: 'paper',
        status: 'filled',
        reason: 'Kontrak 15m selesai (YES)',
        createdAt: '2026-11-15T16:15:05.000Z',
      },
      {
        id: 'b3',
        clientOrderId: 'c5',
        botId: botA1.id,
        botName: botA1.name,
        ticker: 'KXBTC15M-26NOV151100-00',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 86,
        feeUsd: 0.01,
        totalUsd: 0.87,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian A entry',
        createdAt: '2026-11-15T15:55:00.000Z',
      },
      {
        id: 's3',
        clientOrderId: 'c6',
        botId: botA1.id,
        botName: `Settle · ${botA1.name}`,
        ticker: 'KXBTC15M-26NOV151100-00',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 1,
        feeUsd: 0,
        totalUsd: 0,
        mode: 'paper',
        status: 'filled',
        reason: 'Kontrak 15m selesai (NO)',
        createdAt: '2026-11-15T16:00:05.000Z',
      },
      {
        id: 'b4',
        clientOrderId: 'c7',
        botId: botB.id,
        botName: botB.name,
        ticker: 'KXSOL15M-26NOV151100-00',
        side: 'yes',
        action: 'buy',
        contracts: 1,
        priceCents: 50,
        feeUsd: 0.02,
        totalUsd: 0.52,
        mode: 'paper',
        status: 'filled',
        reason: 'Varian B entry',
        createdAt: '2026-11-15T15:45:10.000Z',
      },
      {
        id: 's4',
        clientOrderId: 'c8',
        botId: botB.id,
        botName: botB.name,
        ticker: 'KXSOL15M-26NOV151100-00',
        side: 'yes',
        action: 'sell',
        contracts: 1,
        priceCents: 66,
        feeUsd: 0.02,
        totalUsd: 0.64,
        mode: 'paper',
        status: 'filled',
        reason: 'TP Varian B (+16¢) tercapai',
        createdAt: '2026-11-15T15:48:00.000Z',
      },
    ],
    dailyHistory: {
      '2026-11-15': {
        date: '2026-11-15',
        realizedPnlUsd: -1.51,
        feesUsd: 0.07,
        entriesCount: 4,
        exitsCount: 4,
        wins: 2,
        losses: 2,
        entriesByTicker: {},
        entries: [
          {
            id: 'b1',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV151130-30',
            botId: botA1.id,
            botName: botA1.name,
            variant: 'A',
            side: 'no',
            action: 'buy',
            contracts: 1,
            priceCents: 88,
            highestBidCents: 99,
            highestBidAt: '2026-11-15T16:27:30.000Z',
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            settleOutcome: 'lose',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Varian A entry',
            createdAt: '2026-11-15T16:25:00.000Z',
          },
          {
            id: 's1',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV151130-30',
            botId: botA1.id,
            botName: `Settle · ${botA1.name}`,
            variant: 'A',
            side: 'no',
            action: 'sell',
            contracts: 1,
            priceCents: 0,
            highestBidCents: 99,
            highestBidAt: '2026-11-15T16:27:30.000Z',
            feeUsd: 0,
            netPnlUsd: -0.89,
            settleOutcome: 'lose',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Settlement Kalshi (YES): LOSS $0.00',
            createdAt: '2026-11-15T16:30:05.000Z',
          },
          {
            id: 'b2',
            dateKey: '2026-11-15',
            ticker: 'KXETH15M-26NOV151115-15',
            botId: botA2.id,
            botName: botA2.name,
            variant: 'A',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 85,
            highestBidCents: 99,
            highestBidAt: '2026-11-15T16:12:20.000Z',
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Varian A entry',
            createdAt: '2026-11-15T16:10:00.000Z',
          },
          {
            id: 's2',
            dateKey: '2026-11-15',
            ticker: 'KXETH15M-26NOV151115-15',
            botId: botA2.id,
            botName: `Settle · ${botA2.name}`,
            variant: 'A',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 100,
            highestBidCents: 99,
            highestBidAt: '2026-11-15T16:12:20.000Z',
            feeUsd: 0,
            netPnlUsd: 0.14,
            settleOutcome: 'win',
            settleResultSide: 'yes',
            mode: 'paper',
            reason: 'Settlement Kalshi (YES): WIN $1.00',
            createdAt: '2026-11-15T16:15:05.000Z',
          },
          {
            id: 'b3',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV151100-00',
            botId: botA1.id,
            botName: botA1.name,
            variant: 'A',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 86,
            highestBidCents: 87,
            highestBidAt: '2026-11-15T15:56:00.000Z',
            feeUsd: 0.01,
            netPnlUsd: -0.01,
            settleOutcome: 'lose',
            settleResultSide: 'no',
            mode: 'paper',
            reason: 'Varian A entry',
            createdAt: '2026-11-15T15:55:00.000Z',
          },
          {
            id: 's3',
            dateKey: '2026-11-15',
            ticker: 'KXBTC15M-26NOV151100-00',
            botId: botA1.id,
            botName: `Settle · ${botA1.name}`,
            variant: 'A',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 0,
            highestBidCents: 87,
            highestBidAt: '2026-11-15T15:56:00.000Z',
            feeUsd: 0,
            netPnlUsd: -0.87,
            settleOutcome: 'lose',
            settleResultSide: 'no',
            mode: 'paper',
            reason: 'Settlement Kalshi (NO): LOSS $0.00',
            createdAt: '2026-11-15T16:00:05.000Z',
          },
          {
            id: 'b4',
            dateKey: '2026-11-15',
            ticker: 'KXSOL15M-26NOV151100-00',
            botId: botB.id,
            botName: botB.name,
            variant: 'B',
            side: 'yes',
            action: 'buy',
            contracts: 1,
            priceCents: 50,
            feeUsd: 0.02,
            netPnlUsd: -0.02,
            mode: 'paper',
            reason: 'Varian B entry',
            createdAt: '2026-11-15T15:45:10.000Z',
          },
          {
            id: 's4',
            dateKey: '2026-11-15',
            ticker: 'KXSOL15M-26NOV151100-00',
            botId: botB.id,
            botName: botB.name,
            variant: 'B',
            side: 'yes',
            action: 'sell',
            contracts: 1,
            priceCents: 66,
            feeUsd: 0.02,
            netPnlUsd: 0.12,
            mode: 'paper',
            reason: 'TP Varian B (+16¢) tercapai',
            createdAt: '2026-11-15T15:48:00.000Z',
          },
        ],
      },
    },
  };

  const first = reconcileHistoryToTpTarget(sampleState, 99);
  assert.equal(first.convertedCount, 2);
  assert.equal(first.dedupedCount, 0);

  const day = first.state.dailyHistory!['2026-11-15'];
  assert.equal(day.wins, 3);
  assert.equal(day.losses, 1);
  assert.equal(day.feesUsd, 0.09); // 0.01*3 VarA buys + 0.01*2 TP99 sells + 0.04 VarB
  assert.equal(day.realizedPnlUsd, -0.54);
  assert.equal(first.state.cashUsd, 19.46);
  assert.equal(first.state.dailyRealizedPnlUsd, -0.54);

  const s1 = day.entries.find((e) => e.id === 's1')!;
  assert.equal(s1.priceCents, 99);
  assert.equal(s1.feeUsd, 0.01);
  assert.equal(s1.netPnlUsd, 0.09);
  assert.equal(s1.settleOutcome, 'lose'); // preserves underlying 15m settle outcome
  assert.equal(s1.createdAt, '2026-11-15T16:27:30.000Z');
  assert.ok(s1.reason.includes('TP Varian A (Target 99¢)'));

  const s2 = day.entries.find((e) => e.id === 's2')!;
  assert.equal(s2.priceCents, 99);
  assert.equal(s2.feeUsd, 0.01);
  assert.equal(s2.netPnlUsd, 0.12);

  const s3 = day.entries.find((e) => e.id === 's3')!;
  assert.equal(s3.priceCents, 0);
  assert.equal(s3.feeUsd, 0);
  assert.equal(s3.netPnlUsd, -0.87);

  const s4 = day.entries.find((e) => e.id === 's4')!;
  assert.equal(s4.priceCents, 66);
  assert.equal(s4.netPnlUsd, 0.12);

  const ordS1 = first.state.orders.find((o) => o.id === 's1')!;
  assert.equal(ordS1.priceCents, 99);
  assert.equal(ordS1.feeUsd, 0.01);
  assert.equal(ordS1.totalUsd, 0.98);

  const updatedBotA1 = first.state.bots.find((b) => b.id === botA1.id)!;
  const updatedBotA2 = first.state.bots.find((b) => b.id === botA2.id)!;
  assert.equal(updatedBotA1.realizedPnlUsd, -0.78);
  assert.equal(updatedBotA2.realizedPnlUsd, 0.12);

  // Idempotent on second run
  const second = reconcileHistoryToTpTarget(first.state, 99);
  assert.equal(second.convertedCount, 0);
  assert.equal(second.dedupedCount, 0);
  assert.equal(second.state.cashUsd, 19.46);
});









