import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { buildKalshiAuthHeaders } from './src/engine/kalshiAuth.ts';
import {
  aggregateCandlesTo5m,
  analyzeCandlesAndPredict,
  analyzePreOpenSetup,
  parseKalshiTargetPrice,
} from './src/engine/candleAnalyzer.ts';
import {
  calcContractCost,
  calcKalshiFee,
  clampCents,
  clearVariantHistoryAndPnl,
  deriveTopOfBookFromOrderbook,
  formatPairLabel,
  getDateKeyWib,
  getNext15mBoundaryIso,
  getSeriesTicker,
  isInsideMinuteWindow,
  KALSHI_15M_SERIES,
  reconcileHistoryToHoldSettle,
  reconcileHistoryToTpTarget,
  resolveSettleOutcome,
  resolveStrategyVariant,
  updateTrackedHighWithTime,
  updateTrackedLowWithTime,
} from './src/engine/kalshiMath.ts';
import {
  createTrailing15mBotForMarket,
  createVarianBPreOpenBotForMarket,
  INITIAL_PORTFOLIO_STATE,
  MARKETS_15M_SEED,
  SEED_MARKETS,
} from './src/engine/seedMarkets.ts';
import { evaluateBotSignal, runBacktest, validateBotConfig } from './src/engine/strategyEngine.ts';
import type {
  ApiConnectionStatus,
  BotConfig,
  CandlePrediction,
  DailyPnlRecord,
  DailyTradeEntry,
  ExecutionMode,
  KalshiMarket,
  MarketCategory,
  OhlcCandle,
  OrderAction,
  OrderBook,
  OrderRecord,
  OrderSide,
  PortfolioState,
  Position,
  RealtimeStatePayload,
  RiskLimits,
  StrategyVariant,
} from './src/engine/types.ts';

function getRawTickerFromTradedKey(key: string): string {
  const sepIdx = key.indexOf('::');
  return sepIdx >= 0 ? key.slice(sepIdx + 2) : key;
}

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'kalshi-bot-state.json');

const KALSHI_ENV = process.env.KALSHI_ENV === 'prod' ? 'prod' : 'demo';
const KALSHI_BASE_URL =
  KALSHI_ENV === 'prod'
    ? 'https://api.elections.kalshi.com'
    : 'https://demo-api.kalshi.co';
const KALSHI_PUBLIC_MARKET_URL = 'https://api.elections.kalshi.com';
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID?.trim() || '';
const KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY?.trim() || '';
const HAS_CREDENTIALS = Boolean(KALSHI_API_KEY_ID && KALSHI_PRIVATE_KEY);

function is15mMarketTicker(ticker: string): boolean {
  const upper = ticker.toUpperCase();
  return (
    upper.includes('15M') ||
    KALSHI_15M_SERIES.some((s) => upper.startsWith(s.seriesTicker)) ||
    MARKETS_15M_SEED.some((m) => m.ticker.toUpperCase() === upper)
  );
}

function isLegacyMockTicker(ticker: string): boolean {
  const upper = ticker.toUpperCase();
  return upper.endsWith('-UP') || upper.includes('KXXAU') || upper.includes('KXXAG');
}

function loadPersistedState(): PortfolioState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as PortfolioState;
      if (parsed && Array.isArray(parsed.bots) && Array.isArray(parsed.positions)) {
        const hadNon15m =
          parsed.bots.some((b) => !is15mMarketTicker(b.ticker)) ||
          parsed.positions.some((p) => !is15mMarketTicker(p.ticker)) ||
          parsed.orders.some((o) => !is15mMarketTicker(o.ticker));

        const hadLegacyMock =
          parsed.bots.some((b) => isLegacyMockTicker(b.ticker)) ||
          parsed.positions.some((p) => isLegacyMockTicker(p.ticker)) ||
          parsed.orders.some((o) => isLegacyMockTicker(o.ticker));

        if (hadNon15m || hadLegacyMock) {
          const fresh = structuredClone(INITIAL_PORTFOLIO_STATE);
          fresh.executionMode = parsed.executionMode ?? 'paper';
          fresh.riskLimits = parsed.riskLimits ?? fresh.riskLimits;
          if (fresh.riskLimits.maxOpenOrders < 40) {
            fresh.riskLimits.maxOpenOrders = 40;
          }
          savePersistedState(fresh);
          return fresh;
        }

        parsed.bots = parsed.bots.filter((b) => is15mMarketTicker(b.ticker));
        parsed.positions = parsed.positions.filter((p) => is15mMarketTicker(p.ticker));
        parsed.orders = parsed.orders.filter((o) => is15mMarketTicker(o.ticker));

        if (!parsed.riskLimits) {
          parsed.riskLimits = structuredClone(INITIAL_PORTFOLIO_STATE.riskLimits);
        } else if (parsed.riskLimits.maxOpenOrders < 40) {
          parsed.riskLimits.maxOpenOrders = 40;
        }

        // Ensure all 15m series have bots for whichever variants are active (do not resurrect user-deleted variants)
        const shouldAutoFillVarA =
          parsed.bots.length === 0 ||
          parsed.bots.some((b) => b.strategy !== 'preopen_spike');
        const shouldAutoFillVarB =
          parsed.bots.length === 0 ||
          parsed.bots.some((b) => b.strategy === 'preopen_spike' || b.id.startsWith('bot-varb-'));

        for (const m of MARKETS_15M_SEED) {
          const series = getSeriesTicker(m.ticker);
          if (
            shouldAutoFillVarA &&
            !parsed.bots.some((b) => getSeriesTicker(b.ticker) === series && b.strategy !== 'preopen_spike')
          ) {
            const varA = createTrailing15mBotForMarket(m);
            varA.status = parsed.tradingPaused ? 'paused' : 'running';
            varA.executionMode = parsed.executionMode ?? 'paper';
            parsed.bots.push(varA);
          }
          if (
            shouldAutoFillVarB &&
            !parsed.bots.some((b) => getSeriesTicker(b.ticker) === series && b.strategy === 'preopen_spike')
          ) {
            const varB = createVarianBPreOpenBotForMarket(m);
            varB.status = parsed.tradingPaused ? 'paused' : 'running';
            varB.executionMode = parsed.executionMode ?? 'paper';
            parsed.bots.push(varB);
          }
        }
        parsed.bots = parsed.bots.map((b) => {
          if (b.strategy === 'preopen_spike' || b.id.startsWith('bot-varb-')) {
            const migrateMax65 =
              b.maxEntryPriceCents === undefined || b.maxEntryPriceCents === 60
                ? 65
                : b.maxEntryPriceCents;
            const migrateNoSlVarB =
              b.noStopLoss === undefined || b.stopLossCents === 20
                ? true
                : Boolean(b.noStopLoss);
            return {
              ...b,
              name: `Varian B Pre-Open · ${formatPairLabel(b.ticker)}`,
              entryDelayMinSec: b.entryDelayMinSec ?? 5,
              entryDelayMaxSec: b.entryDelayMaxSec ?? 15,
              entryWindowEndSec: b.entryWindowEndSec ?? 90,
              maxEntryPriceCents: migrateMax65,
              trailingActivationDeltaCents: b.trailingActivationDeltaCents ?? 10,
              trailingDistanceCents: b.trailingDistanceCents ?? 2,
              hardCloseMinute: b.hardCloseMinute ?? 6,
              takeProfitCents: b.takeProfitCents || 16,
              noStopLoss: migrateNoSlVarB,
              stopLossCents: migrateNoSlVarB ? 0 : (b.stopLossCents || 0),
            };
          }
          if (b.id.startsWith('bot-15m-')) {
            const isLegacyVarA =
              b.noStopLoss === undefined ||
              b.stopLossCents === 70 ||
              b.stopLossCents === 15 ||
              b.stopLossCents === 5 ||
              b.name.includes('Baca Candle') ||
              b.name.includes('Varian A Hold Settle') ||
              b.name.includes('TP+') ||
              (b.strategy === 'trailing_momentum' && !b.name.includes('TP 99'));
            if (isLegacyVarA) {
              return {
                ...b,
                strategy: 'trailing_momentum',
                name: `Varian A TP 99¢ · ${formatPairLabel(b.ticker)}`,
                fairValueCents: 85,
                entryTriggerCents: 85,
                maxEntryPriceCents: 91,
                entryBandCents: 0,
                trailingActivationCents: 88,
                takeProfitTargetCents: 99,
                takeProfitCents: 15,
                stopLossCents: 0,
                noStopLoss: true,
                holdToSettle: false,
                useTrailingStop: false,
                useCandleFilter: true,
                minCandleConfidence: b.minCandleConfidence ?? 60,
                trailingActivationDeltaCents: 3,
                trailingMinProfitCents: 3,
                trailingDistanceCents: 2,
                intervalSeconds: 1,
                lastSignalReason:
                  'Varian A aktif — entry 85–91¢ harga naik ketat (anti pisau jatuh) + arah 5m & konfirm 1m, TP 99¢ (atau Settle), No SL.',
              };
            }
            const resolvedHoldSettle = Boolean(b.holdToSettle);
            const resolvedTpTarget = resolvedHoldSettle ? 0 : (b.takeProfitTargetCents ?? 99);
            const resolvedTpCents = resolvedHoldSettle ? 0 : (b.takeProfitCents || 15);
            const resolvedUseTrailing = b.useTrailingStop ?? (resolvedTpTarget < 50);
            return {
              ...b,
              name:
                b.strategy === 'trailing_momentum'
                  ? resolvedHoldSettle
                    ? `Varian A Hold Settle · ${formatPairLabel(b.ticker)}`
                    : resolvedTpTarget >= 50
                      ? `Varian A TP ${resolvedTpTarget}¢ · ${formatPairLabel(b.ticker)}`
                      : `Varian A TP+${resolvedTpCents} · ${formatPairLabel(b.ticker)}`
                  : b.name,
              ...(b.strategy === 'trailing_momentum'
                ? {
                    entryTriggerCents: b.entryTriggerCents ?? 85,
                    maxEntryPriceCents: b.maxEntryPriceCents ?? 91,
                    takeProfitCents: resolvedTpCents,
                    takeProfitTargetCents: resolvedTpTarget,
                    holdToSettle: resolvedHoldSettle,
                    useTrailingStop: resolvedUseTrailing,
                    trailingActivationCents: b.trailingActivationCents ?? 88,
                    trailingActivationDeltaCents: b.trailingActivationDeltaCents ?? 3,
                    trailingMinProfitCents: b.trailingMinProfitCents ?? 3,
                    trailingDistanceCents: b.trailingDistanceCents ?? 2,
                    intervalSeconds: 1,
                  }
                : {}),
              useCandleFilter: b.useCandleFilter ?? true,
              minCandleConfidence: b.minCandleConfidence ?? 60,
            };
          }
          return b;
        });
        // Reconcile realized PnL invariant: cash + openCostBasis - startingCash (includes both entry & exit fees)
        const openCostBasis = parsed.positions.reduce(
          (sum, p) => sum + calcContractCost(p.contracts, p.avgEntryCents),
          0
        );
        parsed.dailyRealizedPnlUsd = Number(
          (parsed.cashUsd + openCostBasis - parsed.startingCashUsd).toFixed(2)
        );
        if (typeof parsed.totalFilledOrders !== 'number') {
          const botTradesTotal = parsed.bots.reduce((sum, b) => sum + b.tradesExecuted, 0);
          const recentFilled = parsed.orders.filter((o) => o.status === 'filled').length;
          parsed.totalFilledOrders = Math.max(botTradesTotal, recentFilled);
        }
        if (typeof parsed.tradingPaused !== 'boolean') {
          parsed.tradingPaused = parsed.bots.length > 0 && parsed.bots.every((b) => b.status !== 'running');
        }
        if (!parsed.dailyHistory || typeof parsed.dailyHistory !== 'object') {
          const backfill: Record<string, DailyPnlRecord> = {};
          const todayKey = getDateKeyWib(Date.now());
          const filledOrders = parsed.orders.filter((o) => o.status === 'filled');
          for (const o of filledOrders) {
            const dk = getDateKeyWib(o.createdAt);
            if (!backfill[dk]) {
              backfill[dk] = {
                date: dk,
                realizedPnlUsd: 0,
                feesUsd: 0,
                entriesCount: 0,
                exitsCount: 0,
                wins: 0,
                losses: 0,
                entriesByTicker: {},
                entries: [],
              };
            }
            const rec = backfill[dk];
            rec.feesUsd = Number((rec.feesUsd + o.feeUsd).toFixed(2));
            if (o.action === 'buy') {
              rec.entriesCount += 1;
              rec.entriesByTicker[o.ticker] = (rec.entriesByTicker[o.ticker] ?? 0) + 1;
            } else {
              rec.exitsCount += 1;
            }
            if (rec.entries.length < 300) {
              rec.entries.push({
                id: o.id,
                dateKey: dk,
                ticker: o.ticker,
                botId: o.botId,
                botName: o.botName,
                variant: resolveStrategyVariant(o.botId, o.botName),
                side: o.side,
                action: o.action,
                contracts: o.contracts,
                priceCents: o.priceCents,
                feeUsd: o.feeUsd,
                netPnlUsd: o.action === 'buy' ? -o.feeUsd : null,
                mode: o.mode,
                reason: o.reason,
                createdAt: o.createdAt,
              });
            }
          }
          if (!backfill[todayKey] && parsed.dailyRealizedPnlUsd !== 0) {
            backfill[todayKey] = {
              date: todayKey,
              realizedPnlUsd: parsed.dailyRealizedPnlUsd,
              feesUsd: 0,
              entriesCount: 0,
              exitsCount: 0,
              wins: 0,
              losses: 0,
              entriesByTicker: {},
              entries: [],
            };
          } else if (backfill[todayKey]) {
            backfill[todayKey].realizedPnlUsd = parsed.dailyRealizedPnlUsd;
          }
          parsed.dailyHistory = backfill;
        }
        const tradedSet = new Set<string>(
          Array.isArray(parsed.tradedTickers)
            ? parsed.tradedTickers.filter(
                (t): t is string => typeof t === 'string' && is15mMarketTicker(getRawTickerFromTradedKey(t))
              )
            : []
        );
        for (const o of parsed.orders) {
          if (o.action === 'buy' && o.status === 'filled' && is15mMarketTicker(o.ticker)) {
            if (o.botId) {
              tradedSet.add(`${o.botId}::${o.ticker}`);
            } else {
              tradedSet.add(o.ticker);
            }
          }
        }
        for (const p of parsed.positions) {
          if (p.contracts > 0 && is15mMarketTicker(p.ticker)) {
            if (p.botId) {
              tradedSet.add(`${p.botId}::${p.ticker}`);
            } else {
              tradedSet.add(p.ticker);
            }
          }
        }
        parsed.tradedTickers = Array.from(tradedSet).slice(-400);
        const hasFixedTpVarA = parsed.bots.some(
          (b) =>
            resolveStrategyVariant(b.id, b.name, b.strategy) === 'A' &&
            !b.holdToSettle &&
            (b.takeProfitTargetCents ?? 0) >= 50
        );
        const reconciledHistory = hasFixedTpVarA
          ? reconcileHistoryToTpTarget(parsed).state
          : reconcileHistoryToHoldSettle(parsed).state;
        savePersistedState(reconciledHistory);
        return reconciledHistory;
      }
    }
  } catch (err) {
    console.warn('[kalshi-bot] Failed to read persisted state, using default:', err);
  }
  return structuredClone(INITIAL_PORTFOLIO_STATE);
}

function savePersistedState(state: PortfolioState) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[kalshi-bot] Failed to persist state:', err);
  }
}

function ensureValid15mCloseTime(closeTimeIso: string | undefined, nowMs: number): string {
  if (!closeTimeIso) return getNext15mBoundaryIso(nowMs);
  const parsed = Date.parse(closeTimeIso);
  if (!Number.isFinite(parsed) || parsed <= nowMs) {
    return getNext15mBoundaryIso(nowMs);
  }
  return closeTimeIso;
}

let portfolioState: PortfolioState = loadPersistedState();
let marketsCache: KalshiMarket[] = structuredClone(SEED_MARKETS).map((m) => ({
  ...m,
  closeTime: ensureValid15mCloseTime(m.closeTime, Date.now()),
}));
let orderbooksCache: Record<string, OrderBook> = {};
const seededTradeHistoryTickers = new Set<string>();
const settledMarketResults = new Map<string, OrderSide>();
let lastPendingSettleCheckMs = 0;

interface SpotFeedSpec {
  provider: 'binance' | 'yahoo';
  symbol: string;
  ttlMs: number;
}

const SERIES_SPOT_FEED: Record<string, SpotFeedSpec> = {
  KXBTC15M: { provider: 'binance', symbol: 'BTCUSDT', ttlMs: 1_000 },
  KXETH15M: { provider: 'binance', symbol: 'ETHUSDT', ttlMs: 1_000 },
  KXSOL15M: { provider: 'binance', symbol: 'SOLUSDT', ttlMs: 1_000 },
  KXBNB15M: { provider: 'binance', symbol: 'BNBUSDT', ttlMs: 1_000 },
  KXDOGE15M: { provider: 'binance', symbol: 'DOGEUSDT', ttlMs: 1_000 },
  KXHYPE15M: { provider: 'binance', symbol: 'HYPEUSDT', ttlMs: 1_000 },
  KXNEAR15M: { provider: 'binance', symbol: 'NEARUSDT', ttlMs: 1_000 },
  KXXRP15M: { provider: 'binance', symbol: 'XRPUSDT', ttlMs: 1_000 },
  KXZEC15M: { provider: 'binance', symbol: 'ZECUSDT', ttlMs: 1_000 },
  KXGOLD15M: { provider: 'yahoo', symbol: 'GC=F', ttlMs: 5_000 },
  KXWTI15M: { provider: 'yahoo', symbol: 'CL=F', ttlMs: 5_000 },
  KXSILVER15M: { provider: 'yahoo', symbol: 'SI=F', ttlMs: 5_000 },
  KXEURUSD15M: { provider: 'yahoo', symbol: 'EURUSD=X', ttlMs: 5_000 },
  KXUSDJPY15M: { provider: 'yahoo', symbol: 'JPY=X', ttlMs: 5_000 },
  KXGBPUSD15M: { provider: 'yahoo', symbol: 'GBPUSD=X', ttlMs: 5_000 },
};

