export type MarketCategory = 'Crypto' | 'Commodities' | 'Forex';

export type StrategyType =
  | 'mean_reversion'
  | 'orderbook_imbalance'
  | 'market_maker'
  | 'momentum_breakout'
  | 'trailing_momentum'
  | 'candle_prediction'
  | 'preopen_spike';

export type StrategyVariant = 'A' | 'B';

export type BotStatus = 'running' | 'paused' | 'halted';

export type OrderSide = 'yes' | 'no';

export type OrderAction = 'buy' | 'sell';

export type ExecutionMode = 'paper' | 'live';

export type SettleOutcome = 'pending' | 'win' | 'lose';

export type PredictionDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface OhlcCandle {
  timeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Candle1mConfirmation {
  direction: PredictionDirection;
  lastCandleDir: PredictionDirection;
  prevCandleDir?: PredictionDirection;
  emaFast: number;
  emaSlow: number;
  rsi: number;
  patterns: string[];
  summary: string;
  candleCount: number;
  updatedAt: string;
}

export interface CandlePrediction {
  source: 'spot_5m' | 'kalshi_5m' | 'spot_1m' | 'kalshi_1m' | 'hybrid';
  symbol: string;
  timeframe: '5m' | '1m';
  currentPrice: number;
  targetPrice: number | null;
  predictedPrice: number;
  predictedDeltaPct: number;
  predictedYesCents: number;
  direction: PredictionDirection;
  predictedSide: OrderSide | 'neutral';
  confidencePct: number;
  emaFast: number;
  emaSlow: number;
  rsi: number;
  atr: number;
  bullishScore: number;
  bearishScore: number;
  patterns: string[];
  summary: string;
  candleCount: number;
  lastCandleDir?: PredictionDirection;
  prevCandleDir?: PredictionDirection;
  shortTermDriftPct?: number;
  confirm1m?: Candle1mConfirmation;
  updatedAt: string;
}

export interface KalshiMarket {
  ticker: string;
  seriesTicker?: string;
  eventTicker: string;
  title: string;
  subtitle: string;
  category: MarketCategory;
  timeframe?: '15m' | 'standard';
  pairSymbol?: string;
  targetPrice?: number | null;
  yesBid: number; // cents 1..99
  yesAsk: number; // cents 1..99
  noBid: number; // cents 1..99
  noAsk: number; // cents 1..99
  lastPrice: number; // cents 1..99
  previousPrice: number; // cents 1..99
  volume24h: number;
  openInterest: number;
  closeTime: string;
  status: 'active' | 'closed' | 'settled';
  priceHistory: number[]; // recent mid/trade prices in cents
  yesBidHistory?: number[]; // recent live YES best-bid changes in cents
  noBidHistory?: number[]; // recent live NO best-bid changes in cents
  kalshiLast1mBar?: OhlcCandle; // latest live 1m Kalshi contract OHLC bar
  candlePrediction?: CandlePrediction;
  preOpenPrediction?: CandlePrediction;
  source: 'kalshi_live' | 'kalshi_offline';
}

export interface OrderBookLevel {
  price: number; // cents 1..99
  quantity: number;
}

export interface OrderBook {
  ticker: string;
  yesBids: OrderBookLevel[]; // sorted desc by price
  noBids: OrderBookLevel[]; // sorted desc by price
  updatedAt: string;
}

export interface BotConfig {
  id: string;
  name: string;
  ticker: string;
  strategy: StrategyType;
  status: BotStatus;
  executionMode: ExecutionMode;
  targetSide: OrderSide | 'auto';
  fairValueCents: number; // used by mean_reversion (1..99)
  entryEdgeCents: number; // min edge / threshold in cents
  takeProfitCents: number;
  stopLossCents: number;
  noStopLoss?: boolean; // when true (or stopLossCents === 0), skip Stop Loss exits
  // Trailing momentum / Varian A parameters
  entryTriggerCents?: number; // min entry price in cents (e.g. 85)
  entryBandCents?: number; // legacy band
  trailingActivationCents?: number; // legacy trail activation
  trailingDistanceCents?: number; // trail pullback distance in cents
  takeProfitTargetCents?: number; // fixed ceiling target price in cents (e.g. 99)
  holdToSettle?: boolean; // skip early TP & trailing stop; hold until Kalshi Fix Settle
  useTrailingStop?: boolean; // when false, hold until fixed TP target (e.g. 99c) or Fix Settle
  useCandleFilter?: boolean; // require/filter by 1m candle prediction
  minCandleConfidence?: number; // 50..95 threshold for candle prediction
  // Pre-Open Spike parameters (Varian B)
  entryDelayMinSec?: number; // default 5s after open
  entryDelayMaxSec?: number; // default 15s spread-wait ceiling
  entryWindowEndSec?: number; // default 90s post-open entry cutoff
  maxEntryPriceCents?: number; // max Ask entry cap (91c Varian A, 65c Varian B)
  trailingActivationDeltaCents?: number; // activate trailing stop at +3c (Varian A) or +10c (Varian B) gain
  trailingMinProfitCents?: number; // minimum locked profit in cents to allow trailing stop sell (e.g. +3c)
  hardCloseMinute?: number; // hard time-stop at minute 6
  maxContractsPerOrder: number;
  maxPositionContracts: number;
  maxSpreadCents: number;
  intervalSeconds: number;
  createdAt: string;
  lastRunAt: string | null;
  lastSignalReason: string;
  tradesExecuted: number;
  realizedPnlUsd: number;
}

export interface Position {
  ticker: string;
  marketTitle: string;
  side: OrderSide;
  botId?: string | null;
  variant?: StrategyVariant;
  contracts: number;
  avgEntryCents: number;
  peakBidCents?: number;
  peakBidAt?: string;
  lowestBidCents?: number;
  lowestBidAt?: string;
  trailingActivated?: boolean;
  realizedPnlUsd: number;
  updatedAt: string;
}

export interface OrderRecord {
  id: string;
  clientOrderId: string;
  botId: string | null;
  botName: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  contracts: number;
  priceCents: number;
  feeUsd: number;
  totalUsd: number;
  mode: ExecutionMode;
  status: 'filled' | 'skipped' | 'risk_blocked' | 'error';
  reason: string;
  createdAt: string;
}

export interface RiskLimits {
  maxDailyLossUsd: number;
  maxExposurePerMarketUsd: number;
  maxOpenOrders: number;
  killSwitchActive: boolean;
}

export interface DailyTradeEntry {
  id: string;
  dateKey: string;
  ticker: string;
  botId: string | null;
  botName: string;
  variant?: StrategyVariant;
  side: OrderSide;
  action: OrderAction;
  contracts: number;
  priceCents: number;
  lowestBidCents?: number | null;
  lowestBidAt?: string | null;
  highestBidCents?: number | null;
  highestBidAt?: string | null;
  feeUsd: number;
  netPnlUsd: number | null;
  settleOutcome?: SettleOutcome;
  settleResultSide?: OrderSide;
  mode: ExecutionMode;
  reason: string;
  createdAt: string;
}

export interface DailyPnlRecord {
  date: string;
  realizedPnlUsd: number;
  feesUsd: number;
  entriesCount: number;
  exitsCount: number;
  wins: number;
  losses: number;
  entriesByTicker: Record<string, number>;
  entries: DailyTradeEntry[];
}

export interface PortfolioState {
  cashUsd: number;
  startingCashUsd: number;
  dailyRealizedPnlUsd: number;
  totalFilledOrders?: number;
  tradingPaused?: boolean;
  tradedTickers?: string[];
  dailyHistory?: Record<string, DailyPnlRecord>;
  positions: Position[];
  orders: OrderRecord[];
  bots: BotConfig[];
  riskLimits: RiskLimits;
  executionMode: ExecutionMode;
  updatedAt: string;
}

export interface OrderbookMetrics {
  bestYesBid: number;
  bestYesAsk: number;
  bestNoBid: number;
  bestNoAsk: number;
  spreadCents: number;
  midPriceCents: number;
  yesDepthTop3: number;
  noDepthTop3: number;
  imbalanceRatio: number; // -1 (all NO pressure) to +1 (all YES pressure)
}

export interface BotDecision {
  shouldTrade: boolean;
  action: OrderAction;
  side: OrderSide;
  contracts: number;
  priceCents: number;
  estimatedFeeUsd: number;
  blockedByRisk: boolean;
  reason: string;
  updatedPeakBidCents?: number;
  updatedPeakBidAt?: string;
  updatedLowBidCents?: number;
  updatedLowBidAt?: string;
  trailingActivated?: boolean;
}

export interface BacktestParams {
  strategy: StrategyType;
  ticker: string;
  fairValueCents: number;
  entryEdgeCents: number;
  takeProfitCents: number;
  stopLossCents: number;
  noStopLoss?: boolean;
  entryTriggerCents?: number;
  trailingActivationCents?: number;
  trailingDistanceCents?: number;
  takeProfitTargetCents?: number;
  holdToSettle?: boolean;
  useTrailingStop?: boolean;
  useCandleFilter?: boolean;
  minCandleConfidence?: number;
  maxEntryPriceCents?: number;
  trailingActivationDeltaCents?: number;
  trailingMinProfitCents?: number;
  hardCloseMinute?: number;
  contractsPerTrade: number;
  initialCapitalUsd: number;
}

export interface BacktestTrade {
  tickIndex: number;
  side: OrderSide;
  action: OrderAction;
  priceCents: number;
  contracts: number;
  feeUsd: number;
  pnlUsd: number;
  equityUsd: number;
  reason: string;
}

export interface BacktestResult {
  finalEquityUsd: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winRatePct: number;
  totalFeesUsd: number;
  equityCurve: number[];
  trades: BacktestTrade[];
}

export interface ApiConnectionStatus {
  kalshiEnv: 'demo' | 'prod';
  hasCredentials: boolean;
  publicFeedOnline: boolean;
  lastFeedSyncAt: string | null;
  baseUrl: string;
}

export interface RealtimeStatePayload {
  type: 'init' | 'tick' | 'state_update';
  markets: KalshiMarket[];
  orderbooks: Record<string, OrderBook>;
  portfolio: PortfolioState;
  apiStatus: ApiConnectionStatus;
  serverTimeMs: number;
  executedCount?: number;
}