const spotCandles1mCache = new Map<string, { candles: OhlcCandle[]; fetchedAtMs: number; symbol: string }>();
const spotCandles5mCache = new Map<string, { candles: OhlcCandle[]; fetchedAtMs: number; symbol: string }>();
const kalshiCandles1mCache = new Map<string, { candles: OhlcCandle[]; fetchedAtMs: number }>();
const kalshiCandles5mCache = new Map<string, { candles: OhlcCandle[]; fetchedAtMs: number }>();
const preOpenBiasCache = new Map<string, CandlePrediction>();
const lastOrderbookFetchMs = new Map<string, number>();

async function fetchSpotCandlesForSeries(
  seriesTicker: string,
  timeframe: '1m' | '5m' = '1m',
  force = false
): Promise<OhlcCandle[]> {
  const spec = SERIES_SPOT_FEED[seriesTicker];
  if (!spec) return [];
  const cacheMap = timeframe === '5m' ? spotCandles5mCache : spotCandles1mCache;
  const effectiveTtlMs = timeframe === '5m' ? Math.max(1_500, spec.ttlMs) : spec.ttlMs;
  const cached = cacheMap.get(seriesTicker);
  const nowMs = Date.now();
  if (!force && cached && nowMs - cached.fetchedAtMs < effectiveTtlMs) {
    return cached.candles;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    if (spec.provider === 'binance') {
      const res = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(spec.symbol)}&interval=${timeframe}&limit=45`,
        {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        }
      );
      clearTimeout(timer);
      if (!res.ok) return cached?.candles ?? [];
      const rows = (await res.json()) as Array<Array<string | number>>;
      if (!Array.isArray(rows)) return cached?.candles ?? [];
      const candles: OhlcCandle[] = rows
        .map((r) => ({
          timeSec: Math.floor(Number(r[0]) / 1000),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5] ?? 0),
        }))
        .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close) && c.timeSec > 0);
      if (candles.length > 0) {
        cacheMap.set(seriesTicker, { candles, fetchedAtMs: nowMs, symbol: spec.symbol });
        return candles;
      }
    } else {
      const rangeParam = timeframe === '5m' ? '5d' : '1d';
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.symbol)}?interval=${timeframe}&range=${rangeParam}`,
        {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        }
      );
      clearTimeout(timer);
      if (!res.ok) return cached?.candles ?? [];
      const json = (await res.json()) as {
        chart?: {
          result?: Array<{
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: Array<number | null>;
                high?: Array<number | null>;
                low?: Array<number | null>;
                close?: Array<number | null>;
                volume?: Array<number | null>;
              }>;
            };
          }>;
        };
      };
      const result = json.chart?.result?.[0];
      const ts = result?.timestamp ?? [];
      const q = result?.indicators?.quote?.[0];
      const candles: OhlcCandle[] = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q?.open?.[i];
        const h = q?.high?.[i];
        const l = q?.low?.[i];
        const c = q?.close?.[i];
        const v = q?.volume?.[i] ?? 0;
        if (
          typeof ts[i] === 'number' &&
          typeof o === 'number' &&
          typeof h === 'number' &&
          typeof l === 'number' &&
          typeof c === 'number' &&
          Number.isFinite(o) &&
          Number.isFinite(h) &&
          Number.isFinite(l) &&
          Number.isFinite(c)
        ) {
          candles.push({
            timeSec: ts[i],
            open: o,
            high: h,
            low: l,
            close: c,
            volume: typeof v === 'number' && Number.isFinite(v) ? v : 0,
          });
        }
      }
      const trimmed = candles.slice(-45);
      if (trimmed.length > 0) {
        cacheMap.set(seriesTicker, { candles: trimmed, fetchedAtMs: nowMs, symbol: spec.symbol });
        return trimmed;
      }
    }
  } catch {
    clearTimeout(timer);
  }
  return cached?.candles ?? [];
}

async function fetchKalshiCandlesForTicker(
  seriesTicker: string,
  ticker: string,
  periodMinutes: 1 | 5 = 1,
  force = false
): Promise<OhlcCandle[]> {
  const cacheMap = periodMinutes === 5 ? kalshiCandles5mCache : kalshiCandles1mCache;
  const ttlMs = periodMinutes === 5 ? 3_000 : 2_000;
  const cached = cacheMap.get(ticker);
  const nowMs = Date.now();
  if (!force && cached && nowMs - cached.fetchedAtMs < ttlMs) {
    return cached.candles;
  }

  const nowSec = Math.floor(nowMs / 1000);
  const startSec = nowSec - (periodMinutes === 5 ? 6 * 3600 : 3600);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(
      `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startSec}&end_ts=${nowSec}&period_interval=${periodMinutes}`,
      {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      }
    );
    clearTimeout(timer);
    if (!res.ok) return cached?.candles ?? [];
    const json = (await res.json()) as {
      candlesticks?: Array<{
        end_period_ts?: number;
        volume_fp?: string;
        price?: {
          open_dollars?: string;
          high_dollars?: string;
          low_dollars?: string;
          close_dollars?: string;
        };
        yes_bid?: { close_dollars?: string };
      }>;
    };
    const rows = Array.isArray(json.candlesticks) ? json.candlesticks : [];
    const candles: OhlcCandle[] = rows
      .map((row) => {
        const o = parseDollarsToCents(row.price?.open_dollars) ?? parseDollarsToCents(row.price?.close_dollars);
        const h = parseDollarsToCents(row.price?.high_dollars) ?? o;
        const l = parseDollarsToCents(row.price?.low_dollars) ?? o;
        const c = parseDollarsToCents(row.price?.close_dollars) ?? parseDollarsToCents(row.yes_bid?.close_dollars);
        const vol = row.volume_fp ? Math.round(Number(row.volume_fp)) : 0;
        if (!row.end_period_ts || o === null || h === null || l === null || c === null) return null;
        return {
          timeSec: row.end_period_ts,
          open: clampCents(o),
          high: clampCents(h),
          low: clampCents(l),
          close: clampCents(c),
          volume: Number.isFinite(vol) ? vol : 0,
        };
      })
      .filter((c): c is OhlcCandle => c !== null)
      .slice(-45);
    cacheMap.set(ticker, { candles, fetchedAtMs: nowMs });
    return candles;
  } catch {
    clearTimeout(timer);
    return cached?.candles ?? [];
  }
}

function buildPredictionForMarket(market: KalshiMarket): CandlePrediction | undefined {
  const series = market.seriesTicker ?? getSeriesTicker(market.ticker);
  const spot1m = spotCandles1mCache.get(series)?.candles ?? [];
  const rawSpot5m = spotCandles5mCache.get(series)?.candles ?? [];
  const spot5m = rawSpot5m.length >= 5 ? rawSpot5m : aggregateCandlesTo5m(spot1m);

  const kalshi1m = kalshiCandles1mCache.get(market.ticker)?.candles ?? [];
  const rawKalshi5m = kalshiCandles5mCache.get(market.ticker)?.candles ?? [];
  const kalshi5m = rawKalshi5m.length >= 5 ? rawKalshi5m : aggregateCandlesTo5m(kalshi1m);

  const nowSec = Math.floor(Date.now() / 1000);
  const lastSpot5mSec = spot5m.length > 0 ? spot5m[spot5m.length - 1].timeSec : 0;
  const lastSpot1mSec = spot1m.length > 0 ? spot1m[spot1m.length - 1].timeSec : 0;
  const spotIsFresh =
    (spot5m.length >= 5 && nowSec - lastSpot5mSec <= 1800) ||
    (spot1m.length >= 5 && nowSec - lastSpot1mSec <= 900);
  const symbolLabel = market.pairSymbol ?? formatPairLabel(market.ticker);

  if (spotIsFresh && spot5m.length >= 5) {
    return (
      analyzeCandlesAndPredict({
        candles: spot5m,
        kalshiCandles: kalshi5m.length >= 3 ? kalshi5m : kalshi1m,
        candles1m: spot1m,
        kalshiCandles1m: kalshi1m,
        symbol: symbolLabel,
        currentYesCents: market.lastPrice,
        targetPrice: market.targetPrice ?? null,
        source: 'spot_5m',
        timeframe: '5m',
      }) ?? undefined
    );
  }
  if (kalshi5m.length >= 5) {
    return (
      analyzeCandlesAndPredict({
        candles: kalshi5m,
        candles1m: kalshi1m,
        symbol: market.ticker,
        currentYesCents: market.lastPrice,
        targetPrice: null,
        source: 'kalshi_5m',
        timeframe: '5m',
      }) ?? undefined
    );
  }
  if (spot5m.length >= 5) {
    return (
      analyzeCandlesAndPredict({
        candles: spot5m,
        kalshiCandles: kalshi5m.length >= 3 ? kalshi5m : kalshi1m,
        candles1m: spot1m,
        kalshiCandles1m: kalshi1m,
        symbol: symbolLabel,
        currentYesCents: market.lastPrice,
        targetPrice: market.targetPrice ?? null,
        source: 'spot_5m',
        timeframe: '5m',
      }) ?? undefined
    );
  }
  if (spotIsFresh && spot1m.length >= 5) {
    return (
      analyzeCandlesAndPredict({
        candles: spot1m,
        kalshiCandles: kalshi1m,
        symbol: symbolLabel,
        currentYesCents: market.lastPrice,
        targetPrice: market.targetPrice ?? null,
        source: 'spot_1m',
        timeframe: '1m',
      }) ?? undefined
    );
  }
  if (kalshi1m.length >= 5) {
    return (
      analyzeCandlesAndPredict({
        candles: kalshi1m,
        symbol: market.ticker,
        currentYesCents: market.lastPrice,
        targetPrice: null,
        source: 'kalshi_1m',
        timeframe: '1m',
      }) ?? undefined
    );
  }
  return market.candlePrediction;
}

function updatePreOpenPredictionForMarket(market: KalshiMarket): CandlePrediction | undefined {
  const series = market.seriesTicker ?? getSeriesTicker(market.ticker);
  const spot1m = spotCandles1mCache.get(series)?.candles ?? [];
  const rawSpot5m = spotCandles5mCache.get(series)?.candles ?? [];
  const spot5m = rawSpot5m.length >= 5 ? rawSpot5m : aggregateCandlesTo5m(spot1m);
  const kalshi1m = kalshiCandles1mCache.get(market.ticker)?.candles ?? [];
  const rawKalshi5m = kalshiCandles5mCache.get(market.ticker)?.candles ?? [];
  const kalshi5m = rawKalshi5m.length >= 5 ? rawKalshi5m : aggregateCandlesTo5m(kalshi1m);

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const lastSpotSec = spot5m.length > 0 ? spot5m[spot5m.length - 1].timeSec : 0;
  const spotIsFresh = spot5m.length >= 5 && nowSec - lastSpotSec <= 1800;
  const symbolLabel = market.pairSymbol ?? formatPairLabel(market.ticker);

  const closeMs = Date.parse(market.closeTime);
  if (!Number.isFinite(closeMs)) return market.preOpenPrediction;

  // In the final 45 seconds before close, pre-compute & lock forecast for the UPCOMING 15m slot
  const remainingMs = closeMs - nowMs;
  if (remainingMs > 0 && remainingMs <= 45_000) {
    const upcomingCloseIso = new Date(closeMs + 15 * 60_000).toISOString();
    const nextKey = `${series}::${upcomingCloseIso}`;
    const candlesForPreOpen = spotIsFresh
      ? spot5m
      : kalshi5m.length >= 5
        ? kalshi5m
        : spot1m.length >= 5
          ? spot1m
          : kalshi1m;
    const source: CandlePrediction['source'] = spotIsFresh
      ? 'spot_5m'
      : kalshi5m.length >= 5
        ? 'kalshi_5m'
        : spot1m.length >= 5
          ? 'spot_1m'
          : 'kalshi_1m';
    const nextBias = analyzePreOpenSetup(candlesForPreOpen, symbolLabel, 50, source);
    if (nextBias) {
      preOpenBiasCache.set(nextKey, nextBias);
    }
  }

  // Return locked pre-open prediction for current market slot (compute on-demand if opened before cache existed)
  const currentKey = `${series}::${market.closeTime}`;
  const existing = preOpenBiasCache.get(currentKey);
  if (existing) return existing;

  const openSec = Math.floor((closeMs - 15 * 60_000) / 1000);
  const preOpenSpot = spot5m.filter((c) => c.timeSec <= openSec + 300);
  const chosenCandles =
    preOpenSpot.length >= 5
      ? preOpenSpot
      : spotIsFresh
        ? spot5m
        : kalshi5m.length >= 5
          ? kalshi5m
          : spot1m.length >= 5
            ? spot1m
            : kalshi1m;
  const chosenSource: CandlePrediction['source'] =
    preOpenSpot.length >= 5 || spotIsFresh
      ? 'spot_5m'
      : kalshi5m.length >= 5
        ? 'kalshi_5m'
        : spot1m.length >= 5
          ? 'spot_1m'
          : 'kalshi_1m';

  const computed = analyzePreOpenSetup(chosenCandles, symbolLabel, 50, chosenSource);
  if (computed) {
    preOpenBiasCache.set(currentKey, computed);
    if (preOpenBiasCache.size > 120) {
      const oldestKey = preOpenBiasCache.keys().next().value;
      if (oldestKey) preOpenBiasCache.delete(oldestKey);
    }
    return computed;
  }
  return market.preOpenPrediction;
}

async function refreshCandlesAndPredictionsForMarkets(markets: KalshiMarket[], priorityTicker?: string) {
  const uniqueSeries = new Set<string>();
  const activeContracts: Array<{ series: string; ticker: string }> = [];

  for (const m of markets) {
    const s = m.seriesTicker ?? getSeriesTicker(m.ticker);
    if (SERIES_SPOT_FEED[s]) uniqueSeries.add(s);
    if (m.source === 'kalshi_live' && m.status === 'active') {
      activeContracts.push({ series: s, ticker: m.ticker });
    }
  }
  if (priorityTicker) {
    const ps = getSeriesTicker(priorityTicker);
    if (SERIES_SPOT_FEED[ps]) uniqueSeries.add(ps);
  }

  await Promise.allSettled([
    ...Array.from(uniqueSeries).flatMap((s) => [
      fetchSpotCandlesForSeries(s, '5m'),
      fetchSpotCandlesForSeries(s, '1m'),
    ]),
    ...activeContracts.flatMap((c) => [
      fetchKalshiCandlesForTicker(c.series, c.ticker, 1),
      fetchKalshiCandlesForTicker(c.series, c.ticker, 5),
    ]),
  ]);

  for (let i = 0; i < marketsCache.length; i++) {
    const pred = buildPredictionForMarket(marketsCache[i]);
    const preOpenPred = updatePreOpenPredictionForMarket(marketsCache[i]);
    const kalshi1m = kalshiCandles1mCache.get(marketsCache[i].ticker)?.candles ?? [];
    const latestKalshi1m = kalshi1m.length > 0 ? kalshi1m[kalshi1m.length - 1] : undefined;
    if (pred || preOpenPred || latestKalshi1m) {
      marketsCache[i] = {
        ...marketsCache[i],
        ...(pred ? { candlePrediction: pred } : {}),
        ...(preOpenPred ? { preOpenPrediction: preOpenPred } : {}),
        ...(latestKalshi1m ? { kalshiLast1mBar: latestKalshi1m } : {}),
      };
    }
  }
}

function syncEntryExtremesInDailyHistory(
  ticker: string,
  side: OrderSide,
  extremes: {
    lowestBidCents?: number | null;
    lowestBidAt?: string | null;
    highestBidCents?: number | null;
    highestBidAt?: string | null;
  },
  closeTimeIso?: string,
  nowMs: number = Date.now(),
  botId?: string | null
): boolean {
  if (!portfolioState.dailyHistory) return false;
  const inLowWin = !closeTimeIso || isInsideMinuteWindow(closeTimeIso, nowMs, 7, 13);
  let changed = false;

  for (const dayRec of Object.values(portfolioState.dailyHistory)) {
    for (const entry of dayRec.entries) {
      if (entry.ticker !== ticker || entry.side !== side) continue;
      if (botId !== undefined && entry.botId !== botId) continue;

      if (inLowWin && typeof extremes.lowestBidCents === 'number') {
        const shouldLower =
          typeof entry.lowestBidCents !== 'number' || extremes.lowestBidCents < entry.lowestBidCents;
        if (shouldLower) {
          entry.lowestBidCents = extremes.lowestBidCents;
          if (extremes.lowestBidAt) entry.lowestBidAt = extremes.lowestBidAt;
          changed = true;
        } else if (
          !entry.lowestBidAt &&
          extremes.lowestBidAt &&
          entry.lowestBidCents === extremes.lowestBidCents
        ) {
          entry.lowestBidAt = extremes.lowestBidAt;
          changed = true;
        }
      }

      if (typeof extremes.highestBidCents === 'number') {
        const shouldRaise =
          typeof entry.highestBidCents !== 'number' || extremes.highestBidCents > entry.highestBidCents;
        if (shouldRaise) {
          entry.highestBidCents = extremes.highestBidCents;
          if (extremes.highestBidAt) entry.highestBidAt = extremes.highestBidAt;
          changed = true;
        } else if (
          !entry.highestBidAt &&
          extremes.highestBidAt &&
          entry.highestBidCents === extremes.highestBidCents
        ) {
          entry.highestBidAt = extremes.highestBidAt;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function updateMarketExtremesForMarket(
  ticker: string,
  yesBid: number,
  noBid: number,
  closeTimeIso: string,
  nowMs: number = Date.now()
) {
  const closeMs = Date.parse(closeTimeIso);
  if (!Number.isFinite(closeMs) || nowMs > closeMs) return;

  let mutated = false;

  for (const pos of portfolioState.positions) {
    if (pos.ticker === ticker && pos.contracts > 0) {
      const sideBid = pos.side === 'yes' ? yesBid : noBid;
      const lowRes = updateTrackedLowWithTime(
        pos.lowestBidCents,
        pos.lowestBidAt,
        sideBid,
        closeTimeIso,
        nowMs
      );
      if (
        typeof lowRes.lowestBidCents === 'number' &&
        (pos.lowestBidCents !== lowRes.lowestBidCents || pos.lowestBidAt !== lowRes.lowestBidAt)
      ) {
        pos.lowestBidCents = lowRes.lowestBidCents;
        if (lowRes.lowestBidAt) pos.lowestBidAt = lowRes.lowestBidAt;
        mutated = true;
      }

      const highRes = updateTrackedHighWithTime(
        pos.peakBidCents ?? pos.avgEntryCents,
        pos.peakBidAt ?? pos.updatedAt,
        sideBid,
        closeTimeIso,
        nowMs
      );
      if (
        typeof highRes.highestBidCents === 'number' &&
        (pos.peakBidCents !== highRes.highestBidCents || pos.peakBidAt !== highRes.highestBidAt)
      ) {
        pos.peakBidCents = highRes.highestBidCents;
        if (highRes.highestBidAt) pos.peakBidAt = highRes.highestBidAt;
        mutated = true;
      }
    }
  }

  if (portfolioState.dailyHistory) {
    const buyTimeByKey = new Map<string, number>();
    for (const dayRec of Object.values(portfolioState.dailyHistory)) {
      for (const e of dayRec.entries) {
        if (e.ticker === ticker && e.action === 'buy') {
          const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
          const ms = Date.parse(e.createdAt);
          if (Number.isFinite(ms)) {
            buyTimeByKey.set(key, ms);
          }
        }
      }
    }

    for (const dayRec of Object.values(portfolioState.dailyHistory)) {
      for (const entry of dayRec.entries) {
        if (entry.ticker !== ticker) continue;
        const key = `${entry.botId ?? entry.botName}::${entry.ticker}::${entry.side}`;
        const minStartMs =
          buyTimeByKey.get(key) ?? (entry.action === 'buy' ? Date.parse(entry.createdAt) : undefined);
        if (typeof minStartMs === 'number' && Number.isFinite(minStartMs) && nowMs < minStartMs) {
          continue;
        }
        const sideBid = entry.side === 'yes' ? yesBid : noBid;

        const lowRes = updateTrackedLowWithTime(
          entry.lowestBidCents,
          entry.lowestBidAt,
          sideBid,
          closeTimeIso,
          nowMs
        );
        if (
          typeof lowRes.lowestBidCents === 'number' &&
          (entry.lowestBidCents !== lowRes.lowestBidCents || entry.lowestBidAt !== lowRes.lowestBidAt)
        ) {
          entry.lowestBidCents = lowRes.lowestBidCents;
          entry.lowestBidAt = lowRes.lowestBidAt ?? null;
          mutated = true;
        }

        const fallbackHigh = entry.action === 'buy' ? entry.priceCents : undefined;
        const fallbackHighAt = entry.action === 'buy' ? entry.createdAt : undefined;
        const highRes = updateTrackedHighWithTime(
          entry.highestBidCents ?? fallbackHigh,
          entry.highestBidAt ?? fallbackHighAt,
          sideBid,
          closeTimeIso,
          nowMs,
          minStartMs
        );
        if (
          typeof highRes.highestBidCents === 'number' &&
          (entry.highestBidCents !== highRes.highestBidCents || entry.highestBidAt !== highRes.highestBidAt)
        ) {
          entry.highestBidCents = highRes.highestBidCents;
          entry.highestBidAt = highRes.highestBidAt ?? null;
          mutated = true;
        }
      }
    }
  }

  if (mutated) {
    savePersistedState(portfolioState);
  }
}

function applySettlementResultToDailyHistory(ticker: string, resultSide: OrderSide): boolean {
  settledMarketResults.set(ticker, resultSide);
  if (!portfolioState.dailyHistory) return false;
  let updated = false;
  for (const dayRec of Object.values(portfolioState.dailyHistory)) {
    for (const entry of dayRec.entries) {
      if (entry.ticker === ticker) {
        const resolved = resolveSettleOutcome(entry.side, resultSide);
        if (entry.settleOutcome !== resolved.outcome || entry.settleResultSide !== resultSide) {
          entry.settleOutcome = resolved.outcome;
          entry.settleResultSide = resultSide;
          updated = true;
        }
      }
    }
  }
  return updated;
}

let apiStatus: ApiConnectionStatus = {
  kalshiEnv: KALSHI_ENV,
  hasCredentials: HAS_CREDENTIALS,
  publicFeedOnline: false,
  lastFeedSyncAt: null,
  baseUrl: KALSHI_BASE_URL,
};

interface RawKalshiMarket {
  ticker?: string;
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  previous_price?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  previous_price_dollars?: string;
  volume?: number;
  volume_fp?: string;
  volume_24h?: number;
  volume_24h_fp?: string;
  open_interest?: number;
  open_interest_fp?: string;
  close_time?: string;
  status?: string;
  result?: string;
  category?: string;
}

function parseDollarsToCents(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return Math.max(0, Math.min(100, Math.round(val)));
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, Math.round(parsed * 100)));
    }
  }
  return null;
}

function parseFpNumber(val: unknown, legacy?: number): number {
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val);
    if (Number.isFinite(num)) return Math.round(num);
  }
  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    return Math.round(legacy);
  }
  return 0;
}

async function fetchRecentTradePrices(ticker: string, limit = 20): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
      { signal: controller.signal, headers: { Accept: 'application/json' } }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      trades?: Array<{ yes_price?: number; yes_price_dollars?: string }>;
    };
    const trades = Array.isArray(data.trades) ? data.trades : [];
    const prices = trades
      .slice()
      .reverse()
      .map((t) => parseDollarsToCents(t.yes_price_dollars) ?? (typeof t.yes_price === 'number' ? t.yes_price : null))
      .filter((p): p is number => p !== null && p >= 1 && p <= 99);
    return prices;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

async function fetchLiveOrderbook(ticker: string): Promise<OrderBook> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(
      `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook?depth=15`,
      {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        },
      }
    );
    clearTimeout(timer);
    lastOrderbookFetchMs.set(ticker, Date.now());
    if (res.status === 429) {
      return (
        orderbooksCache[ticker] ?? {
          ticker,
          yesBids: [],
          noBids: [],
          updatedAt: new Date().toISOString(),
        }
      );
    }
    if (res.ok) {
      const data = (await res.json()) as {
        orderbook?: { yes?: [number, number][]; no?: [number, number][] };
        orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
      };

      const yesLevels: Array<{ price: number; quantity: number }> = [];
      const noLevels: Array<{ price: number; quantity: number }> = [];

      if (Array.isArray(data.orderbook_fp?.yes_dollars)) {
        for (const [priceStr, qtyStr] of data.orderbook_fp.yes_dollars) {
          const rawDollars = Number(priceStr);
          const qty = Math.round(Number(qtyStr));
          if (Number.isFinite(rawDollars) && rawDollars > 0 && rawDollars < 1 && Number.isFinite(qty) && qty > 0) {
            yesLevels.push({ price: clampCents(Math.round(rawDollars * 100)), quantity: qty });
          }
        }
      } else if (Array.isArray(data.orderbook?.yes)) {
        for (const [price, qty] of data.orderbook.yes) {
          if (price >= 1 && price <= 99 && qty > 0) {
            yesLevels.push({ price: clampCents(price), quantity: Math.round(qty) });
          }
        }
      }

      if (Array.isArray(data.orderbook_fp?.no_dollars)) {
        for (const [priceStr, qtyStr] of data.orderbook_fp.no_dollars) {
          const rawDollars = Number(priceStr);
          const qty = Math.round(Number(qtyStr));
          if (Number.isFinite(rawDollars) && rawDollars > 0 && rawDollars < 1 && Number.isFinite(qty) && qty > 0) {
            noLevels.push({ price: clampCents(Math.round(rawDollars * 100)), quantity: qty });
          }
        }
      } else if (Array.isArray(data.orderbook?.no)) {
        for (const [price, qty] of data.orderbook.no) {
          if (price >= 1 && price <= 99 && qty > 0) {
            noLevels.push({ price: clampCents(price), quantity: Math.round(qty) });
          }
        }
      }

      // Collapse sub-cent buckets that rounded to the same integer cent price
      const collapseByCent = (levels: Array<{ price: number; quantity: number }>) => {
        const byPrice = new Map<number, number>();
        for (const lvl of levels) {
          byPrice.set(lvl.price, (byPrice.get(lvl.price) ?? 0) + lvl.quantity);
        }
        return Array.from(byPrice.entries())
          .map(([price, quantity]) => ({ price, quantity }))
          .sort((a, b) => b.price - a.price)
          .slice(0, 8);
      };

      const yesBids = collapseByCent(yesLevels);
      const noBids = collapseByCent(noLevels);

      const book: OrderBook = {
        ticker,
        yesBids,
        noBids,
        updatedAt: new Date().toISOString(),
      };
      orderbooksCache[ticker] = book;

      // Keep corresponding market top-of-book bid/ask and live mid-price synced to real orderbook
      const mIdx = marketsCache.findIndex((m) => m.ticker === ticker);
      const topOfBook = deriveTopOfBookFromOrderbook(yesBids, noBids);
      if (mIdx >= 0 && topOfBook) {
        const cur = marketsCache[mIdx];
        const nextMid = clampCents(Math.round((topOfBook.yesBid + topOfBook.yesAsk) / 2));
        const midChanged = nextMid !== cur.lastPrice;
        const prevYesBids = cur.yesBidHistory ?? [];
        const prevNoBids = cur.noBidHistory ?? [];
        const yesBidChanged = prevYesBids.length === 0 || prevYesBids[prevYesBids.length - 1] !== topOfBook.yesBid;
        const noBidChanged = prevNoBids.length === 0 || prevNoBids[prevNoBids.length - 1] !== topOfBook.noBid;
        marketsCache[mIdx] = {
          ...cur,
          yesBid: topOfBook.yesBid,
          yesAsk: topOfBook.yesAsk,
          noBid: topOfBook.noBid,
          noAsk: topOfBook.noAsk,
          previousPrice: midChanged ? cur.lastPrice : cur.previousPrice,
          lastPrice: nextMid,
          priceHistory: midChanged ? [...cur.priceHistory.slice(-19), nextMid] : cur.priceHistory,
          yesBidHistory: yesBidChanged ? [...prevYesBids.slice(-19), topOfBook.yesBid] : prevYesBids,
          noBidHistory: noBidChanged ? [...prevNoBids.slice(-19), topOfBook.noBid] : prevNoBids,
        };

        // Keep 7-13m low & post-entry highest watermarks synced for open positions and already-exited trades
        updateMarketExtremesForMarket(ticker, topOfBook.yesBid, topOfBook.noBid, cur.closeTime, Date.now());
      }

      return book;
    }
  } catch {
    clearTimeout(timer);
    lastOrderbookFetchMs.set(ticker, Date.now());
  }
  return (
    orderbooksCache[ticker] ?? {
      ticker,
      yesBids: [],
      noBids: [],
      updatedAt: new Date().toISOString(),
    }
  );
}

let isSettlementSyncRunning = false;

async function settleExpiredPaperPositions(activeTickers: Set<string>) {
  const expiredPositions = portfolioState.positions.filter(
    (p) => !activeTickers.has(p.ticker) && p.contracts > 0
  );
  if (expiredPositions.length === 0) return;

  for (const pos of expiredPositions) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(
        `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/markets/${encodeURIComponent(pos.ticker)}`,
        { signal: controller.signal, headers: { Accept: 'application/json' } }
      );
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = (await res.json()) as { market?: RawKalshiMarket };
      const m = json.market;
      if (!m) continue;
      const result = (m.result || '').toLowerCase();
      if (result === 'yes' || result === 'no') {
        const stillOpen = portfolioState.positions.some(
          (p) => p.ticker === pos.ticker && p.side === pos.side && (p.botId ?? null) === (pos.botId ?? null)
        );
        if (!stillOpen) continue;

        const settleSide: OrderSide = result;
        const settlePriceCents = settleSide === pos.side ? 99 : 1;
        // Exact binary payout ($1.00 if won, $0.00 if lost) via direct settlement adjustment
        const won = settleSide === pos.side;
        const payoutUsd = won ? Number(pos.contracts.toFixed(2)) : 0;
        const costBasis = calcContractCost(pos.contracts, pos.avgEntryCents);
        const cashRealizedDelta = Number((payoutUsd - costBasis).toFixed(2));
        const entryFeeUsd = calcKalshiFee(pos.contracts, pos.avgEntryCents);
        const roundTripNetPnl = Number((payoutUsd - costBasis - entryFeeUsd).toFixed(2));
        const tradeLowBid = pos.lowestBidCents ?? null;
        const tradeLowAt = pos.lowestBidAt ?? null;
        const tradeHighBid = pos.peakBidCents ?? pos.avgEntryCents;
        const tradeHighAt = pos.peakBidAt ?? pos.updatedAt;
        portfolioState.cashUsd = Number((portfolioState.cashUsd + payoutUsd).toFixed(2));
        portfolioState.dailyRealizedPnlUsd = Number(
          (portfolioState.dailyRealizedPnlUsd + cashRealizedDelta).toFixed(2)
        );
        const nowIso = new Date().toISOString();
        const dateKey = getDateKeyWib(nowIso);
        if (!portfolioState.dailyHistory) portfolioState.dailyHistory = {};
        if (!portfolioState.dailyHistory[dateKey]) {
          portfolioState.dailyHistory[dateKey] = {
            date: dateKey,
            realizedPnlUsd: 0,
            feesUsd: 0,
            entriesCount: 0,
            exitsCount: 0,
            wins: 0,
            losses: 0,
            entriesByTicker: {},
            entries: [],
          };
        }
        const dayRec = portfolioState.dailyHistory[dateKey];
        dayRec.realizedPnlUsd = Number((dayRec.realizedPnlUsd + cashRealizedDelta).toFixed(2));
        dayRec.exitsCount += 1;
        if (roundTripNetPnl > 0) dayRec.wins += 1;
        else dayRec.losses += 1;
        const series = getSeriesTicker(pos.ticker);
        const matchingBot = pos.botId
          ? portfolioState.bots.find((b) => b.id === pos.botId)
          : portfolioState.bots.find((b) => getSeriesTicker(b.ticker) === series && b.strategy !== 'preopen_spike');
        const resolvedVar =
          pos.variant ?? resolveStrategyVariant(pos.botId, matchingBot?.name, matchingBot?.strategy);
        const settleId = `stl-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`;

        dayRec.entries.unshift({
          id: settleId,
          dateKey,
          ticker: pos.ticker,
          botId: pos.botId ?? null,
          botName: matchingBot ? `Settle · ${matchingBot.name}` : 'Kalshi 15m Settlement',
          ...(resolvedVar ? { variant: resolvedVar } : {}),
          side: pos.side,
          action: 'sell',
          contracts: pos.contracts,
          priceCents: won ? 100 : 0,
          lowestBidCents: tradeLowBid,
          lowestBidAt: tradeLowAt,
          highestBidCents: tradeHighBid,
          highestBidAt: tradeHighAt,
          feeUsd: 0,
          netPnlUsd: roundTripNetPnl,
          settleOutcome: won ? 'win' : 'lose',
          settleResultSide: settleSide,
          mode: 'paper',
          reason: `Settlement Kalshi (${settleSide.toUpperCase()}): ${won ? 'WIN $1.00' : 'LOSS $0.00'}`,
          createdAt: nowIso,
        });
        dayRec.entries = dayRec.entries.slice(0, 300);

        if (matchingBot) {
          matchingBot.realizedPnlUsd = Number((matchingBot.realizedPnlUsd + cashRealizedDelta).toFixed(2));
        }

        const liveClose = marketsCache.find((mk) => mk.ticker === pos.ticker)?.closeTime ?? m.close_time;
        syncEntryExtremesInDailyHistory(
          pos.ticker,
          pos.side,
          {
            lowestBidCents: tradeLowBid,
            lowestBidAt: tradeLowAt,
            highestBidCents: tradeHighBid,
            highestBidAt: tradeHighAt,
          },
          liveClose,
          Date.now(),
          pos.botId ?? null
        );
        applySettlementResultToDailyHistory(pos.ticker, settleSide);

        portfolioState.orders.unshift({
          id: settleId,
          clientOrderId: crypto.randomUUID(),
          botId: pos.botId ?? null,
          botName: matchingBot ? `Settle · ${matchingBot.name}` : 'Kalshi 15m Settlement',
          ticker: pos.ticker,
          side: pos.side,
          action: 'sell',
          contracts: pos.contracts,
          priceCents: settlePriceCents,
          feeUsd: 0,
          totalUsd: payoutUsd,
          mode: 'paper',
          status: 'filled',
          reason: `Kontrak 15m selesai (${settleSide.toUpperCase()})`,
          createdAt: nowIso,
        });
        portfolioState.orders = portfolioState.orders.slice(0, 250);
        portfolioState.totalFilledOrders = (portfolioState.totalFilledOrders ?? 0) + 1;
        portfolioState.positions = portfolioState.positions.filter(
          (p) => !(p.ticker === pos.ticker && p.side === pos.side && (p.botId ?? null) === (pos.botId ?? null))
        );
        savePersistedState(portfolioState);
      }
    } catch {
      clearTimeout(timer);
    }
  }
}

async function syncPendingSettlementOutcomes(activeTickers: Set<string>) {
  if (isSettlementSyncRunning) return;
  isSettlementSyncRunning = true;
  try {
    await settleExpiredPaperPositions(activeTickers);

    if (!portfolioState.dailyHistory) return;
  const pendingTickers = new Set<string>();
  let mutated = false;

  for (const dayRec of Object.values(portfolioState.dailyHistory)) {
    for (const entry of dayRec.entries) {
      if (entry.settleOutcome === 'win' || entry.settleOutcome === 'lose') continue;
      const cached = settledMarketResults.get(entry.ticker);
      if (cached) {
        if (applySettlementResultToDailyHistory(entry.ticker, cached)) {
          mutated = true;
        }
      } else if (!activeTickers.has(entry.ticker)) {
        pendingTickers.add(entry.ticker);
      }
    }
  }

  const nowMs = Date.now();
  if (pendingTickers.size > 0 && nowMs - lastPendingSettleCheckMs >= 4000) {
    lastPendingSettleCheckMs = nowMs;
    const batch = Array.from(pendingTickers).slice(0, 10);
    await Promise.allSettled(
      batch.map(async (ticker) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(
            `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
            { signal: controller.signal, headers: { Accept: 'application/json' } }
          );
          clearTimeout(timer);
          if (!res.ok) return;
          const json = (await res.json()) as { market?: RawKalshiMarket };
          const result = (json.market?.result || '').toLowerCase();
          if (result === 'yes' || result === 'no') {
            if (applySettlementResultToDailyHistory(ticker, result)) {
              mutated = true;
            }
          }
        } catch {
          clearTimeout(timer);
        }
      })
    );
  }

    if (mutated) {
      savePersistedState(portfolioState);
    }
  } finally {
    isSettlementSyncRunning = false;
  }
}

async function fetchLiveKalshiMarkets(options?: {
  includeOrderbooks?: boolean;
  includeCandles?: boolean;
}): Promise<boolean> {
  const includeOrderbooks = options?.includeOrderbooks ?? true;
  const includeCandles = options?.includeCandles ?? true;
  const nowMs = Date.now();
  const existingBySeries = new Map<string, KalshiMarket>();
  for (const m of marketsCache) {
    existingBySeries.set(m.seriesTicker ?? getSeriesTicker(m.ticker), m);
  }

  const seriesResults = await Promise.allSettled(
    KALSHI_15M_SERIES.map(async (spec) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      try {
        const res = await fetch(
          `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/markets?series_ticker=${encodeURIComponent(spec.seriesTicker)}&status=open&limit=3`,
          {
            signal: controller.signal,
            cache: 'no-store',
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          }
        );
        clearTimeout(timer);
        if (!res.ok) return { spec, market: null as RawKalshiMarket | null };
        const json = (await res.json()) as { markets?: RawKalshiMarket[] };
        const list = Array.isArray(json.markets) ? json.markets : [];
        // Prefer the active contract closing soonest in the future
        const sorted = list
          .filter((m) => m.ticker && m.title)
          .sort((a, b) => Date.parse(a.close_time || '') - Date.parse(b.close_time || ''));
        const chosen =
          sorted.find((m) => Date.parse(m.close_time || '') > nowMs) ?? sorted[0] ?? null;
        return { spec, market: chosen };
      } catch {
        clearTimeout(timer);
        return { spec, market: null as RawKalshiMarket | null };
      }
    })
  );

  let liveSuccessCount = 0;
  const nextMarkets: KalshiMarket[] = [];
  const tickersNeedingTrades: string[] = [];

  for (const settled of seriesResults) {
    if (settled.status !== 'fulfilled') continue;
    const { spec, market: raw } = settled.value;
    const prevMarket = existingBySeries.get(spec.seriesTicker);

    if (!raw || !raw.ticker) {
      if (prevMarket) {
        nextMarkets.push({
          ...prevMarket,
          status: 'closed',
          source: 'kalshi_offline',
        });
      } else {
        const seed = MARKETS_15M_SEED.find((s) => s.seriesTicker === spec.seriesTicker);
        if (seed) nextMarkets.push({ ...seed, status: 'closed', source: 'kalshi_offline' });
      }
      continue;
    }

    liveSuccessCount += 1;
    const tickerStr = String(raw.ticker);
    const sameTickerPrev = prevMarket && prevMarket.ticker === tickerStr ? prevMarket : undefined;
    const cachedBook = orderbooksCache[tickerStr];
    const bookUpdatedMs = cachedBook ? Date.parse(cachedBook.updatedAt) : 0;
    const hasFreshOrderbook =
      Boolean(sameTickerPrev) &&
      Number.isFinite(bookUpdatedMs) &&
      nowMs - bookUpdatedMs <= 10_000 &&
      (cachedBook.yesBids.length > 0 || cachedBook.noBids.length > 0);

    const yesBidRaw = parseDollarsToCents(raw.yes_bid_dollars) ?? (typeof raw.yes_bid === 'number' ? raw.yes_bid : null);
    const yesAskRaw = parseDollarsToCents(raw.yes_ask_dollars) ?? (typeof raw.yes_ask === 'number' ? raw.yes_ask : null);
    const noBidRaw = parseDollarsToCents(raw.no_bid_dollars) ?? (typeof raw.no_bid === 'number' ? raw.no_bid : null);
    const noAskRaw = parseDollarsToCents(raw.no_ask_dollars) ?? (typeof raw.no_ask === 'number' ? raw.no_ask : null);
    const lastRaw = parseDollarsToCents(raw.last_price_dollars) ?? (typeof raw.last_price === 'number' ? raw.last_price : null);
    const prevRaw = parseDollarsToCents(raw.previous_price_dollars) ?? (typeof raw.previous_price === 'number' ? raw.previous_price : null);

    // /markets endpoint is CDN-cached (max-age=5); preserve fresher uncached orderbook top-of-book when available
    const yesBid = hasFreshOrderbook
      ? sameTickerPrev!.yesBid
      : clampCents(yesBidRaw ?? (noAskRaw !== null ? 100 - noAskRaw : lastRaw ?? 50));
    const yesAsk = hasFreshOrderbook
      ? sameTickerPrev!.yesAsk
      : clampCents(yesAskRaw ?? (noBidRaw !== null ? 100 - noBidRaw : yesBid));
    const noBid = hasFreshOrderbook
      ? sameTickerPrev!.noBid
      : clampCents(noBidRaw ?? 100 - yesAsk);
    const noAsk = hasFreshOrderbook
      ? sameTickerPrev!.noAsk
      : clampCents(noAskRaw ?? 100 - yesBid);
    const mid = Math.round((yesBid + yesAsk) / 2);
    const lastPrice = hasFreshOrderbook
      ? sameTickerPrev!.lastPrice
      : clampCents(lastRaw !== null && lastRaw > 0 ? lastRaw : mid);

    const previousPrice = hasFreshOrderbook
      ? sameTickerPrev!.previousPrice
      : sameTickerPrev
        ? sameTickerPrev.lastPrice !== lastPrice
          ? sameTickerPrev.lastPrice
          : sameTickerPrev.previousPrice
        : clampCents(prevRaw !== null && prevRaw > 0 ? prevRaw : lastPrice);

    const prevHist = sameTickerPrev ? sameTickerPrev.priceHistory : [];
    const nextHist = hasFreshOrderbook
      ? prevHist
      : prevHist.length > 0
        ? [...prevHist.slice(-19), lastPrice]
        : [previousPrice, lastPrice];

    if (!seededTradeHistoryTickers.has(tickerStr)) {
      tickersNeedingTrades.push(tickerStr);
    }

    const subtitleText =
      raw.yes_sub_title && raw.yes_sub_title.trim()
        ? `${raw.yes_sub_title.trim()} · Kalshi Live 15m`
        : raw.subtitle || 'Kalshi Exchange Live 15m Binary Contract';

    const targetPrice =
      parseKalshiTargetPrice(raw.yes_sub_title) ??
      parseKalshiTargetPrice(raw.subtitle) ??
      prevMarket?.targetPrice ??
      null;

    nextMarkets.push({
      ticker: tickerStr,
      seriesTicker: spec.seriesTicker,
      eventTicker: String(raw.event_ticker || tickerStr),
      title: String(raw.title || spec.fallbackTitle),
      subtitle: subtitleText,
      category: spec.category,
      timeframe: '15m',
      pairSymbol: spec.pairSymbol,
      targetPrice,
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      lastPrice,
      previousPrice,
      volume24h: Math.max(
        parseFpNumber(raw.volume_fp, raw.volume),
        parseFpNumber(raw.volume_24h_fp, raw.volume_24h)
      ),
      openInterest: parseFpNumber(raw.open_interest_fp, raw.open_interest),
      closeTime: raw.close_time || ensureValid15mCloseTime(undefined, nowMs),
      status: raw.status === 'closed' || raw.status === 'settled' ? raw.status : 'active',
      priceHistory: nextHist.slice(-20),
      ...(sameTickerPrev?.yesBidHistory ? { yesBidHistory: sameTickerPrev.yesBidHistory } : {}),
      ...(sameTickerPrev?.noBidHistory ? { noBidHistory: sameTickerPrev.noBidHistory } : {}),
      ...(sameTickerPrev?.kalshiLast1mBar ? { kalshiLast1mBar: sameTickerPrev.kalshiLast1mBar } : {}),
      ...(prevMarket?.candlePrediction ? { candlePrediction: prevMarket.candlePrediction } : {}),
      ...(prevMarket?.preOpenPrediction ? { preOpenPrediction: prevMarket.preOpenPrediction } : {}),
      source: 'kalshi_live',
    });
  }

  if (nextMarkets.length > 0) {
    marketsCache = nextMarkets;
  }

  // Seed initial real priceHistory from recent Kalshi trades for newly discovered contracts
  if (tickersNeedingTrades.length > 0) {
    await Promise.allSettled(
      tickersNeedingTrades.map(async (tickerStr) => {
        seededTradeHistoryTickers.add(tickerStr);
        const tradePrices = await fetchRecentTradePrices(tickerStr, 20);
        if (tradePrices.length >= 2) {
          const idx = marketsCache.findIndex((m) => m.ticker === tickerStr);
          if (idx >= 0) {
            const cur = marketsCache[idx];
            marketsCache[idx] = {
              ...cur,
              previousPrice: tradePrices[tradePrices.length - 2],
              lastPrice: tradePrices[tradePrices.length - 1],
              priceHistory: tradePrices.slice(-20),
            };
          }
        }
      })
    );
  }

  // Fetch real Kalshi orderbook_fp for all live active contracts concurrently
  const liveMarkets = marketsCache.filter((m) => m.source === 'kalshi_live' && m.status === 'active');
  if (includeOrderbooks && liveMarkets.length > 0) {
    await Promise.allSettled(liveMarkets.map((m) => fetchLiveOrderbook(m.ticker)));
  }

  // Sync live 1m spot & Kalshi candlesticks and update directional price predictions
  if (includeCandles) {
    await refreshCandlesAndPredictionsForMarkets(marketsCache);
  }

  // Auto-rollover bot tickers to the current live 15m contract of the same series
  let botsUpdated = false;
  for (const bot of portfolioState.bots) {
    const botSeries = getSeriesTicker(bot.ticker);
    const liveMatch = marketsCache.find(
      (m) => (m.seriesTicker ?? getSeriesTicker(m.ticker)) === botSeries && m.source === 'kalshi_live'
    );
    if (liveMatch && bot.ticker !== liveMatch.ticker) {
      bot.ticker = liveMatch.ticker;
      if (bot.id.startsWith('bot-varb-') || bot.strategy === 'preopen_spike') {
        bot.name = `Varian B Pre-Open · ${formatPairLabel(liveMatch.ticker)}`;
      } else if (bot.id.startsWith('bot-15m-')) {
        const fixedTp =
          typeof bot.takeProfitTargetCents === 'number' && bot.takeProfitTargetCents >= 50
            ? bot.takeProfitTargetCents
            : null;
        bot.name =
          bot.strategy === 'candle_prediction'
            ? `Varian A Baca Candle · ${formatPairLabel(liveMatch.ticker)}`
            : bot.holdToSettle || (fixedTp === null && bot.takeProfitCents <= 0)
              ? `Varian A Hold Settle · ${formatPairLabel(liveMatch.ticker)}`
              : fixedTp !== null
                ? `Varian A TP ${fixedTp}¢ · ${formatPairLabel(liveMatch.ticker)}`
                : `Varian A TP+${bot.takeProfitCents || 15} · ${formatPairLabel(liveMatch.ticker)}`;
      }
      botsUpdated = true;
    }
  }
  if (botsUpdated) {
    savePersistedState(portfolioState);
  }

  const activeTickerSet = new Set(liveMarkets.filter((m) => m.status === 'active').map((m) => m.ticker));
  if (liveMarkets.length > 0) {
    void syncPendingSettlementOutcomes(activeTickerSet);
  }

  apiStatus.publicFeedOnline = liveSuccessCount > 0;
  if (liveSuccessCount > 0) {
    apiStatus.lastFeedSyncAt = new Date().toISOString();
  }
  return liveSuccessCount > 0;
}

async function submitKalshiLiveOrder(params: {
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  contracts: number;
  priceCents: number;
  clientOrderId: string;
}): Promise<{ ok: boolean; message: string }> {
  if (!HAS_CREDENTIALS) {
    return {
      ok: false,
      message: 'Kredensial KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY belum dikonfigurasi di environment server.',
    };
  }
  const apiPath = '/trade-api/v2/portfolio/orders';
  const body = {
    ticker: params.ticker,
    client_order_id: params.clientOrderId,
    side: params.side,
    action: params.action,
    count: params.contracts,
    type: 'limit',
    ...(params.side === 'yes' ? { yes_price: params.priceCents } : { no_price: params.priceCents }),
  };

  try {
    const headers = buildKalshiAuthHeaders(KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY, 'POST', apiPath);
    const res = await fetch(`${KALSHI_BASE_URL}${apiPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, message: `Kalshi API (${res.status}): ${errText.slice(0, 140)}` };
    }
    return { ok: true, message: 'Order terkirim ke Kalshi Trade API v2.' };
  } catch (err) {
    return { ok: false, message: `Koneksi Kalshi API gagal: ${String(err)}` };
  }
}

function applyFilledOrder(params: {
  botId: string | null;
  botName: string;
  ticker: string;
  marketTitle: string;
  side: OrderSide;
  action: OrderAction;
  contracts: number;
  priceCents: number;
  feeUsd: number;
  mode: ExecutionMode;
  reason: string;
  clientOrderId: string;
}): OrderRecord {
  const grossUsd = calcContractCost(params.contracts, params.priceCents);
  const botRef = params.botId ? portfolioState.bots.find((b) => b.id === params.botId) : undefined;
  const resolvedVariant = resolveStrategyVariant(params.botId, params.botName, botRef?.strategy);

  let posIndex = portfolioState.positions.findIndex(
    (p) => p.ticker === params.ticker && p.side === params.side && (p.botId ?? null) === (params.botId ?? null)
  );
  if (posIndex === -1 && params.action === 'sell' && params.botId === null) {
    posIndex = portfolioState.positions.findIndex(
      (p) => p.ticker === params.ticker && p.side === params.side
    );
  }

  const nowIso = new Date().toISOString();
  const dateKey = getDateKeyWib(nowIso);
  if (!portfolioState.dailyHistory) {
    portfolioState.dailyHistory = {};
  }
  if (!portfolioState.dailyHistory[dateKey]) {
    portfolioState.dailyHistory[dateKey] = {
      date: dateKey,
      realizedPnlUsd: 0,
      feesUsd: 0,
      entriesCount: 0,
      exitsCount: 0,
      wins: 0,
      losses: 0,
      entriesByTicker: {},
      entries: [],
    };
  }
  const dayRec = portfolioState.dailyHistory[dateKey];
  dayRec.feesUsd = Number((dayRec.feesUsd + params.feeUsd).toFixed(2));
  let entryNetPnlUsd: number | null = null;
  const marketClose = marketsCache.find((mk) => mk.ticker === params.ticker)?.closeTime;
  const in7To13Now = marketClose ? isInsideMinuteWindow(marketClose, Date.now(), 7, 13) : true;
  let tradeLowestBidCents: number | null = in7To13Now ? params.priceCents : null;
  let tradeLowestBidAt: string | null = in7To13Now ? nowIso : null;
  let tradeHighestBidCents: number = params.priceCents;
  let tradeHighestBidAt: string = nowIso;

  if (params.action === 'buy') {
    const totalCost = Number((grossUsd + params.feeUsd).toFixed(2));
    portfolioState.cashUsd = Number(Math.max(0, portfolioState.cashUsd - totalCost).toFixed(2));
    portfolioState.dailyRealizedPnlUsd = Number(
      (portfolioState.dailyRealizedPnlUsd - params.feeUsd).toFixed(2)
    );
    dayRec.realizedPnlUsd = Number((dayRec.realizedPnlUsd - params.feeUsd).toFixed(2));
    dayRec.entriesCount += 1;
    dayRec.entriesByTicker[params.ticker] = (dayRec.entriesByTicker[params.ticker] ?? 0) + 1;
    entryNetPnlUsd = Number((-params.feeUsd).toFixed(2));

    if (!Array.isArray(portfolioState.tradedTickers)) {
      portfolioState.tradedTickers = [];
    }
    const tradedKey = params.botId ? `${params.botId}::${params.ticker}` : params.ticker;
    if (!portfolioState.tradedTickers.includes(tradedKey)) {
      portfolioState.tradedTickers.push(tradedKey);
      if (portfolioState.tradedTickers.length > 400) {
        portfolioState.tradedTickers = portfolioState.tradedTickers.slice(-400);
      }
    }

    if (params.botId && botRef) {
      botRef.realizedPnlUsd = Number((botRef.realizedPnlUsd - params.feeUsd).toFixed(2));
    }

    if (posIndex >= 0) {
      const existing = portfolioState.positions[posIndex];
      const newTotalContracts = existing.contracts + params.contracts;
      const weightedAvg =
        (existing.contracts * existing.avgEntryCents + params.contracts * params.priceCents) /
        newTotalContracts;
      const mergedLow =
        in7To13Now
          ? Math.min(existing.lowestBidCents ?? params.priceCents, params.priceCents)
          : (existing.lowestBidCents ?? null);
      const mergedLowAt =
        in7To13Now &&
        (existing.lowestBidCents == null || params.priceCents < existing.lowestBidCents || !existing.lowestBidAt)
          ? nowIso
          : (existing.lowestBidAt ?? null);
      const mergedHigh = Math.max(existing.peakBidCents ?? existing.avgEntryCents, params.priceCents);
      const mergedHighAt =
        existing.peakBidCents == null || params.priceCents > existing.peakBidCents || !existing.peakBidAt
          ? nowIso
          : existing.peakBidAt;

      tradeLowestBidCents = mergedLow;
      tradeLowestBidAt = mergedLowAt;
      tradeHighestBidCents = mergedHigh;
      tradeHighestBidAt = mergedHighAt;

      portfolioState.positions[posIndex] = {
        ...existing,
        contracts: newTotalContracts,
        avgEntryCents: Number(weightedAvg.toFixed(1)),
        peakBidCents: mergedHigh,
        peakBidAt: mergedHighAt,
        ...(mergedLow !== null ? { lowestBidCents: mergedLow } : {}),
        ...(mergedLowAt !== null ? { lowestBidAt: mergedLowAt } : {}),
        updatedAt: nowIso,
      };
    } else {
      const newPos: Position = {
        ticker: params.ticker,
        marketTitle: params.marketTitle,
        side: params.side,
        botId: params.botId,
        ...(resolvedVariant ? { variant: resolvedVariant } : {}),
        contracts: params.contracts,
        avgEntryCents: params.priceCents,
        peakBidCents: params.priceCents,
        peakBidAt: nowIso,
        ...(in7To13Now ? { lowestBidCents: params.priceCents, lowestBidAt: nowIso } : {}),
        trailingActivated: false,
        realizedPnlUsd: 0,
        updatedAt: nowIso,
      };
      portfolioState.positions.unshift(newPos);
    }
  } else {
    // Sell / close contracts
    const netProceeds = Number((grossUsd - params.feeUsd).toFixed(2));
    portfolioState.cashUsd = Number((portfolioState.cashUsd + netProceeds).toFixed(2));
    dayRec.exitsCount += 1;
    if (posIndex >= 0) {
      const existing = portfolioState.positions[posIndex];
      const prevLow = existing.lowestBidCents ?? null;
      tradeLowestBidCents = in7To13Now
        ? prevLow !== null
          ? Math.min(prevLow, params.priceCents)
          : params.priceCents
        : prevLow;
      tradeLowestBidAt =
        in7To13Now && (prevLow === null || params.priceCents < prevLow || !existing.lowestBidAt)
          ? nowIso
          : (existing.lowestBidAt ?? null);

      const prevHigh = existing.peakBidCents ?? existing.avgEntryCents;
      tradeHighestBidCents = Math.max(prevHigh, params.priceCents);
      tradeHighestBidAt =
        existing.peakBidCents == null || params.priceCents > prevHigh || !existing.peakBidAt
          ? nowIso
          : existing.peakBidAt;

      syncEntryExtremesInDailyHistory(
        params.ticker,
        params.side,
        {
          lowestBidCents: tradeLowestBidCents,
          lowestBidAt: tradeLowestBidAt,
          highestBidCents: tradeHighestBidCents,
          highestBidAt: tradeHighestBidAt,
        },
        marketClose,
        Date.now(),
        params.botId ?? existing.botId ?? null
      );

      const closedQty = Math.min(existing.contracts, params.contracts);
      const costBasis = calcContractCost(closedQty, existing.avgEntryCents);
      const realized = Number((netProceeds - costBasis).toFixed(2));
      const estEntryFee = calcKalshiFee(closedQty, existing.avgEntryCents);
      const roundTripNet = Number((realized - estEntryFee).toFixed(2));
      entryNetPnlUsd = roundTripNet;
      if (roundTripNet > 0) {
        dayRec.wins += 1;
      } else {
        dayRec.losses += 1;
      }
      dayRec.realizedPnlUsd = Number((dayRec.realizedPnlUsd + realized).toFixed(2));
      portfolioState.dailyRealizedPnlUsd = Number((portfolioState.dailyRealizedPnlUsd + realized).toFixed(2));

      const targetBot = params.botId
        ? botRef
        : existing.botId
          ? portfolioState.bots.find((b) => b.id === existing.botId)
          : undefined;
      if (targetBot) {
        targetBot.realizedPnlUsd = Number((targetBot.realizedPnlUsd + realized).toFixed(2));
      }

      if (existing.contracts - closedQty <= 0) {
        portfolioState.positions.splice(posIndex, 1);
      } else {
        portfolioState.positions[posIndex] = {
          ...existing,
          contracts: existing.contracts - closedQty,
          peakBidCents: tradeHighestBidCents,
          peakBidAt: tradeHighestBidAt,
          ...(tradeLowestBidCents !== null ? { lowestBidCents: tradeLowestBidCents } : {}),
          ...(tradeLowestBidAt !== null ? { lowestBidAt: tradeLowestBidAt } : {}),
          realizedPnlUsd: Number((existing.realizedPnlUsd + realized).toFixed(2)),
          updatedAt: nowIso,
        };
      }
    }
  }

  const orderId = `ord-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`;
  const order: OrderRecord = {
    id: orderId,
    clientOrderId: params.clientOrderId,
    botId: params.botId,
    botName: params.botName,
    ticker: params.ticker,
    side: params.side,
    action: params.action,
    contracts: params.contracts,
    priceCents: params.priceCents,
    feeUsd: params.feeUsd,
    totalUsd:
      params.action === 'buy'
        ? Number((grossUsd + params.feeUsd).toFixed(2))
        : Number((grossUsd - params.feeUsd).toFixed(2)),
    mode: params.mode,
    status: 'filled',
    reason: params.reason,
    createdAt: nowIso,
  };

  const cachedResult = settledMarketResults.get(params.ticker);
  const initialSettle = resolveSettleOutcome(params.side, cachedResult);

  const dailyEntry: DailyTradeEntry = {
    id: orderId,
    dateKey,
    ticker: params.ticker,
    botId: params.botId,
    botName: params.botName,
    ...(resolvedVariant ? { variant: resolvedVariant } : {}),
    side: params.side,
    action: params.action,
    contracts: params.contracts,
    priceCents: params.priceCents,
    lowestBidCents: tradeLowestBidCents,
    lowestBidAt: tradeLowestBidAt,
    highestBidCents: tradeHighestBidCents,
    highestBidAt: tradeHighestBidAt,
    feeUsd: params.feeUsd,
    netPnlUsd: entryNetPnlUsd,
    settleOutcome: initialSettle.outcome,
    ...(initialSettle.resultSide ? { settleResultSide: initialSettle.resultSide } : {}),
    mode: params.mode,
    reason: params.reason,
    createdAt: nowIso,
  };
  dayRec.entries.unshift(dailyEntry);
  if (dayRec.entries.length > 300) {
    dayRec.entries = dayRec.entries.slice(0, 300);
  }

  portfolioState.totalFilledOrders = (portfolioState.totalFilledOrders ?? 0) + 1;
  portfolioState.orders.unshift(order);
  portfolioState.orders = portfolioState.orders.slice(0, 250);
  return order;
}

let lastIdleSaveMs = 0;

async function executeBotTick(bot: BotConfig): Promise<{ bot: BotConfig; order: OrderRecord | null; note: string }> {
  const nowMs = Date.now();
  const market = marketsCache.find((m) => m.ticker === bot.ticker);
  if (!market) {
    bot.lastRunAt = new Date().toISOString();
    bot.lastSignalReason = `Market ${bot.ticker} tidak ditemukan di feed aktif.`;
    return { bot, order: null, note: bot.lastSignalReason };
  }

  if (!apiStatus.publicFeedOnline || market.source !== 'kalshi_live') {
    bot.lastRunAt = new Date().toISOString();
    bot.lastSignalReason = 'Menunggu feed live Kalshi aktif (zero mock)...';
    return { bot, order: null, note: bot.lastSignalReason };
  }

  const orderbook = orderbooksCache[market.ticker] ?? {
    ticker: market.ticker,
    yesBids: [],
    noBids: [],
    updatedAt: new Date().toISOString(),
  };
  const position = portfolioState.positions.find(
    (p) => p.ticker === market.ticker && (p.botId ?? null) === bot.id
  );
  const botTradedKey = `${bot.id}::${market.ticker}`;
  const hasTradedCurrentMarket = Boolean(
    portfolioState.tradedTickers?.includes(botTradedKey) ||
      (bot.id.startsWith('bot-15m-') && portfolioState.tradedTickers?.includes(market.ticker)) ||
      portfolioState.orders.some(
        (o) => o.ticker === market.ticker && o.botId === bot.id && o.action === 'buy' && o.status === 'filled'
      )
  );
  const decision = evaluateBotSignal({
    bot,
    market,
    orderbook,
    position,
    allPositions: portfolioState.positions,
    openOrderCount: portfolioState.positions.length,
    availableCashUsd: portfolioState.cashUsd,
    dailyRealizedPnlUsd: portfolioState.dailyRealizedPnlUsd,
    riskLimits: portfolioState.riskLimits,
    nowMs,
    hasTradedCurrentMarket,
  });

  bot.lastRunAt = new Date().toISOString();
  bot.lastSignalReason = decision.reason;

  // Persist trailing stop high-water mark, lowest bid mark & timestamps if holding a position
  let watermarkMutated = false;
  if (
    position &&
    (decision.updatedPeakBidCents !== undefined ||
      decision.updatedPeakBidAt !== undefined ||
      decision.updatedLowBidCents !== undefined ||
      decision.updatedLowBidAt !== undefined ||
      decision.trailingActivated !== undefined)
  ) {
    if (decision.updatedPeakBidCents !== undefined) {
      position.peakBidCents = decision.updatedPeakBidCents;
    }
    if (decision.updatedPeakBidAt !== undefined) {
      position.peakBidAt = decision.updatedPeakBidAt;
    }
    if (decision.updatedLowBidCents !== undefined) {
      position.lowestBidCents = decision.updatedLowBidCents;
    }
    if (decision.updatedLowBidAt !== undefined) {
      position.lowestBidAt = decision.updatedLowBidAt;
    }
    if (
      decision.updatedPeakBidCents !== undefined ||
      decision.updatedLowBidCents !== undefined
    ) {
      syncEntryExtremesInDailyHistory(
        position.ticker,
        position.side,
        {
          lowestBidCents: decision.updatedLowBidCents,
          lowestBidAt: decision.updatedLowBidAt ?? position.lowestBidAt,
          highestBidCents: decision.updatedPeakBidCents,
          highestBidAt: decision.updatedPeakBidAt ?? position.peakBidAt,
        },
        market.closeTime,
        nowMs,
        bot.id
      );
    }
    if (decision.trailingActivated !== undefined) {
      position.trailingActivated = decision.trailingActivated;
    }
    position.updatedAt = new Date().toISOString();
    watermarkMutated = true;
  }

  if (!decision.shouldTrade) {
    if (decision.blockedByRisk) {
      const blockedOrder: OrderRecord = {
        id: `ord-${Date.now().toString().slice(-6)}`,
        clientOrderId: crypto.randomUUID(),
        botId: bot.id,
        botName: bot.name,
        ticker: market.ticker,
        side: decision.side,
        action: decision.action,
        contracts: 0,
        priceCents: market.lastPrice,
        feeUsd: 0,
        totalUsd: 0,
        mode: bot.executionMode,
        status: 'risk_blocked',
        reason: decision.reason,
        createdAt: new Date().toISOString(),
      };
      portfolioState.orders.unshift(blockedOrder);
      portfolioState.orders = portfolioState.orders.slice(0, 250);
    }
    if (decision.blockedByRisk || watermarkMutated || nowMs - lastIdleSaveMs >= 5_000) {
      lastIdleSaveMs = nowMs;
      savePersistedState(portfolioState);
    }
    return { bot, order: null, note: decision.reason };
  }

  const clientOrderId = crypto.randomUUID();

  if (bot.executionMode === 'live') {
    const liveRes = await submitKalshiLiveOrder({
      ticker: market.ticker,
      side: decision.side,
      action: decision.action,
      contracts: decision.contracts,
      priceCents: decision.priceCents,
      clientOrderId,
    });
    if (!liveRes.ok) {
      const errOrder: OrderRecord = {
        id: `ord-${Date.now().toString().slice(-6)}`,
        clientOrderId,
        botId: bot.id,
        botName: bot.name,
        ticker: market.ticker,
        side: decision.side,
        action: decision.action,
        contracts: decision.contracts,
        priceCents: decision.priceCents,
        feeUsd: decision.estimatedFeeUsd,
        totalUsd: calcContractCost(decision.contracts, decision.priceCents),
        mode: 'live',
        status: 'error',
        reason: liveRes.message,
        createdAt: new Date().toISOString(),
      };
      portfolioState.orders.unshift(errOrder);
      bot.lastSignalReason = liveRes.message;
      savePersistedState(portfolioState);
      return { bot, order: errOrder, note: liveRes.message };
    }
  }

  const filled = applyFilledOrder({
    botId: bot.id,
    botName: bot.name,
    ticker: market.ticker,
    marketTitle: market.title,
    side: decision.side,
    action: decision.action,
    contracts: decision.contracts,
    priceCents: decision.priceCents,
    feeUsd: decision.estimatedFeeUsd,
    mode: bot.executionMode,
    reason: decision.reason,
    clientOrderId,
  });

  bot.tradesExecuted += 1;
  savePersistedState(portfolioState);
  return { bot, order: filled, note: decision.reason };
}

async function startServer() {
  const app = express();
  app.use(express.json());

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clientSubscriptions = new Map<WebSocket, string>();

  function buildRealtimePayload(
    type: RealtimeStatePayload['type'],
    executedCount?: number
  ): RealtimeStatePayload {
    return {
      type,
      markets: marketsCache,
      orderbooks: orderbooksCache,
      portfolio: portfolioState,
      apiStatus,
      serverTimeMs: Date.now(),
      ...(executedCount !== undefined ? { executedCount } : {}),
    };
  }

  function broadcastRealtimeState(type: RealtimeStatePayload['type'], executedCount?: number) {
    if (wss.clients.size === 0) return;
    const serialized = JSON.stringify(buildRealtimePayload(type, executedCount));
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const reqPath = (request.url || '').split('?')[0];
    if (reqPath === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    clientSubscriptions.set(ws, marketsCache[0]?.ticker ?? 'KXBTC15M');
    ws.send(JSON.stringify(buildRealtimePayload('init')));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; ticker?: string };
        if (msg?.type === 'subscribe_ticker' && typeof msg.ticker === 'string' && msg.ticker.trim()) {
          const ticker = msg.ticker.trim();
          clientSubscriptions.set(ws, ticker);
          const market = marketsCache.find((m) => m.ticker === ticker);
          if (market?.source === 'kalshi_live') {
            void fetchLiveOrderbook(ticker).then(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(buildRealtimePayload('state_update')));
              }
            });
          }
        }
      } catch {
        // Ignore malformed WS payloads
      }
    });

    ws.on('close', () => {
      clientSubscriptions.delete(ws);
    });
  });

  // Initial sync from Kalshi public live 15m series (capped at 3.5s timeout so startup never hangs)
  await fetchLiveKalshiMarkets();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, status: 'up', uptimeSec: Math.round(process.uptime()) });
  });

  app.get('/api/state', (_req, res) => {
    res.json({
      markets: marketsCache,
      orderbooks: orderbooksCache,
      portfolio: portfolioState,
      apiStatus,
      serverTimeMs: Date.now(),
    });
  });

  app.post('/api/markets/refresh', async (_req, res) => {
    const liveOk = await fetchLiveKalshiMarkets();
    broadcastRealtimeState('state_update');
    res.json({
      markets: marketsCache,
      orderbooks: orderbooksCache,
      apiStatus,
      liveOk,
      serverTimeMs: Date.now(),
    });
  });

  app.get('/api/orderbook/:ticker', async (req, res) => {
    const book = await fetchLiveOrderbook(req.params.ticker);
    res.json({ orderbook: book });
  });

  app.get('/api/candles/:ticker', async (req, res) => {
    const ticker = String(req.params.ticker || '').trim();
    const market = marketsCache.find((m) => m.ticker === ticker) ?? marketsCache[0];
    const resolvedTicker = market?.ticker ?? ticker;
    const series = market?.seriesTicker ?? getSeriesTicker(resolvedTicker);
    const [spotCandles5m, spotCandles1m, kalshiCandles5m, kalshiCandles1m] = await Promise.all([
      fetchSpotCandlesForSeries(series, '5m'),
      fetchSpotCandlesForSeries(series, '1m'),
      market?.source === 'kalshi_live' ? fetchKalshiCandlesForTicker(series, resolvedTicker, 5) : Promise.resolve([]),
      market?.source === 'kalshi_live' ? fetchKalshiCandlesForTicker(series, resolvedTicker, 1) : Promise.resolve([]),
    ]);
    const resolvedSpot5m = spotCandles5m.length >= 5 ? spotCandles5m : aggregateCandlesTo5m(spotCandles1m);
    const resolvedKalshi5m = kalshiCandles5m.length >= 5 ? kalshiCandles5m : aggregateCandlesTo5m(kalshiCandles1m);
    const nowSec = Math.floor(Date.now() / 1000);
    const lastSpot5mSec = resolvedSpot5m.length > 0 ? resolvedSpot5m[resolvedSpot5m.length - 1].timeSec : 0;
    const lastSpot1mSec = spotCandles1m.length > 0 ? spotCandles1m[spotCandles1m.length - 1].timeSec : 0;
    const spotIsFresh =
      (resolvedSpot5m.length >= 5 && nowSec - lastSpot5mSec <= 1800) ||
      (spotCandles1m.length >= 5 && nowSec - lastSpot1mSec <= 900);
    const prediction = market ? buildPredictionForMarket(market) : undefined;
    if (market && prediction) {
      const idx = marketsCache.findIndex((m) => m.ticker === market.ticker);
      if (idx >= 0) {
        marketsCache[idx] = { ...marketsCache[idx], candlePrediction: prediction };
      }
    }
    res.json({
      ticker: resolvedTicker,
      seriesTicker: series,
      pairSymbol: market?.pairSymbol ?? formatPairLabel(resolvedTicker),
      targetPrice: market?.targetPrice ?? null,
      spotIsFresh,
      spotCandles: resolvedSpot5m.length >= 2 ? resolvedSpot5m : spotCandles1m,
      spotCandles5m: resolvedSpot5m,
      spotCandles1m,
      kalshiCandles: kalshiCandles1m,
      kalshiCandles5m: resolvedKalshi5m,
      kalshiCandles1m,
      prediction: prediction ?? null,
      preOpenPrediction: market?.preOpenPrediction ?? null,
    });
  });

  app.post('/api/bots', (req, res) => {
    const body = req.body as Partial<BotConfig>;
    const validationErr = validateBotConfig(body);
    if (validationErr) {
      res.status(400).json({ error: validationErr });
      return;
    }
    if (!body.ticker || !is15mMarketTicker(String(body.ticker))) {
      res.status(400).json({ error: 'Bot hanya diizinkan untuk market 15 menit (15m).' });
      return;
    }

    const chosenStrategy = body.strategy || 'mean_reversion';
    const resolvedNoSl =
      typeof body.noStopLoss === 'boolean'
        ? body.noStopLoss
        : chosenStrategy === 'trailing_momentum' || chosenStrategy === 'preopen_spike'
          ? (body.stopLossCents === undefined || Number(body.stopLossCents) <= 0)
          : false;
    const defaultHoldSettleA = body.holdToSettle ?? false;
    const defaultTp =
      chosenStrategy === 'preopen_spike'
        ? 16
        : chosenStrategy === 'trailing_momentum' && defaultHoldSettleA
          ? 0
          : 15;
    const resolvedTp =
      chosenStrategy === 'trailing_momentum' && defaultHoldSettleA
        ? Math.max(0, Math.round(Number(body.takeProfitCents ?? 0)))
        : Math.max(1, Math.round(Number(body.takeProfitCents ?? defaultTp)));
    const resolvedFixedTpA =
      chosenStrategy === 'trailing_momentum'
        ? defaultHoldSettleA
          ? 0
          : clampCents(Number(body.takeProfitTargetCents ?? 99))
        : undefined;
    const resolvedUseTrailingA =
      chosenStrategy === 'trailing_momentum'
        ? (body.useTrailingStop ?? ((resolvedFixedTpA ?? 0) < 50))
        : undefined;
    const newBot: BotConfig = {
      id: `bot-${Date.now().toString(36)}`,
      name: String(body.name).trim(),
      ticker: String(body.ticker).trim(),
      strategy: chosenStrategy,
      status: body.status || 'running',
      executionMode: body.executionMode === 'live' && HAS_CREDENTIALS ? 'live' : 'paper',
      targetSide: body.targetSide || 'auto',
      fairValueCents: clampCents(Number(body.fairValueCents ?? 50)),
      entryEdgeCents: Math.max(1, Math.min(40, Math.round(Number(body.entryEdgeCents ?? 4)))),
      takeProfitCents: resolvedTp,
      stopLossCents: resolvedNoSl ? 0 : Math.max(1, Math.round(Number(body.stopLossCents ?? 10))),
      noStopLoss: resolvedNoSl,
      useCandleFilter: body.useCandleFilter ?? (chosenStrategy === 'trailing_momentum' || chosenStrategy === 'candle_prediction'),
      minCandleConfidence: Math.max(50, Math.min(95, Math.round(Number(body.minCandleConfidence ?? 60)))),
      ...(chosenStrategy === 'candle_prediction'
        ? { holdToSettle: body.holdToSettle ?? true }
        : {}),
      ...(chosenStrategy === 'preopen_spike'
        ? {
            entryDelayMinSec: Math.max(0, Math.min(60, Math.round(Number(body.entryDelayMinSec ?? 5)))),
            entryDelayMaxSec: Math.max(5, Math.min(60, Math.round(Number(body.entryDelayMaxSec ?? 15)))),
            entryWindowEndSec: Math.max(15, Math.min(300, Math.round(Number(body.entryWindowEndSec ?? 90)))),
            maxEntryPriceCents: Math.max(40, Math.min(80, Math.round(Number(body.maxEntryPriceCents ?? 65)))),
            trailingActivationDeltaCents: Math.max(3, Math.min(30, Math.round(Number(body.trailingActivationDeltaCents ?? 10)))),
            trailingDistanceCents: Math.max(1, Math.min(15, Math.round(Number(body.trailingDistanceCents ?? 2)))),
            hardCloseMinute: Math.max(1, Math.min(14, Math.round(Number(body.hardCloseMinute ?? 6)))),
          }
        : {}),
      ...(chosenStrategy === 'trailing_momentum'
        ? {
            entryTriggerCents: clampCents(Number(body.entryTriggerCents ?? 85)),
            maxEntryPriceCents: Math.max(50, Math.min(94, Math.round(Number(body.maxEntryPriceCents ?? 91)))),
            entryBandCents: 0,
            trailingActivationCents: clampCents(Number(body.trailingActivationCents ?? 88)),
            trailingActivationDeltaCents: Math.max(1, Math.min(30, Math.round(Number(body.trailingActivationDeltaCents ?? 3)))),
            trailingMinProfitCents: Math.max(1, Math.min(30, Math.round(Number(body.trailingMinProfitCents ?? 3)))),
            trailingDistanceCents: Math.max(1, Math.min(15, Math.round(Number(body.trailingDistanceCents ?? 2)))),
            takeProfitTargetCents: resolvedFixedTpA ?? 99,
            holdToSettle: defaultHoldSettleA,
            useTrailingStop: resolvedUseTrailingA ?? false,
          }
        : {}),
      maxContractsPerOrder: Math.max(1, Math.round(Number(body.maxContractsPerOrder ?? 1))),
      maxPositionContracts: Math.max(1, Math.round(Number(body.maxPositionContracts ?? 1))),
      maxSpreadCents: Math.max(1, Math.round(Number(body.maxSpreadCents ?? 2))),
      intervalSeconds: Math.max(1, Math.round(Number(body.intervalSeconds ?? (chosenStrategy === 'preopen_spike' ? 2 : 1)))),
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastSignalReason: 'Bot dibuat — siap evaluasi real-time (arah 5m & konfirm 1m).',
      tradesExecuted: 0,
      realizedPnlUsd: 0,
    };

    portfolioState.bots.unshift(newBot);
    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.status(201).json({ bot: newBot, portfolio: portfolioState });
  });

  app.post('/api/bots/deploy-15m-suite', (req, res) => {
    const body = req.body as {
      strategy?: 'trailing_momentum' | 'candle_prediction' | 'preopen_spike';
      entryTriggerCents?: number;
      trailingActivationCents?: number;
      trailingDistanceCents?: number;
      takeProfitTargetCents?: number;
      holdToSettle?: boolean;
      noStopLoss?: boolean;
      useCandleFilter?: boolean;
      minCandleConfidence?: number;
      stopLossCents?: number;
      takeProfitCents?: number;
      maxEntryPriceCents?: number;
      trailingActivationDeltaCents?: number;
      trailingMinProfitCents?: number;
      hardCloseMinute?: number;
      entryDelayMinSec?: number;
      entryDelayMaxSec?: number;
      maxContractsPerOrder?: number;
      maxSpreadCents?: number;
    };

    const suiteStrategy: BotConfig['strategy'] =
      body?.strategy === 'preopen_spike'
        ? 'preopen_spike'
        : body?.strategy === 'candle_prediction'
          ? 'candle_prediction'
          : 'trailing_momentum';

    const pairs15m = marketsCache.filter((m) => m.timeframe === '15m' || m.ticker.includes('15M'));
    let added = 0;
    let updated = 0;

    if (suiteStrategy === 'preopen_spike') {
      const tpDelta = Math.max(5, Math.min(45, Math.round(Number(body?.takeProfitCents ?? 16))));
      const noSlB = body?.noStopLoss ?? true;
      const slDelta = noSlB ? 0 : Math.max(5, Math.min(60, Math.round(Number(body?.stopLossCents ?? 0))));
      const trailActDelta = Math.max(3, Math.min(30, Math.round(Number(body?.trailingActivationDeltaCents ?? 10))));
      const trailDist = Math.max(1, Math.min(15, Math.round(Number(body?.trailingDistanceCents ?? 2))));
      const hardCloseMinute = Math.max(1, Math.min(14, Math.round(Number(body?.hardCloseMinute ?? 6))));
      const maxEntryPriceCents = Math.max(40, Math.min(80, Math.round(Number(body?.maxEntryPriceCents ?? 65))));
      const delayMin = Math.max(0, Math.min(60, Math.round(Number(body?.entryDelayMinSec ?? 5))));
      const delayMax = Math.max(delayMin, Math.min(60, Math.round(Number(body?.entryDelayMaxSec ?? 15))));
      const minConf = Math.max(50, Math.min(95, Math.round(Number(body?.minCandleConfidence ?? 58))));
      const maxContracts = Math.max(1, Math.round(Number(body?.maxContractsPerOrder ?? 1)));
      const maxSpread = Math.max(1, Math.round(Number(body?.maxSpreadCents ?? 3)));

      const errB = validateBotConfig({
        name: 'Varian B Pre-Open Suite',
        ticker: marketsCache[0]?.ticker || 'KXBTC15M',
        strategy: 'preopen_spike',
        takeProfitCents: tpDelta,
        stopLossCents: slDelta,
        noStopLoss: noSlB,
        trailingActivationDeltaCents: trailActDelta,
        trailingDistanceCents: trailDist,
        hardCloseMinute,
        maxEntryPriceCents,
        entryDelayMinSec: delayMin,
        entryDelayMaxSec: delayMax,
        minCandleConfidence: minConf,
        maxContractsPerOrder: maxContracts,
        maxPositionContracts: maxContracts,
      });
      if (errB) {
        res.status(400).json({ error: errB });
        return;
      }

      for (const m of pairs15m) {
        const mSeries = m.seriesTicker ?? getSeriesTicker(m.ticker);
        const existing = portfolioState.bots.find(
          (b) => getSeriesTicker(b.ticker) === mSeries && (b.strategy === 'preopen_spike' || b.id.startsWith('bot-varb-'))
        );
        if (existing) {
          existing.ticker = m.ticker;
          existing.strategy = 'preopen_spike';
          existing.name = `Varian B Pre-Open · ${formatPairLabel(m.ticker)}`;
          existing.status = 'running';
          existing.takeProfitCents = tpDelta;
          existing.stopLossCents = slDelta;
          existing.noStopLoss = noSlB;
          existing.trailingActivationDeltaCents = trailActDelta;
          existing.trailingDistanceCents = trailDist;
          existing.hardCloseMinute = hardCloseMinute;
          existing.maxEntryPriceCents = maxEntryPriceCents;
          existing.entryDelayMinSec = delayMin;
          existing.entryDelayMaxSec = delayMax;
          existing.entryWindowEndSec = 90;
          existing.minCandleConfidence = minConf;
          existing.maxContractsPerOrder = maxContracts;
          existing.maxPositionContracts = maxContracts;
          existing.maxSpreadCents = maxSpread;
          existing.intervalSeconds = 2;
          existing.lastSignalReason = `Varian B aktif — jeda ${delayMin}–${delayMax} dtk, max entry ${maxEntryPriceCents}¢, TP +${tpDelta}¢, Trail +${trailActDelta}¢/-${trailDist}¢, ${noSlB ? 'No SL' : `SL -${slDelta}¢`}, HC ${hardCloseMinute}m.`;
          updated += 1;
        } else {
          const created = createVarianBPreOpenBotForMarket(m);
          created.takeProfitCents = tpDelta;
          created.stopLossCents = slDelta;
          created.noStopLoss = noSlB;
          created.trailingActivationDeltaCents = trailActDelta;
          created.trailingDistanceCents = trailDist;
          created.hardCloseMinute = hardCloseMinute;
          created.maxEntryPriceCents = maxEntryPriceCents;
          created.entryDelayMinSec = delayMin;
          created.entryDelayMaxSec = delayMax;
          created.minCandleConfidence = minConf;
          created.maxContractsPerOrder = maxContracts;
          created.maxPositionContracts = maxContracts;
          created.maxSpreadCents = maxSpread;
          portfolioState.bots.push(created);
          added += 1;
        }
      }
    } else {
      const entryTriggerCents = clampCents(Number(body?.entryTriggerCents ?? 85));
      const maxEntryPriceCents = Math.max(
        entryTriggerCents,
        Math.min(94, Math.round(Number(body?.maxEntryPriceCents ?? 91)))
      );
      const holdToSettle = body?.holdToSettle ?? false;
      const takeProfitTargetCents = holdToSettle ? 0 : clampCents(Number(body?.takeProfitTargetCents ?? 99));
      const takeProfitCents = holdToSettle
        ? Math.max(0, Math.min(45, Math.round(Number(body?.takeProfitCents ?? 0))))
        : Math.max(1, Math.min(45, Math.round(Number(body?.takeProfitCents ?? 15))));
      const useTrailingStop = Boolean((body as { useTrailingStop?: boolean } | undefined)?.useTrailingStop ?? (takeProfitTargetCents < 50));
      const trailingActivationCents = clampCents(Number(body?.trailingActivationCents ?? 88));
      const trailingActivationDeltaCents = Math.max(
        1,
        Math.min(30, Math.round(Number(body?.trailingActivationDeltaCents ?? 3)))
      );
      const trailingMinProfitCents = Math.max(
        1,
        Math.min(30, Math.round(Number(body?.trailingMinProfitCents ?? 3)))
      );
      const trailingDistanceCents = Math.max(1, Math.min(15, Math.round(Number(body?.trailingDistanceCents ?? 2))));
      const useCandleFilter = body?.useCandleFilter ?? true;
      const minCandleConfidence = Math.max(50, Math.min(95, Math.round(Number(body?.minCandleConfidence ?? 60))));
      const noSlA = body?.noStopLoss ?? (suiteStrategy === 'trailing_momentum');
      const stopLossCents = noSlA ? 0 : Math.max(1, Math.round(Number(body?.stopLossCents ?? 70)));
      const maxContractsPerOrder = Math.max(1, Math.round(Number(body?.maxContractsPerOrder ?? 1)));
      const maxSpreadCents = Math.max(1, Math.round(Number(body?.maxSpreadCents ?? 2)));

      const suiteBotLabel =
        suiteStrategy === 'candle_prediction'
          ? 'Varian A Baca Candle'
          : holdToSettle
            ? 'Varian A Hold Settle'
            : takeProfitTargetCents >= 50
              ? `Varian A TP ${takeProfitTargetCents}¢`
              : `Varian A TP+${takeProfitCents}`;

      const validationErr = validateBotConfig({
        name: `${suiteBotLabel} Suite`,
        ticker: marketsCache[0]?.ticker || 'KXBTC15M',
        strategy: suiteStrategy,
        entryTriggerCents,
        maxEntryPriceCents,
        takeProfitCents,
        holdToSettle,
        useTrailingStop,
        trailingActivationCents,
        trailingActivationDeltaCents,
        trailingMinProfitCents,
        trailingDistanceCents,
        takeProfitTargetCents,
        minCandleConfidence,
        stopLossCents,
        noStopLoss: noSlA,
        maxContractsPerOrder,
        maxPositionContracts: maxContractsPerOrder,
      });
      if (validationErr) {
        res.status(400).json({ error: validationErr });
        return;
      }

      for (const m of pairs15m) {
        const mSeries = m.seriesTicker ?? getSeriesTicker(m.ticker);
        const existing = portfolioState.bots.find(
          (b) => getSeriesTicker(b.ticker) === mSeries && b.strategy !== 'preopen_spike' && b.id.startsWith('bot-15m-')
        );
        const tpDesc =
          takeProfitTargetCents >= 50
            ? `TP ${takeProfitTargetCents}¢${useTrailingStop ? ` + Trail +${trailingActivationDeltaCents}¢/-${trailingDistanceCents}¢` : ' (atau Settle)'}`
            : `TP +${takeProfitCents}¢, Trail +${trailingActivationDeltaCents}¢/-${trailingDistanceCents}¢ (min jual +${trailingMinProfitCents}¢)`;
        if (existing) {
          existing.ticker = m.ticker;
          existing.strategy = suiteStrategy;
          existing.name = `${suiteBotLabel} · ${formatPairLabel(m.ticker)}`;
          existing.status = 'running';
          existing.entryTriggerCents = entryTriggerCents;
          existing.maxEntryPriceCents = maxEntryPriceCents;
          existing.entryBandCents = 0;
          existing.takeProfitCents = takeProfitCents;
          existing.trailingActivationCents = trailingActivationCents;
          existing.trailingActivationDeltaCents = trailingActivationDeltaCents;
          existing.trailingMinProfitCents = trailingMinProfitCents;
          existing.trailingDistanceCents = trailingDistanceCents;
          existing.takeProfitTargetCents = takeProfitTargetCents;
          existing.holdToSettle = holdToSettle;
          existing.useTrailingStop = useTrailingStop;
          existing.useCandleFilter = useCandleFilter;
          existing.minCandleConfidence = minCandleConfidence;
          existing.noStopLoss = noSlA;
          existing.stopLossCents = stopLossCents;
          existing.maxContractsPerOrder = maxContractsPerOrder;
          existing.maxPositionContracts = maxContractsPerOrder;
          existing.maxSpreadCents = maxSpreadCents;
          existing.intervalSeconds = 1;
          existing.lastSignalReason =
            suiteStrategy === 'candle_prediction'
              ? `Varian A Baca Candle aktif (Min Conf ${minCandleConfidence}%, ${holdToSettle ? 'Hold Fix Settle' : `TP +${takeProfitCents}¢`}, ${noSlA ? 'No SL' : `SL -${stopLossCents}¢`}).`
              : holdToSettle
                ? `Varian A aktif — entry ${entryTriggerCents}–${maxEntryPriceCents}¢ harga naik + prediksi arah 5m & konfirm candle 1m (>=${minCandleConfidence}%), Tanpa TP (Hold sampai Settle), ${noSlA ? 'No SL' : `SL -${stopLossCents}¢`}.`
                : `Varian A aktif — entry ${entryTriggerCents}–${maxEntryPriceCents}¢ harga naik ketat (anti pisau jatuh) + arah 5m & konfirm 1m (>=${minCandleConfidence}%), ${tpDesc}, ${noSlA ? 'No SL' : `SL -${stopLossCents}¢`}.`;
          updated += 1;
        } else {
          const created = createTrailing15mBotForMarket(m);
          created.strategy = suiteStrategy;
          created.name = `${suiteBotLabel} · ${formatPairLabel(m.ticker)}`;
          created.entryTriggerCents = entryTriggerCents;
          created.maxEntryPriceCents = maxEntryPriceCents;
          created.takeProfitCents = takeProfitCents;
          created.trailingActivationCents = trailingActivationCents;
          created.trailingActivationDeltaCents = trailingActivationDeltaCents;
          created.trailingMinProfitCents = trailingMinProfitCents;
          created.trailingDistanceCents = trailingDistanceCents;
          created.takeProfitTargetCents = takeProfitTargetCents;
          created.holdToSettle = holdToSettle;
          created.useTrailingStop = useTrailingStop;
          created.useCandleFilter = useCandleFilter;
          created.minCandleConfidence = minCandleConfidence;
          created.noStopLoss = noSlA;
          created.stopLossCents = stopLossCents;
          created.maxContractsPerOrder = maxContractsPerOrder;
          created.maxPositionContracts = maxContractsPerOrder;
          created.maxSpreadCents = maxSpreadCents;
          portfolioState.bots.unshift(created);
          added += 1;
        }
      }
    }

    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({
      strategy: suiteStrategy,
      deployedCount: pairs15m.length,
      added,
      updated,
      portfolio: portfolioState,
    });
  });

  app.patch('/api/bots/:id', (req, res) => {
    const bot = portfolioState.bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'Bot tidak ditemukan.' });
      return;
    }
    const patch = req.body as Partial<BotConfig>;
    if (patch.name && patch.name.trim().length >= 2) {
      bot.name = patch.name.trim();
    }
    if (patch.ticker) {
      bot.ticker = patch.ticker.trim();
    }
    if (patch.strategy) {
      bot.strategy = patch.strategy;
    }
    if (patch.targetSide) {
      bot.targetSide = patch.targetSide;
    }
    if (patch.status) {
      bot.status = patch.status;
    }
    if (patch.executionMode) {
      if (patch.executionMode === 'live' && !HAS_CREDENTIALS) {
        res.status(400).json({
          error: 'Mode Live API membutuhkan KALSHI_API_KEY_ID & KALSHI_PRIVATE_KEY di environment server.',
        });
        return;
      }
      bot.executionMode = patch.executionMode;
    }
    if (typeof patch.fairValueCents === 'number') bot.fairValueCents = clampCents(patch.fairValueCents);
    if (typeof patch.entryEdgeCents === 'number') bot.entryEdgeCents = Math.max(1, Math.round(patch.entryEdgeCents));
    if (typeof patch.takeProfitCents === 'number') bot.takeProfitCents = Math.max(0, Math.round(patch.takeProfitCents));
    if (typeof patch.noStopLoss === 'boolean') {
      bot.noStopLoss = patch.noStopLoss;
      if (patch.noStopLoss) {
        bot.stopLossCents = 0;
      }
    }
    if (typeof patch.stopLossCents === 'number') {
      bot.stopLossCents = Math.max(0, Math.round(patch.stopLossCents));
      if (patch.stopLossCents <= 0) {
        bot.noStopLoss = true;
      } else if (patch.noStopLoss === undefined) {
        bot.noStopLoss = false;
      }
    }
    if (typeof patch.entryTriggerCents === 'number') bot.entryTriggerCents = clampCents(patch.entryTriggerCents);
    if (typeof patch.entryBandCents === 'number') {
      bot.entryBandCents = Math.max(0, Math.min(3, Math.round(patch.entryBandCents)));
    }
    if (typeof patch.trailingActivationCents === 'number') {
      bot.trailingActivationCents = clampCents(patch.trailingActivationCents);
    }
    if (typeof patch.trailingDistanceCents === 'number') {
      bot.trailingDistanceCents = Math.max(1, Math.min(15, Math.round(patch.trailingDistanceCents)));
    }
    if (typeof patch.takeProfitTargetCents === 'number') {
      bot.takeProfitTargetCents = clampCents(patch.takeProfitTargetCents);
    }
    if (typeof patch.entryDelayMinSec === 'number') {
      bot.entryDelayMinSec = Math.max(0, Math.min(60, Math.round(patch.entryDelayMinSec)));
    }
    if (typeof patch.entryDelayMaxSec === 'number') {
      bot.entryDelayMaxSec = Math.max(1, Math.min(60, Math.round(patch.entryDelayMaxSec)));
    }
    if (typeof patch.entryWindowEndSec === 'number') {
      bot.entryWindowEndSec = Math.max(15, Math.min(300, Math.round(patch.entryWindowEndSec)));
    }
    if (typeof patch.maxEntryPriceCents === 'number') {
      const maxAllowedCap = bot.strategy === 'preopen_spike' ? 80 : 94;
      bot.maxEntryPriceCents = Math.max(40, Math.min(maxAllowedCap, Math.round(patch.maxEntryPriceCents)));
    }
    if (typeof patch.trailingActivationDeltaCents === 'number') {
      bot.trailingActivationDeltaCents = Math.max(1, Math.min(30, Math.round(patch.trailingActivationDeltaCents)));
    }
    if (typeof patch.trailingMinProfitCents === 'number') {
      bot.trailingMinProfitCents = Math.max(1, Math.min(30, Math.round(patch.trailingMinProfitCents)));
    }
    if (typeof patch.hardCloseMinute === 'number') {
      bot.hardCloseMinute = Math.max(1, Math.min(14, Math.round(patch.hardCloseMinute)));
    }
    if (typeof patch.holdToSettle === 'boolean') {
      bot.holdToSettle = patch.holdToSettle;
    }
    if (typeof patch.useTrailingStop === 'boolean') {
      bot.useTrailingStop = patch.useTrailingStop;
    }
    if (typeof patch.useCandleFilter === 'boolean') {
      bot.useCandleFilter = patch.useCandleFilter;
    }
    if (typeof patch.minCandleConfidence === 'number') {
      bot.minCandleConfidence = Math.max(50, Math.min(95, Math.round(patch.minCandleConfidence)));
    }
    if (typeof patch.maxContractsPerOrder === 'number') {
      bot.maxContractsPerOrder = Math.max(1, Math.round(patch.maxContractsPerOrder));
    }
    if (typeof patch.maxPositionContracts === 'number') {
      bot.maxPositionContracts = Math.max(1, Math.round(patch.maxPositionContracts));
    }
    if (typeof patch.maxSpreadCents === 'number') {
      bot.maxSpreadCents = Math.max(1, Math.round(patch.maxSpreadCents));
    }

    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({ bot, portfolio: portfolioState });
  });

  app.delete('/api/bots/:id', (req, res) => {
    const idx = portfolioState.bots.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Bot tidak ditemukan.' });
      return;
    }
    portfolioState.bots.splice(idx, 1);
    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({ portfolio: portfolioState });
  });

  app.post('/api/bots/:id/tick', async (req, res) => {
    const bot = portfolioState.bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'Bot tidak ditemukan.' });
      return;
    }
    const result = await executeBotTick(bot);
    broadcastRealtimeState('state_update');
    res.json({ ...result, portfolio: portfolioState });
  });

  app.post('/api/bots/run-cycle', async (_req, res) => {
    await fetchLiveKalshiMarkets();
    const results = [];
    for (const bot of portfolioState.bots) {
      if (bot.status === 'running') {
        results.push(await executeBotTick(bot));
      }
    }
    const executedCount = results.filter((r) => r.order?.status === 'filled').length;
    broadcastRealtimeState('state_update', executedCount);
    res.json({
      executedCount,
      markets: marketsCache,
      orderbooks: orderbooksCache,
      portfolio: portfolioState,
    });
  });

  app.post('/api/orders', async (req, res) => {
    const body = req.body as {
      ticker?: string;
      side?: OrderSide;
      action?: OrderAction;
      contracts?: number;
      priceCents?: number;
      mode?: ExecutionMode;
      botId?: string | null;
    };

    const ticker = String(body.ticker || '').trim();
    const market = marketsCache.find((m) => m.ticker === ticker);
    if (!market) {
      res.status(400).json({ error: 'Market ticker tidak valid.' });
      return;
    }
    if (!is15mMarketTicker(market.ticker) && market.timeframe !== '15m') {
      res.status(400).json({ error: 'Trading hanya diizinkan untuk market 15 menit (15m).' });
      return;
    }

    const side: OrderSide = body.side === 'no' ? 'no' : 'yes';
    const action: OrderAction = body.action === 'sell' ? 'sell' : 'buy';
    const contracts = Math.round(Number(body.contracts || 0));
    const priceCents = clampCents(Number(body.priceCents || 50));

    if (!Number.isFinite(contracts) || contracts <= 0) {
      res.status(400).json({ error: 'Jumlah kontrak harus lebih dari 0.' });
      return;
    }
    if (portfolioState.riskLimits.killSwitchActive) {
      res.status(400).json({ error: 'Kill Switch aktif — nonaktifkan sebelum mengirim order.' });
      return;
    }

    const feeUsd = calcKalshiFee(contracts, priceCents);
    const grossUsd = calcContractCost(contracts, priceCents);
    let targetBotId: string | null = null;
    let targetBotName = 'Manual Ticket';

    if (action === 'buy') {
      if (portfolioState.cashUsd < grossUsd + feeUsd) {
        res.status(400).json({
          error: `Saldo tidak cukup ($${portfolioState.cashUsd.toFixed(2)} < $${(grossUsd + feeUsd).toFixed(2)}).`,
        });
        return;
      }
      if (grossUsd > portfolioState.riskLimits.maxExposurePerMarketUsd) {
        res.status(400).json({
          error: `Nilai order ($${grossUsd.toFixed(2)}) melebihi batas eksposur per market ($${portfolioState.riskLimits.maxExposurePerMarketUsd.toFixed(2)}).`,
        });
        return;
      }
    } else {
      const existingPos =
        body.botId !== undefined
          ? portfolioState.positions.find(
              (p) => p.ticker === ticker && p.side === side && (p.botId ?? null) === (body.botId ?? null)
            )
          : portfolioState.positions.find((p) => p.ticker === ticker && p.side === side);
      if (!existingPos || existingPos.contracts < contracts) {
        res.status(400).json({
          error: `Posisi ${side.toUpperCase()} tidak mencukupi untuk dijual (tersedia ${existingPos?.contracts ?? 0} kontrak).`,
        });
        return;
      }
      targetBotId = existingPos.botId ?? null;
      if (targetBotId) {
        const linkedBot = portfolioState.bots.find((b) => b.id === targetBotId);
        targetBotName = linkedBot ? `${linkedBot.name} (Manual Close)` : 'Manual Close';
      }
    }

    const mode: ExecutionMode = body.mode === 'live' && HAS_CREDENTIALS ? 'live' : 'paper';
    const clientOrderId = crypto.randomUUID();

    if (mode === 'live') {
      const liveRes = await submitKalshiLiveOrder({
        ticker,
        side,
        action,
        contracts,
        priceCents,
        clientOrderId,
      });
      if (!liveRes.ok) {
        res.status(502).json({ error: liveRes.message });
        return;
      }
    }

    const order = applyFilledOrder({
      botId: targetBotId,
      botName: targetBotName,
      ticker,
      marketTitle: market.title,
      side,
      action,
      contracts,
      priceCents,
      feeUsd,
      mode,
      reason: `Manual ${action.toUpperCase()} ${side.toUpperCase()} @ ${priceCents}¢`,
      clientOrderId,
    });

    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.status(201).json({ order, portfolio: portfolioState });
  });

  app.post('/api/risk', (req, res) => {
    const patch = req.body as Partial<RiskLimits> & { executionMode?: ExecutionMode };
    if (typeof patch.maxDailyLossUsd === 'number' && patch.maxDailyLossUsd > 0) {
      portfolioState.riskLimits.maxDailyLossUsd = patch.maxDailyLossUsd;
    }
    if (typeof patch.maxExposurePerMarketUsd === 'number' && patch.maxExposurePerMarketUsd > 0) {
      portfolioState.riskLimits.maxExposurePerMarketUsd = patch.maxExposurePerMarketUsd;
    }
    if (typeof patch.maxOpenOrders === 'number' && patch.maxOpenOrders >= 1) {
      portfolioState.riskLimits.maxOpenOrders = Math.round(patch.maxOpenOrders);
    }
    if (typeof patch.killSwitchActive === 'boolean') {
      portfolioState.riskLimits.killSwitchActive = patch.killSwitchActive;
      if (patch.killSwitchActive) {
        portfolioState.bots = portfolioState.bots.map((b) =>
          b.status === 'running' ? { ...b, status: 'paused', lastSignalReason: 'Dihentikan oleh Kill Switch.' } : b
        );
      }
    }
    if (patch.executionMode) {
      if (patch.executionMode === 'live' && !HAS_CREDENTIALS) {
        res.status(400).json({
          error: 'Environment server belum memiliki KALSHI_API_KEY_ID & KALSHI_PRIVATE_KEY.',
        });
        return;
      }
      portfolioState.executionMode = patch.executionMode;
    }
    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({ portfolio: portfolioState });
  });

  app.post('/api/trading/control', (req, res) => {
    const body = req.body as {
      action?: 'live' | 'pause';
      executionMode?: ExecutionMode;
    };

    if (body.executionMode === 'live' && !HAS_CREDENTIALS) {
      res.status(400).json({
        error: 'Mode Live Kalshi API membutuhkan KALSHI_API_KEY_ID & KALSHI_PRIVATE_KEY di environment server.',
      });
      return;
    }

    if (body.executionMode) {
      portfolioState.executionMode = body.executionMode;
      portfolioState.bots = portfolioState.bots.map((b) => ({
        ...b,
        executionMode: body.executionMode as ExecutionMode,
      }));
    }

    if (body.action === 'pause') {
      portfolioState.tradingPaused = true;
      portfolioState.bots = portfolioState.bots.map((b) =>
        b.status === 'running'
          ? { ...b, status: 'paused', lastSignalReason: 'Trading dijeda melalui tombol Pause Trade.' }
          : b
      );
    } else if (body.action === 'live') {
      if (portfolioState.riskLimits.killSwitchActive) {
        res.status(400).json({
          error: 'Kill Switch aktif — matikan Kill Switch di menu Risk & API sebelum memulai trading.',
        });
        return;
      }
      portfolioState.tradingPaused = false;
      portfolioState.bots = portfolioState.bots.map((b) => ({
        ...b,
        status: 'running',
        lastSignalReason:
          b.strategy === 'preopen_spike'
            ? `Live Trade aktif (Varian B) — baca candle pre-open, tunggu 5–15 dtk, max entry ${b.maxEntryPriceCents ?? 65}¢, TP +${b.takeProfitCents}¢, Trail +${b.trailingActivationDeltaCents ?? 10}¢/-${b.trailingDistanceCents ?? 2}¢, ${b.noStopLoss || b.stopLossCents <= 0 ? 'No SL' : `SL -${b.stopLossCents}¢`}, HC ${b.hardCloseMinute ?? 6}m.`
            : b.holdToSettle || ((b.takeProfitTargetCents ?? 0) < 50 && b.takeProfitCents <= 0)
              ? `Live Trade aktif (Varian A) — entry ${b.entryTriggerCents ?? 85}–${b.maxEntryPriceCents ?? 91}¢ + candle searah, Tanpa TP (Hold sampai Settle), ${b.noStopLoss || b.stopLossCents <= 0 ? 'No SL' : `SL -${b.stopLossCents}¢`}.`
              : (b.takeProfitTargetCents ?? 0) >= 50
                ? `Live Trade aktif (Varian A) — entry ${b.entryTriggerCents ?? 85}–${b.maxEntryPriceCents ?? 91}¢ naik ketat (anti pisau jatuh) + arah 5m & konfirm 1m, TP ${b.takeProfitTargetCents}¢ (atau Settle), ${b.noStopLoss || b.stopLossCents <= 0 ? 'No SL' : `SL -${b.stopLossCents}¢`}.`
                : `Live Trade aktif (Varian A) — entry ${b.entryTriggerCents ?? 85}–${b.maxEntryPriceCents ?? 91}¢ + candle searah, TP +${b.takeProfitCents}¢, Trail +${b.trailingActivationDeltaCents ?? 3}¢/-${b.trailingDistanceCents ?? 2}¢ (min +${b.trailingMinProfitCents ?? 3}¢), ${b.noStopLoss || b.stopLossCents <= 0 ? 'No SL' : `SL -${b.stopLossCents}¢`}.`,
      }));
    }

    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({ portfolio: portfolioState });
  });

  app.post('/api/portfolio/reset', (req, res) => {
    const includeVariantB = Boolean((req.body as { includeVariantB?: boolean } | undefined)?.includeVariantB);
    const hadVarB = portfolioState.bots.some(
      (b) => b.strategy === 'preopen_spike' || b.id.startsWith('bot-varb-')
    );
    const fresh = structuredClone(INITIAL_PORTFOLIO_STATE);
    fresh.cashUsd = 20;
    fresh.startingCashUsd = 20;
    fresh.dailyRealizedPnlUsd = 0;
    fresh.totalFilledOrders = 0;
    fresh.orders = [];
    fresh.positions = [];
    fresh.dailyHistory = {};
    fresh.tradedTickers = [];
    fresh.tradingPaused = false;
    fresh.executionMode = portfolioState.executionMode === 'live' && HAS_CREDENTIALS ? 'live' : 'paper';
    if (!hadVarB && !includeVariantB) {
      fresh.bots = fresh.bots.filter(
        (b) => b.strategy !== 'preopen_spike' && !b.id.startsWith('bot-varb-')
      );
    }
    fresh.updatedAt = new Date().toISOString();
    for (const bot of fresh.bots) {
      bot.status = 'running';
      bot.executionMode = fresh.executionMode;
      bot.tradesExecuted = 0;
      bot.realizedPnlUsd = 0;
      bot.lastRunAt = null;
      if (bot.strategy === 'trailing_momentum') {
        bot.intervalSeconds = 1;
      }
      const botSeries = getSeriesTicker(bot.ticker);
      const liveMatch = marketsCache.find(
        (m) => (m.seriesTicker ?? getSeriesTicker(m.ticker)) === botSeries && m.source === 'kalshi_live'
      );
      if (liveMatch) {
        bot.ticker = liveMatch.ticker;
      }
    }
    portfolioState = fresh;
    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({ portfolio: portfolioState });
  });

  app.post('/api/portfolio/clear-variant', (req, res) => {
    const rawVariant = (req.body as { variant?: string } | undefined)?.variant;
    const variant: StrategyVariant = rawVariant === 'A' ? 'A' : 'B';
    portfolioState = clearVariantHistoryAndPnl(portfolioState, variant);
    savePersistedState(portfolioState);
    broadcastRealtimeState('state_update');
    res.json({ portfolio: portfolioState, clearedVariant: variant });
  });

  app.post('/api/backtest', async (req, res) => {
    const body = req.body as {
      ticker?: string;
      strategy?: BotConfig['strategy'];
      fairValueCents?: number;
      entryEdgeCents?: number;
      takeProfitCents?: number;
      stopLossCents?: number;
      noStopLoss?: boolean;
      entryTriggerCents?: number;
      trailingActivationCents?: number;
      trailingDistanceCents?: number;
      takeProfitTargetCents?: number;
      holdToSettle?: boolean;
      minCandleConfidence?: number;
      maxEntryPriceCents?: number;
      trailingActivationDeltaCents?: number;
      trailingMinProfitCents?: number;
      hardCloseMinute?: number;
      contractsPerTrade?: number;
      initialCapitalUsd?: number;
      ticks?: number;
    };

    const ticker = String(body.ticker || marketsCache[0]?.ticker || 'KXBTC15M');
    const market = marketsCache.find((m) => m.ticker === ticker) ?? marketsCache[0];
    const basePrice = market ? market.lastPrice : 50;
    const tickCount = Math.max(10, Math.min(200, Math.round(Number(body.ticks ?? 60))));

    // Fetch real historical Kalshi trades for this contract (no synthetic ticks)
    const liveTrades = await fetchRecentTradePrices(ticker, tickCount);
    const priceSeries: number[] =
      liveTrades.length >= 3
        ? liveTrades
        : market?.source === 'kalshi_live' && market.priceHistory.length >= 2
          ? [...market.priceHistory]
          : [];

    if (priceSeries.length < 2) {
      res.status(503).json({
        error: 'Riwayat trade live Kalshi untuk kontrak ini belum tersedia atau masih terlalu sedikit (< 2 trade).',
      });
      return;
    }

    const btStrategy = body.strategy || 'trailing_momentum';
    const btHoldToSettle =
      body.holdToSettle ?? (btStrategy === 'candle_prediction');
    const btTpTarget = btHoldToSettle ? 0 : clampCents(Number(body.takeProfitTargetCents ?? 99));
    const btUseTrailing =
      typeof (body as { useTrailingStop?: boolean }).useTrailingStop === 'boolean'
        ? Boolean((body as { useTrailingStop?: boolean }).useTrailingStop)
        : btTpTarget < 50;
    const btNoSl =
      typeof body.noStopLoss === 'boolean'
        ? body.noStopLoss
        : btStrategy === 'trailing_momentum' || btStrategy === 'preopen_spike'
          ? (body.stopLossCents === undefined || Number(body.stopLossCents) <= 0)
          : false;
    const result = runBacktest(
      {
        strategy: btStrategy,
        ticker,
        fairValueCents: clampCents(Number(body.fairValueCents ?? basePrice)),
        entryEdgeCents: Math.max(1, Math.round(Number(body.entryEdgeCents ?? 4))),
        takeProfitCents: btHoldToSettle
          ? Math.max(0, Math.round(Number(body.takeProfitCents ?? 0)))
          : Math.max(1, Math.round(Number(body.takeProfitCents ?? (btStrategy === 'preopen_spike' ? 16 : 15)))),
        stopLossCents: btNoSl ? 0 : Math.max(1, Math.round(Number(body.stopLossCents ?? 20))),
        noStopLoss: btNoSl,
        entryTriggerCents: clampCents(Number(body.entryTriggerCents ?? 85)),
        trailingActivationCents: clampCents(Number(body.trailingActivationCents ?? 88)),
        trailingDistanceCents: Math.max(1, Math.round(Number(body.trailingDistanceCents ?? 2))),
        takeProfitTargetCents: btTpTarget,
        holdToSettle: btHoldToSettle,
        useTrailingStop: btUseTrailing,
        minCandleConfidence: Math.max(50, Math.min(95, Math.round(Number(body.minCandleConfidence ?? 60)))),
        maxEntryPriceCents: Math.max(
          40,
          Math.min(
            btStrategy === 'preopen_spike' ? 80 : 94,
            Math.round(Number(body.maxEntryPriceCents ?? (btStrategy === 'preopen_spike' ? 65 : 91)))
          )
        ),
        trailingActivationDeltaCents: Math.max(
          1,
          Math.min(30, Math.round(Number(body.trailingActivationDeltaCents ?? (btStrategy === 'trailing_momentum' ? 3 : 10))))
        ),
        trailingMinProfitCents: Math.max(1, Math.min(30, Math.round(Number(body.trailingMinProfitCents ?? 3)))),
        hardCloseMinute: Math.max(1, Math.min(14, Math.round(Number(body.hardCloseMinute ?? 6)))),
        contractsPerTrade: Math.max(1, Math.round(Number(body.contractsPerTrade ?? 1))),
        initialCapitalUsd: Math.max(1, Number(body.initialCapitalUsd ?? 20)),
      },
      priceSeries
    );

    res.json({ result, priceSeries });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Server-authoritative adaptive real-time stream loop (~350ms cadence, zero overlap)
  // 1) Priority markets (subscribed ticker, open position, or active entry window): refresh >= 350ms
  // 2) Secondary active markets: refresh >= 850ms
  // 3) Background non-blocking metadata sync (~5s or near rollover) & 5m+1m candle sync (~1.5s)
  // 4) Instant bot execution + WS broadcast whenever any bid/ask/mid quote changes
  let isTickRunning = false;
  let isMetaSyncRunning = false;
  let isCandleSyncRunning = false;
  let isLoopStopped = false;
  let realtimeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMetaSyncMs = Date.now();
  let lastCandleSyncMs = Date.now();
  let lastHeartbeatBroadcastMs = Date.now();

  const runRealtimePass = async () => {
    if (isLoopStopped || isTickRunning) return;
    isTickRunning = true;

    try {
      const nowMs = Date.now();

      // Trigger background metadata & rollover sync every 5s (or immediately near/past 15m rollover)
      const nearRollover = marketsCache.some((m) => {
        if (m.source !== 'kalshi_live') return false;
        const closeMs = Date.parse(m.closeTime);
        return Number.isFinite(closeMs) && closeMs - nowMs <= 5000;
      });
      if (!isMetaSyncRunning && (nearRollover || nowMs - lastMetaSyncMs >= 5000)) {
        isMetaSyncRunning = true;
        lastMetaSyncMs = nowMs;
        void fetchLiveKalshiMarkets({ includeOrderbooks: false, includeCandles: false }).finally(() => {
          isMetaSyncRunning = false;
        });
      }

      // Trigger background 5m+1m spot & Kalshi candle prediction refresh every 1.5s (non-blocking)
      if (!isCandleSyncRunning && nowMs - lastCandleSyncMs >= 1500) {
        isCandleSyncRunning = true;
        lastCandleSyncMs = nowMs;
        void refreshCandlesAndPredictionsForMarkets(marketsCache).finally(() => {
          isCandleSyncRunning = false;
        });
      }

      const subscribedTickers = new Set<string>(clientSubscriptions.values());
      const openPosTickers = new Set<string>(
        portfolioState.positions.filter((p) => p.contracts > 0).map((p) => p.ticker)
      );
      const hasVarB = portfolioState.bots.some((b) => b.strategy === 'preopen_spike' && b.status === 'running');

      const priorityTickers = new Set<string>();
      const secondaryTickers = new Set<string>();

      for (const m of marketsCache) {
        if (m.source !== 'kalshi_live' || m.status !== 'active') continue;
        const isSub = subscribedTickers.has(m.ticker);
        const hasPos = openPosTickers.has(m.ticker);
        const inWindowA = isInsideMinuteWindow(m.closeTime, nowMs, 7, 13);
        const inWindowB = hasVarB && isInsideMinuteWindow(m.closeTime, nowMs, 0, 2);
        const lastFetched = lastOrderbookFetchMs.get(m.ticker) ?? 0;
        const age = nowMs - lastFetched;

        if (isSub || hasPos || inWindowA || inWindowB) {
          if (age >= 350) priorityTickers.add(m.ticker);
        } else if (age >= 850) {
          secondaryTickers.add(m.ticker);
        }
      }

      for (const ticker of subscribedTickers) {
        if (
          marketsCache.some((m) => m.ticker === ticker && m.source === 'kalshi_live') &&
          nowMs - (lastOrderbookFetchMs.get(ticker) ?? 0) >= 350
        ) {
          priorityTickers.add(ticker);
        }
      }

      const quoteBefore = new Map<string, string>();
      for (const m of marketsCache) {
        quoteBefore.set(m.ticker, `${m.yesBid}:${m.yesAsk}:${m.noBid}:${m.noAsk}:${m.lastPrice}`);
      }

      const fetchList = [...priorityTickers, ...secondaryTickers];
      if (fetchList.length > 0) {
        const orderbookBatch = Promise.allSettled(fetchList.map((t) => fetchLiveOrderbook(t)));
        await Promise.race([
          orderbookBatch,
          new Promise<void>((resolve) => setTimeout(resolve, 750)),
        ]);
        apiStatus.publicFeedOnline = true;
        apiStatus.lastFeedSyncAt = new Date().toISOString();
      } else if (marketsCache.every((m) => m.source !== 'kalshi_live') && !isMetaSyncRunning) {
        await fetchLiveKalshiMarkets({ includeOrderbooks: true, includeCandles: false });
      }

      const quoteChangedTickers = new Set<string>();
      for (const m of marketsCache) {
        const prev = quoteBefore.get(m.ticker);
        const next = `${m.yesBid}:${m.yesAsk}:${m.noBid}:${m.noAsk}:${m.lastPrice}`;
        if (prev !== undefined && prev !== next) {
          quoteChangedTickers.add(m.ticker);
        }
      }

      let executedCount = 0;
      if (
        apiStatus.publicFeedOnline &&
        !portfolioState.riskLimits.killSwitchActive &&
        !portfolioState.tradingPaused
      ) {
        const tickNowMs = Date.now();
        for (const bot of portfolioState.bots) {
          if (bot.status !== 'running') continue;
          const hasOpenPosition = portfolioState.positions.some(
            (p) => p.ticker === bot.ticker && (p.botId ?? null) === bot.id && p.contracts > 0
          );
          const quoteChanged = quoteChangedTickers.has(bot.ticker);
          const lastRunMs = bot.lastRunAt ? Date.parse(bot.lastRunAt) : 0;
          const intervalDue =
            !Number.isFinite(lastRunMs) || tickNowMs - lastRunMs >= bot.intervalSeconds * 1000;
          if (hasOpenPosition || quoteChanged || intervalDue) {
            const res = await executeBotTick(bot);
            if (res.order?.status === 'filled') {
              executedCount += 1;
            }
          }
        }
      }

      const subUpdated = Array.from(subscribedTickers).some((t) => priorityTickers.has(t));
      const heartbeatDue = Date.now() - lastHeartbeatBroadcastMs >= 1000;
      if (quoteChangedTickers.size > 0 || executedCount > 0 || subUpdated || heartbeatDue) {
        lastHeartbeatBroadcastMs = Date.now();
        broadcastRealtimeState('tick', executedCount > 0 ? executedCount : undefined);
      }
    } catch (err) {
      console.warn('[kalshi-bot] Real-time tick error:', err);
    } finally {
      isTickRunning = false;
      if (!isLoopStopped) {
        realtimeTimer = setTimeout(() => {
          void runRealtimePass();
        }, 350);
      }
    }
  };

  realtimeTimer = setTimeout(() => {
    void runRealtimePass();
  }, 350);

  httpServer.on('close', () => {
    isLoopStopped = true;
    if (realtimeTimer) {
      clearTimeout(realtimeTimer);
      realtimeTimer = null;
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`KalshiBot server & WebSocket /ws listening on http://0.0.0.0:${PORT}`);
    void backfillEntryHighLowFromKalshi(() => broadcastRealtimeState('state_update'));
  });
}

let isBackfillRunning = false;

async function fetchPaginatedMarketTrades(ticker: string, minTsSec: number): Promise<
  Array<{ created_time?: string; yes_price?: number; yes_price_dollars?: string }>
> {
  const allTrades: Array<{ created_time?: string; yes_price?: number; yes_price_dollars?: string }> = [];
  let cursor: string | undefined;

  for (let page = 0; page < 6; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const url =
        `${KALSHI_PUBLIC_MARKET_URL}/trade-api/v2/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=500&min_ts=${minTsSec}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) break;
      const json = (await res.json()) as {
        trades?: Array<{ created_time?: string; yes_price?: number; yes_price_dollars?: string }>;
        cursor?: string;
      };
      const batch = Array.isArray(json.trades) ? json.trades : [];
      if (batch.length === 0) break;
      allTrades.push(...batch);
      if (!json.cursor || batch.length < 500) break;
      cursor = json.cursor;
    } catch {
      clearTimeout(timer);
      break;
    }
  }
  return allTrades.reverse();
}

async function backfillEntryHighLowFromKalshi(onUpdated?: () => void): Promise<void> {
  if (isBackfillRunning || !portfolioState.dailyHistory) return;
  isBackfillRunning = true;

  try {
    const entriesNeedingBackfill: DailyTradeEntry[] = [];
    const buyByTradeKey = new Map<string, DailyTradeEntry>();

    for (const dayRec of Object.values(portfolioState.dailyHistory)) {
      for (const e of dayRec.entries) {
        if (e.action === 'buy') {
          const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
          if (!buyByTradeKey.has(key)) buyByTradeKey.set(key, e);
        }
        const missingHigh = e.highestBidCents == null || !e.highestBidAt;
        const missingLowAt = typeof e.lowestBidCents === 'number' && !e.lowestBidAt;
        if (missingHigh || missingLowAt) {
          entriesNeedingBackfill.push(e);
        }
      }
    }

    if (entriesNeedingBackfill.length === 0) return;

    const nowMs = Date.now();
    const tickersToFetch = new Set<string>();
    for (const e of entriesNeedingBackfill) {
      const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
      const buyRef = e.action === 'buy' ? e : buyByTradeKey.get(key);
      const refMs = Date.parse((buyRef ?? e).createdAt);
      if (!Number.isFinite(refMs)) continue;
      // Only fetch historical trade logs once the 15m contract window has already ended or is well underway
      const closeMs = Math.floor(refMs / 900_000) * 900_000 + 900_000;
      if (nowMs >= closeMs - 14 * 60_000) {
        tickersToFetch.add(e.ticker);
      }
    }

    const tickerList = Array.from(tickersToFetch);
    if (tickerList.length === 0) return;

    const tickerTradesCache = new Map<
      string,
      {
        openMs: number;
        closeMs: number;
        trades: Array<{ ms: number; yesPrice: number }>;
      }
    >();

    // Fetch in bounded batches of 5 to stay friendly to Kalshi public rate limits
    for (let i = 0; i < tickerList.length; i += 5) {
      const batch = tickerList.slice(i, i + 5);
      await Promise.allSettled(
        batch.map(async (ticker) => {
          // Determine earliest buy timestamp for this ticker
          let earliestBuyMs = Infinity;
          for (const e of entriesNeedingBackfill) {
            if (e.ticker === ticker && e.action === 'buy') {
              const ms = Date.parse(e.createdAt);
              if (Number.isFinite(ms) && ms < earliestBuyMs) earliestBuyMs = ms;
            }
          }
          if (!Number.isFinite(earliestBuyMs)) {
            for (const e of entriesNeedingBackfill) {
              if (e.ticker === ticker) {
                const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
                const b = buyByTradeKey.get(key);
                const ms = Date.parse((b ?? e).createdAt);
                if (Number.isFinite(ms) && ms < earliestBuyMs) earliestBuyMs = ms;
              }
            }
          }
          if (!Number.isFinite(earliestBuyMs)) return;

          const openMs = Math.floor(earliestBuyMs / 900_000) * 900_000;
          const closeMs = openMs + 900_000;
          const minTsSec = Math.max(0, Math.floor(earliestBuyMs / 1000) - 2);
          const rawTrades = await fetchPaginatedMarketTrades(ticker, minTsSec);
          const parsedTrades: Array<{ ms: number; yesPrice: number }> = [];
          for (const t of rawTrades) {
            if (!t.created_time) continue;
            const tMs = Date.parse(t.created_time);
            const yP =
              parseDollarsToCents(t.yes_price_dollars) ??
              (typeof t.yes_price === 'number' ? t.yes_price : null);
            if (Number.isFinite(tMs) && yP !== null && yP >= 1 && yP <= 99) {
              parsedTrades.push({ ms: tMs, yesPrice: clampCents(yP) });
            }
          }
          tickerTradesCache.set(ticker, { openMs, closeMs, trades: parsedTrades });
        })
      );
    }

    let updated = false;
    for (const dayRec of Object.values(portfolioState.dailyHistory)) {
      for (const e of dayRec.entries) {
        const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
        const buyRef = e.action === 'buy' ? e : buyByTradeKey.get(key);
        if (!buyRef) continue;
        const buyMs = Date.parse(buyRef.createdAt);
        if (!Number.isFinite(buyMs)) continue;

        const cache = tickerTradesCache.get(e.ticker);
        const openMs = cache?.openMs ?? Math.floor(buyMs / 900_000) * 900_000;
        const closeMs = cache?.closeMs ?? openMs + 900_000;

        let highBid = e.highestBidCents ?? buyRef.highestBidCents ?? buyRef.priceCents;
        let highAt = e.highestBidAt ?? buyRef.highestBidAt ?? buyRef.createdAt;
        const in713AtBuy = buyMs >= openMs + 7 * 60_000 && buyMs <= openMs + 13 * 60_000;
        let lowBid: number | null =
          typeof e.lowestBidCents === 'number'
            ? e.lowestBidCents
            : typeof buyRef.lowestBidCents === 'number'
              ? buyRef.lowestBidCents
              : in713AtBuy
                ? buyRef.priceCents
                : null;
        let lowAt: string | null = e.lowestBidAt ?? buyRef.lowestBidAt ?? null;
        let exactLowMatchAt: string | null = null;

        if (cache && cache.trades.length > 0) {
          for (const tr of cache.trades) {
            if (tr.ms < buyMs || tr.ms > closeMs) continue;
            const sidePrice = e.side === 'yes' ? tr.yesPrice : clampCents(100 - tr.yesPrice);
            if (sidePrice > highBid) {
              highBid = sidePrice;
              highAt = new Date(tr.ms).toISOString();
            }
            const in713 = tr.ms >= openMs + 7 * 60_000 && tr.ms <= openMs + 13 * 60_000;
            if (in713) {
              if (lowBid === null || sidePrice < lowBid) {
                lowBid = sidePrice;
                lowAt = new Date(tr.ms).toISOString();
              } else if (!lowAt && sidePrice === lowBid && !exactLowMatchAt) {
                exactLowMatchAt = new Date(tr.ms).toISOString();
              }
            }
          }
        }

        if (!lowAt && lowBid !== null) {
          lowAt = exactLowMatchAt ?? (in713AtBuy ? buyRef.createdAt : new Date(openMs + 7 * 60_000).toISOString());
        }

        if (
          e.highestBidCents !== highBid ||
          e.highestBidAt !== highAt ||
          e.lowestBidCents !== lowBid ||
          e.lowestBidAt !== lowAt
        ) {
          e.highestBidCents = highBid;
          e.highestBidAt = highAt;
          if (lowBid !== null) e.lowestBidCents = lowBid;
          if (lowAt !== null) e.lowestBidAt = lowAt;
          updated = true;
        }
      }
    }

    if (updated) {
      savePersistedState(portfolioState);
      onUpdated?.();
      console.log('[kalshi-bot] Backfilled Highest Price & Low (7-13m) timestamps for historical entries.');
    }
  } catch (err) {
    console.warn('[kalshi-bot] Backfill high/low failed:', err);
  } finally {
    isBackfillRunning = false;
  }
}

void startServer();
