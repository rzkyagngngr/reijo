import { aggregateCandlesTo5m, analyzeCandlesAndPredict } from './candleAnalyzer.ts';
import {
  calcContractCost,
  calcKalshiFee,
  calcMaxDrawdownPct,
  calcOrderbookMetrics,
  calcSma,
  clampCents,
  isInsideMinuteWindow,
} from './kalshiMath.ts';
import type {
  BacktestParams,
  BacktestResult,
  BacktestTrade,
  BotConfig,
  BotDecision,
  KalshiMarket,
  OhlcCandle,
  OrderBook,
  OrderSide,
  Position,
  RiskLimits,
} from './types.ts';

export interface EvaluationContext {
  bot: BotConfig;
  market: KalshiMarket;
  orderbook: OrderBook;
  position: Position | undefined;
  allPositions: Position[];
  openOrderCount: number;
  availableCashUsd: number;
  dailyRealizedPnlUsd: number;
  riskLimits: RiskLimits;
  nowMs?: number;
  hasTradedCurrentMarket?: boolean;
}

function noTrade(
  reason: string,
  blockedByRisk = false,
  trailingPatch?: {
    updatedPeakBidCents?: number;
    updatedPeakBidAt?: string;
    updatedLowBidCents?: number;
    updatedLowBidAt?: string;
    trailingActivated?: boolean;
  }
): BotDecision {
  return {
    shouldTrade: false,
    action: 'buy',
    side: 'yes',
    contracts: 0,
    priceCents: 0,
    estimatedFeeUsd: 0,
    blockedByRisk,
    reason,
    ...(trailingPatch ?? {}),
  };
}

export interface RisingPriceCheck {
  ok: boolean;
  reason: string;
  startPrice: number;
  currPrice: number;
  recentPeak: number;
  recentLow: number;
  netClimb: number;
}

export interface RisingPriceExtra {
  sideBid?: number;
  sideAsk?: number;
  sideBidHistory?: number[];
  kalshiLast1mBar?: OhlcCandle;
  nowMs?: number;
}

/**
 * Verify that the candidate contract side ('yes' or 'no') is genuinely rising
 * and NOT a falling knife, tick reversal, dead-cat bounce, or weak-bid ask spike.
 */
export function evaluateRisingPriceMomentum(
  priceHistory: number[],
  currentYesMidCents: number,
  side: OrderSide,
  extra?: RisingPriceExtra
): RisingPriceCheck {
  const yesSeriesRaw = [...priceHistory.map(clampCents), clampCents(currentYesMidCents)];
  const dedupYes: number[] = [];
  for (const p of yesSeriesRaw) {
    if (dedupYes.length === 0 || dedupYes[dedupYes.length - 1] !== p) {
      dedupYes.push(p);
    }
  }

  const sideSeries =
    side === 'yes' ? dedupYes : dedupYes.map((p) => clampCents(100 - p));
  const sideLabel = side.toUpperCase();
  const latestFallback = sideSeries[sideSeries.length - 1] ?? 50;

  if (sideSeries.length < 3) {
    return {
      ok: false,
      reason: `Menunggu konfirmasi harga ${sideLabel} naik (baru ${sideSeries.length}/3 tick gerak).`,
      startPrice: sideSeries[0] ?? latestFallback,
      currPrice: latestFallback,
      recentPeak: latestFallback,
      recentLow: latestFallback,
      netClimb: 0,
    };
  }

  const recent = sideSeries.slice(-6);
  const broader = sideSeries.slice(-16);
  const curr = recent[recent.length - 1];
  const prev1 = recent[recent.length - 2];
  const prev2 = recent[recent.length - 3];
  const start = recent[0];
  const recentPeak = Math.max(...recent);
  const broaderPeak = Math.max(...broader);
  const recentLow = Math.min(...recent);
  const lastDelta = curr - prev1;
  const twoTickDelta = curr - prev2;
  const netClimb = curr - start;

  let upSteps = 0;
  let downSteps = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) upSteps += 1;
    else if (recent[i] < recent[i - 1]) downSteps += 1;
  }

  if (lastDelta < 0) {
    return {
      ok: false,
      reason: `Anti pisau jatuh: harga ${sideLabel} sedang turun (${prev1}¢ → ${curr}¢).`,
      startPrice: start,
      currPrice: curr,
      recentPeak,
      recentLow,
      netClimb,
    };
  }

  if (prev1 < prev2) {
    return {
      ok: false,
      reason: `Anti pisau jatuh: 2 tick terakhir ${sideLabel} belum stabil naik (${prev2}¢ → ${prev1}¢ → ${curr}¢).`,
      startPrice: start,
      currPrice: curr,
      recentPeak,
      recentLow,
      netClimb,
    };
  }

  if (twoTickDelta <= 0) {
    return {
      ok: false,
      reason: `Momentum 2-tick ${sideLabel} belum naik (${prev2}¢ → ${curr}¢) — tahan entry.`,
      startPrice: start,
      currPrice: curr,
      recentPeak,
      recentLow,
      netClimb,
    };
  }

  // Strict zero-pullback rule: never enter if latest price is below recent 6-tick peak
  const peakDrop = recentPeak - curr;
  if (peakDrop > 0) {
    return {
      ok: false,
      reason: `Anti pisau jatuh: harga ${sideLabel} berbalik turun -${peakDrop}¢ dari puncak ${recentPeak}¢ ke ${curr}¢.`,
      startPrice: start,
      currPrice: curr,
      recentPeak,
      recentLow,
      netClimb,
    };
  }

  // Broader 16-tick anti dead-cat bounce guard: prevent buying lower-high rebounds inside a drop
  if (curr < broaderPeak - 1) {
    return {
      ok: false,
      reason: `Anti dead-cat bounce: harga ${sideLabel} (${curr}¢) masih di bawah puncak terakhir ${broaderPeak}¢.`,
      startPrice: start,
      currPrice: curr,
      recentPeak: broaderPeak,
      recentLow,
      netClimb,
    };
  }

  if (netClimb < 2) {
    return {
      ok: false,
      reason: `Harga ${sideLabel} belum membentuk tren naik kuat (${start}¢ → ${curr}¢, butuh >= +2¢).`,
      startPrice: start,
      currPrice: curr,
      recentPeak,
      recentLow,
      netClimb,
    };
  }

  if (upSteps <= downSteps) {
    return {
      ok: false,
      reason: `Struktur harga ${sideLabel} belum stabil naik (${upSteps} naik vs ${downSteps} turun).`,
      startPrice: start,
      currPrice: curr,
      recentPeak,
      recentLow,
      netClimb,
    };
  }

  // Live orderbook Bid/Ask support check
  if (typeof extra?.sideBid === 'number' && typeof extra?.sideAsk === 'number') {
    const spreadSide = extra.sideAsk - extra.sideBid;
    if (spreadSide > 2) {
      return {
        ok: false,
        reason: `Spread ${sideLabel} terlalu lebar (${extra.sideBid}¢/${extra.sideAsk}¢) — rawan entry di pucuk tipis.`,
        startPrice: start,
        currPrice: curr,
        recentPeak,
        recentLow,
        netClimb,
      };
    }
    if (extra.sideBid < curr - 2) {
      return {
        ok: false,
        reason: `Bid ${sideLabel} (${extra.sideBid}¢) tertinggal di bawah mid ${curr}¢ — dukungan beli lemah.`,
        startPrice: start,
        currPrice: curr,
        recentPeak,
        recentLow,
        netClimb,
      };
    }
  }

  // Real-time Bid trajectory check (prevents buying when buyers drop bids while Ask stays/widens)
  if (Array.isArray(extra?.sideBidHistory) && extra.sideBidHistory.length >= 1) {
    const rawBids = [
      ...extra.sideBidHistory.map(clampCents),
      ...(typeof extra.sideBid === 'number' ? [clampCents(extra.sideBid)] : []),
    ];
    const dedupBids: number[] = [];
    for (const b of rawBids) {
      if (dedupBids.length === 0 || dedupBids[dedupBids.length - 1] !== b) {
        dedupBids.push(b);
      }
    }
    if (dedupBids.length >= 2) {
      const currBid = dedupBids[dedupBids.length - 1];
      const prevBid = dedupBids[dedupBids.length - 2];
      const recentBidPeak = Math.max(...dedupBids.slice(-5));
      if (currBid < prevBid) {
        return {
          ok: false,
          reason: `Anti pisau jatuh: Bid ${sideLabel} sedang turun (${prevBid}¢ → ${currBid}¢).`,
          startPrice: start,
          currPrice: curr,
          recentPeak,
          recentLow,
          netClimb,
        };
      }
      if (currBid < recentBidPeak) {
        return {
          ok: false,
          reason: `Anti pisau jatuh: Bid ${sideLabel} turun dari puncak ${recentBidPeak}¢ → ${currBid}¢.`,
          startPrice: start,
          currPrice: curr,
          recentPeak,
          recentLow,
          netClimb,
        };
      }
      if (dedupBids.length >= 3) {
        const baseBid = dedupBids[Math.max(0, dedupBids.length - 5)];
        if (currBid <= baseBid) {
          return {
            ok: false,
            reason: `Bid ${sideLabel} belum naik (${baseBid}¢ → ${currBid}¢) — tunggu tekanan beli naik.`,
            startPrice: start,
            currPrice: curr,
            recentPeak,
            recentLow,
            netClimb,
          };
        }
      }
    }
  }

  // Live Kalshi 1m contract bar check (blocks when the Kalshi contract candle itself is dropping/rejecting)
  if (extra?.kalshiLast1mBar) {
    const bar = extra.kalshiLast1mBar;
    const nowSec = Math.floor((extra.nowMs ?? Date.now()) / 1000);
    if (
      bar.open > 0 &&
      bar.close > 0 &&
      bar.high >= bar.low &&
      Math.abs(nowSec - bar.timeSec) <= 120
    ) {
      const kOpen = side === 'yes' ? clampCents(bar.open) : clampCents(100 - bar.open);
      const kHigh = side === 'yes' ? clampCents(bar.high) : clampCents(100 - bar.low);
      const kClose = side === 'yes' ? clampCents(bar.close) : clampCents(100 - bar.close);
      if (kClose < kOpen - 1) {
        return {
          ok: false,
          reason: `Candle kontrak Kalshi 1m ${sideLabel} sedang turun (${kOpen}→${kClose}¢) — anti entry jatuh.`,
          startPrice: start,
          currPrice: curr,
          recentPeak,
          recentLow,
          netClimb,
        };
      }
      if (kHigh - kClose >= 3) {
        return {
          ok: false,
          reason: `Candle kontrak Kalshi 1m ${sideLabel} menolak puncak (${kHigh}→${kClose}¢) — tahan entry.`,
          startPrice: start,
          currPrice: curr,
          recentPeak,
          recentLow,
          netClimb,
        };
      }
    }
  }

  return {
    ok: true,
    reason: `Harga ${sideLabel} naik ${start}¢→${curr}¢ (+${netClimb}¢, puncak ${recentPeak}¢)`,
    startPrice: start,
    currPrice: curr,
    recentPeak,
    recentLow,
    netClimb,
  };
}

/**
 * Validate bot configuration before saving or running.
 */
export function validateBotConfig(input: Partial<BotConfig>): string | null {
  if (!input.name || input.name.trim().length < 2) {
    return 'Nama bot minimal 2 karakter.';
  }
  if (!input.ticker || input.ticker.trim().length < 3) {
    return 'Ticker market Kalshi wajib dipilih.';
  }
  if (
    input.fairValueCents !== undefined &&
    (!Number.isFinite(input.fairValueCents) || input.fairValueCents < 1 || input.fairValueCents > 99)
  ) {
    return 'Fair value harus antara 1¢ dan 99¢.';
  }
  if (
    input.entryEdgeCents !== undefined &&
    (!Number.isFinite(input.entryEdgeCents) || input.entryEdgeCents < 1 || input.entryEdgeCents > 40)
  ) {
    return 'Entry edge harus antara 1¢ dan 40¢.';
  }
  if (
    input.maxContractsPerOrder !== undefined &&
    (!Number.isFinite(input.maxContractsPerOrder) || input.maxContractsPerOrder < 1)
  ) {
    return 'Jumlah kontrak per order minimal 1.';
  }
  if (
    input.maxPositionContracts !== undefined &&
    input.maxContractsPerOrder !== undefined &&
    input.maxPositionContracts < input.maxContractsPerOrder
  ) {
    return 'Maksimum posisi harus >= kontrak per order.';
  }
  const hasFixedTpTargetA =
    input.strategy === 'trailing_momentum' &&
    typeof input.takeProfitTargetCents === 'number' &&
    input.takeProfitTargetCents >= 50 &&
    input.takeProfitTargetCents <= 99;
  const isHoldSettleGlobal =
    (input.strategy === 'trailing_momentum' && Boolean(input.holdToSettle)) ||
    (input.strategy === 'candle_prediction' && Boolean(input.holdToSettle));
  if (
    !isHoldSettleGlobal &&
    !hasFixedTpTargetA &&
    input.takeProfitCents !== undefined &&
    (!Number.isFinite(input.takeProfitCents) || input.takeProfitCents < 1)
  ) {
    return 'Take profit minimal 1¢.';
  }
  const isNoSl =
    Boolean(input.noStopLoss) ||
    ((input.strategy === 'trailing_momentum' || input.strategy === 'preopen_spike') &&
      (input.stopLossCents === undefined || input.stopLossCents === 0));

  if (
    !isNoSl &&
    input.stopLossCents !== undefined &&
    (!Number.isFinite(input.stopLossCents) || input.stopLossCents < 1)
  ) {
    return 'Stop loss minimal 1¢.';
  }
  if (input.strategy === 'trailing_momentum') {
    const trigger = input.entryTriggerCents ?? 85;
    const maxEntry = input.maxEntryPriceCents ?? 91;
    const isHoldSettle = Boolean(input.holdToSettle);
    const tpTarget = input.takeProfitTargetCents ?? (isHoldSettle ? 0 : 99);
    const tpDelta = input.takeProfitCents ?? (isHoldSettle ? 0 : 15);
    const trailActDelta = input.trailingActivationDeltaCents ?? 3;
    const trailMinProfit = input.trailingMinProfitCents ?? 3;
    const trailDist = input.trailingDistanceCents ?? 2;
    const trailingEnabled = Boolean(input.useTrailingStop);
    if (!Number.isFinite(trigger) || trigger < 50 || trigger > 94) {
      return 'Min Entry Varian A harus antara 50¢ dan 94¢.';
    }
    if (!Number.isFinite(maxEntry) || maxEntry < trigger || maxEntry > 94) {
      return 'Max Entry Varian A harus antara Min Entry dan 94¢ (standar 91¢).';
    }
    if (!isHoldSettle) {
      if (input.takeProfitTargetCents !== undefined && input.takeProfitTargetCents !== 0 && (tpTarget < 50 || tpTarget > 99)) {
        return 'Target Harga TP Varian A harus antara 50¢ dan 99¢.';
      }
      if (!hasFixedTpTargetA && (!Number.isFinite(tpDelta) || tpDelta < 1 || tpDelta > 45)) {
        return 'Target TP Varian A harus antara +1¢ dan +45¢ (standar +10¢).';
      }
      if (trailingEnabled) {
        if (!Number.isFinite(trailActDelta) || trailActDelta < 1 || (tpDelta > 1 && trailActDelta >= tpDelta)) {
          return 'Aktivasi Trailing Varian A harus >= +1¢ dan di bawah Target TP.';
        }
        if (!Number.isFinite(trailMinProfit) || trailMinProfit < 1 || (tpDelta > 1 && trailMinProfit >= tpDelta)) {
          return 'Minimal Jual Trailing Varian A harus >= +1¢ dan di bawah Target TP (standar +3¢).';
        }
        if (!Number.isFinite(trailDist) || trailDist < 1 || trailDist > 15) {
          return 'Jarak Trailing Stop Varian A harus antara 1¢ dan 15¢ (standar -2¢).';
        }
      }
    } else if (!Number.isFinite(tpDelta) || tpDelta < 0 || tpDelta > 45) {
      return 'Target TP tidak valid.';
    }
    if (!isNoSl && input.stopLossCents !== undefined && input.stopLossCents > 90) {
      return 'Stop Loss Varian A maksimal 90¢.';
    }
  }
  if (input.strategy === 'preopen_spike') {
    const tpDelta = input.takeProfitCents ?? 16;
    const slDelta = input.stopLossCents ?? 0;
    const trailActDelta = input.trailingActivationDeltaCents ?? 10;
    const trailDist = input.trailingDistanceCents ?? 2;
    const hardCloseMin = input.hardCloseMinute ?? 6;
    const delayMin = input.entryDelayMinSec ?? 5;
    const delayMax = input.entryDelayMaxSec ?? 15;
    const maxEntry = input.maxEntryPriceCents ?? 65;
    if (!Number.isFinite(tpDelta) || tpDelta < 5 || tpDelta > 45) {
      return 'Target TP Varian B harus antara +5¢ dan +45¢ (rekomendasi +15¢ s/d +18¢).';
    }
    if (!isNoSl && (!Number.isFinite(slDelta) || slDelta < 5 || slDelta > 60)) {
      return 'Stop Loss Varian B harus antara 5¢ dan 60¢ (atau aktifkan Tanpa SL).';
    }
    if (!Number.isFinite(trailActDelta) || trailActDelta < 3 || trailActDelta >= tpDelta) {
      return 'Aktivasi Trailing Varian B harus >= +3¢ dan di bawah Target TP.';
    }
    if (!Number.isFinite(trailDist) || trailDist < 1 || trailDist > 15) {
      return 'Jarak Trailing Stop Varian B harus antara 1¢ dan 15¢ (standar -2¢).';
    }
    if (!Number.isFinite(hardCloseMin) || hardCloseMin < 1 || hardCloseMin > 14) {
      return 'Hard Close Time-Stop Varian B harus antara menit 1 dan 14.';
    }
    if (!Number.isFinite(maxEntry) || maxEntry < 40 || maxEntry > 80) {
      return 'Batas Maks Entry Varian B harus antara 40¢ dan 80¢ (standar 65¢).';
    }
    if (!Number.isFinite(delayMin) || delayMin < 0 || delayMin > 60 || !Number.isFinite(delayMax) || delayMax < delayMin) {
      return 'Jeda aman post-open tidak valid (standar 5–15 detik).';
    }
  }
  if (
    input.minCandleConfidence !== undefined &&
    (!Number.isFinite(input.minCandleConfidence) || input.minCandleConfidence < 50 || input.minCandleConfidence > 95)
  ) {
    return 'Minimum Confidence Candle harus antara 50% dan 95%.';
  }
  return null;
}

/**
 * Pure deterministic strategy & risk guardrail evaluator for one market tick.
 */
export function evaluateBotSignal(ctx: EvaluationContext): BotDecision {
  const { bot, market, orderbook, position, riskLimits, availableCashUsd, dailyRealizedPnlUsd } = ctx;

  if (riskLimits.killSwitchActive) {
    return noTrade('Risk Kill Switch aktif — eksekusi dihentikan.', true);
  }
  if (bot.status === 'halted' || bot.status === 'paused') {
    return noTrade(`Bot berstatus ${bot.status}.`, false);
  }
  if (market.status !== 'active') {
    return noTrade(`Market ${market.ticker} tidak aktif (${market.status}).`, false);
  }
  if (dailyRealizedPnlUsd <= -Math.abs(riskLimits.maxDailyLossUsd)) {
    return noTrade(
      `Batas rugi harian tercapai ($${Math.abs(dailyRealizedPnlUsd).toFixed(2)} >= $${riskLimits.maxDailyLossUsd.toFixed(2)}).`,
      true
    );
  }

  const metrics = calcOrderbookMetrics(orderbook);

  // Check exit conditions first if we already hold a position on this ticker
  if (position && position.contracts > 0) {
    const exitBid = position.side === 'yes' ? metrics.bestYesBid : metrics.bestNoBid;
    const pnlPerContractCents = exitBid - position.avgEntryCents;
    const prevLow = position.lowestBidCents ?? position.avgEntryCents;
    const evalNowMs = ctx.nowMs ?? Date.now();
    const evalNowIso = new Date(evalNowMs).toISOString();
    const inLowWindow = isInsideMinuteWindow(market.closeTime, evalNowMs, 7, 13);
    const newLow = inLowWindow ? Math.min(prevLow, exitBid) : prevLow;
    const newLowAt =
      inLowWindow && (position.lowestBidCents == null || exitBid < prevLow || !position.lowestBidAt)
        ? evalNowIso
        : position.lowestBidAt;

    if (bot.strategy === 'trailing_momentum') {
      const prevPeak = position.peakBidCents ?? position.avgEntryCents;
      const newPeak = Math.max(prevPeak, exitBid);
      const newPeakAt =
        position.peakBidCents == null || exitBid > prevPeak || !position.peakBidAt
          ? evalNowIso
          : position.peakBidAt;
      const isNoSl = Boolean(bot.noStopLoss) || bot.stopLossCents <= 0;
      const fixedTpTarget =
        typeof bot.takeProfitTargetCents === 'number' &&
        bot.takeProfitTargetCents >= 50 &&
        bot.takeProfitTargetCents <= 99
          ? Math.round(bot.takeProfitTargetCents)
          : null;
      const tpDelta = Math.max(1, bot.takeProfitCents || 15);
      const tpTargetPrice = fixedTpTarget ?? Math.min(99, Math.round(position.avgEntryCents) + tpDelta);
      const trailingEnabled = bot.useTrailingStop ?? (fixedTpTarget === null);
      const trailActDelta = Math.max(1, bot.trailingActivationDeltaCents ?? 3);
      const minTrailProfit = Math.max(1, bot.trailingMinProfitCents ?? 3);
      const trailDist = Math.max(1, bot.trailingDistanceCents ?? 2);
      const isTrailingActive =
        trailingEnabled &&
        (Boolean(position.trailingActivated) || newPeak - position.avgEntryCents >= trailActDelta);
      const minTrailSellPrice = clampCents(Math.round(position.avgEntryCents) + minTrailProfit);
      const trailStopLevel = Math.max(minTrailSellPrice, clampCents(Math.round(newPeak) - trailDist));
      const trailArmPrice = clampCents(Math.round(position.avgEntryCents) + trailActDelta);
      const contractsToClose = Math.min(position.contracts, bot.maxContractsPerOrder);

      if (bot.holdToSettle || (fixedTpTarget === null && bot.takeProfitCents <= 0)) {
        if (!isNoSl && pnlPerContractCents <= -bot.stopLossCents) {
          return {
            shouldTrade: true,
            action: 'sell',
            side: position.side,
            contracts: contractsToClose,
            priceCents: exitBid,
            estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
            blockedByRisk: false,
            updatedPeakBidCents: newPeak,
            ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
            updatedLowBidCents: newLow,
            ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
            trailingActivated: isTrailingActive,
            reason: `Hard Stop Loss terpicu: ${position.side.toUpperCase()} bid ${exitBid}¢ vs entry ${position.avgEntryCents}¢ (${pnlPerContractCents}¢).`,
          };
        }
        return noTrade(
          `Hold sampai Settle: ${position.side.toUpperCase()} @ ${exitBid}¢ (Entry ${position.avgEntryCents}¢, Tanpa TP · ${isNoSl ? 'No SL' : `SL ${Math.max(1, Math.round(position.avgEntryCents) - bot.stopLossCents)}¢`}).`,
          false,
          {
            updatedPeakBidCents: newPeak,
            ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
            updatedLowBidCents: newLow,
            ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
            trailingActivated: isTrailingActive,
          }
        );
      }

      // 1. Target TP (fixed 99c ceiling or +tpDelta capped at 99c) takes full profit immediately
      const tpHit =
        fixedTpTarget !== null
          ? exitBid >= tpTargetPrice
          : exitBid >= tpTargetPrice || pnlPerContractCents >= tpDelta;
      if (tpHit) {
        const tpTag =
          fixedTpTarget !== null
            ? `${tpTargetPrice}¢`
            : tpTargetPrice < Math.round(position.avgEntryCents) + tpDelta
              ? `+${tpDelta}¢, cap ${tpTargetPrice}¢`
              : `+${tpDelta}¢`;
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
          reason: `TP Varian A (${tpTag}) tercapai: SELL ${position.side.toUpperCase()} @ ${exitBid}¢ (Entry ${position.avgEntryCents}¢, +${pnlPerContractCents}¢).`,
        };
      }

      // 2. Optional Trailing stop (when enabled) if price fails to reach TP
      if (
        trailingEnabled &&
        isTrailingActive &&
        exitBid < newPeak &&
        exitBid <= trailStopLevel &&
        pnlPerContractCents >= minTrailProfit
      ) {
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: true,
          reason: `Trailing Stop Varian A terpicu @ ${exitBid}¢ (Peak ${newPeak}¢ - ${trailDist}¢, min jual +${minTrailProfit}¢ = ${trailStopLevel}¢, Entry ${position.avgEntryCents}¢, +${pnlPerContractCents}¢).`,
        };
      }

      // 3. Optional SL (disabled by default in No SL mode)
      if (!isNoSl && pnlPerContractCents <= -bot.stopLossCents) {
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
          reason: `Stop Loss terpicu: ${position.side.toUpperCase()} bid ${exitBid}¢ vs entry ${position.avgEntryCents}¢ (${pnlPerContractCents}¢).`,
        };
      }

      const slDisplay = isNoSl ? 'No SL' : `SL ${Math.max(1, Math.round(position.avgEntryCents) - bot.stopLossCents)}¢`;
      return noTrade(
        !trailingEnabled
          ? `Hold Varian A ${position.side.toUpperCase()} @ ${exitBid}¢ (Entry ${position.avgEntryCents}¢) · Target TP ${tpTargetPrice}¢ (atau Settle) · ${slDisplay}.`
          : isTrailingActive
            ? `Hold Varian A ${position.side.toUpperCase()} @ ${exitBid}¢ · Trail AKTIF (Peak ${newPeak}¢, Stop ${trailStopLevel}¢, Min +${minTrailProfit}¢) · TP ${tpTargetPrice}¢ · ${slDisplay}.`
            : `Hold Varian A ${position.side.toUpperCase()} @ ${exitBid}¢ · Trail aktif >= ${trailArmPrice}¢ (+${trailActDelta}¢, Min jual +${minTrailProfit}¢) · TP ${tpTargetPrice}¢ · ${slDisplay}.`,
        false,
        {
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
        }
      );
    }

    if (bot.strategy === 'preopen_spike') {
      const prevPeak = position.peakBidCents ?? position.avgEntryCents;
      const newPeak = Math.max(prevPeak, exitBid);
      const newPeakAt =
        position.peakBidCents == null || exitBid > prevPeak || !position.peakBidAt
          ? evalNowIso
          : position.peakBidAt;
      const trailActDelta = Math.max(1, bot.trailingActivationDeltaCents ?? 10);
      const trailDist = Math.max(1, bot.trailingDistanceCents ?? 2);
      const hardCloseMin = Math.max(1, Math.min(14, bot.hardCloseMinute ?? 6));
      const isNoSl = bot.noStopLoss ?? bot.stopLossCents <= 0;
      const closeMsPos = Date.parse(market.closeTime);
      const openMsPos = closeMsPos - 15 * 60_000;
      const elapsedMsPos = evalNowMs - openMsPos;
      const isTrailingActive =
        Boolean(position.trailingActivated) || newPeak - position.avgEntryCents >= trailActDelta;
      const trailStopLevel = clampCents(Math.round(newPeak) - trailDist);
      const contractsToClose = Math.min(position.contracts, bot.maxContractsPerOrder);

      // 1. Hard close time-stop when passing minute 6 (06:00+)
      if (Number.isFinite(closeMsPos) && elapsedMsPos >= hardCloseMin * 60_000) {
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
          reason: `Hard Close Menit ${hardCloseMin}:00 tercapai: auto close ${position.side.toUpperCase()} @ ${exitBid}¢ (Entry ${position.avgEntryCents}¢, ${pnlPerContractCents >= 0 ? '+' : ''}${pnlPerContractCents}¢).`,
        };
      }

      // 2. Target TP (+15..+18c, default +16c)
      if (pnlPerContractCents >= bot.takeProfitCents) {
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
          reason: `Target TP Varian B (+${bot.takeProfitCents}¢) tercapai: SELL ${position.side.toUpperCase()} @ ${exitBid}¢ (Entry ${position.avgEntryCents}¢, +${pnlPerContractCents}¢).`,
        };
      }

      // 3. Trailing stop (+10c activation, -2c pullback auto-close)
      if (isTrailingActive && exitBid <= trailStopLevel) {
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: true,
          reason: `Trailing Stop Varian B terpicu @ ${exitBid}¢ (Peak ${newPeak}¢ - ${trailDist}¢ = ${trailStopLevel}¢, Entry ${position.avgEntryCents}¢).`,
        };
      }

      // 4. Optional Stop Loss ONLY if explicitly enabled (default Varian B = No SL, rely on Hard Close 6m)
      if (!isNoSl && bot.stopLossCents > 0 && pnlPerContractCents <= -bot.stopLossCents) {
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
          reason: `Stop Loss Varian B (-${bot.stopLossCents}¢) terpicu: SELL ${position.side.toUpperCase()} @ ${exitBid}¢ (Entry ${position.avgEntryCents}¢, ${pnlPerContractCents}¢).`,
        };
      }

      const trailTargetBid = clampCents(Math.round(position.avgEntryCents) + trailActDelta);
      const slLabel = isNoSl ? 'No SL' : `SL ${Math.max(1, Math.round(position.avgEntryCents) - bot.stopLossCents)}¢`;
      return noTrade(
        isTrailingActive
          ? `Hold Varian B ${position.side.toUpperCase()} @ ${exitBid}¢ · Trail AKTIF (Peak ${newPeak}¢, Auto-Close ${trailStopLevel}¢, TP +${bot.takeProfitCents}¢, HC ${hardCloseMin}m).`
          : `Hold Varian B ${position.side.toUpperCase()} @ ${exitBid}¢ · Trail aktif >= ${trailTargetBid}¢ (+${trailActDelta}¢), ${slLabel}, HC ${hardCloseMin}m.`,
        false,
        {
          updatedPeakBidCents: newPeak,
          ...(newPeakAt ? { updatedPeakBidAt: newPeakAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          trailingActivated: isTrailingActive,
        }
      );
    }

    const prevPeakGeneric = position.peakBidCents ?? position.avgEntryCents;
    const newPeakGeneric = Math.max(prevPeakGeneric, exitBid);
    const newPeakGenericAt =
      position.peakBidCents == null || exitBid > prevPeakGeneric || !position.peakBidAt
        ? evalNowIso
        : position.peakBidAt;

    if (bot.strategy === 'candle_prediction' && bot.holdToSettle) {
      const slFloor = Math.max(1, Math.round(position.avgEntryCents) - bot.stopLossCents);
      if (pnlPerContractCents <= -bot.stopLossCents) {
        const contractsToClose = Math.min(position.contracts, bot.maxContractsPerOrder);
        return {
          shouldTrade: true,
          action: 'sell',
          side: position.side,
          contracts: contractsToClose,
          priceCents: exitBid,
          estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
          blockedByRisk: false,
          updatedPeakBidCents: newPeakGeneric,
          ...(newPeakGenericAt ? { updatedPeakBidAt: newPeakGenericAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
          reason: `Hard Stop Loss terpicu: ${position.side.toUpperCase()} bid ${exitBid}¢ vs entry ${position.avgEntryCents}¢ (${pnlPerContractCents}¢).`,
        };
      }
      return noTrade(
        `Hold sampai Fix Settle (Prediksi Candle): ${position.side.toUpperCase()} @ ${exitBid}¢ (SL ${slFloor}¢).`,
        false,
        {
          updatedPeakBidCents: newPeakGeneric,
          ...(newPeakGenericAt ? { updatedPeakBidAt: newPeakGenericAt } : {}),
          updatedLowBidCents: newLow,
          ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
        }
      );
    }

    if (pnlPerContractCents >= bot.takeProfitCents) {
      const contractsToClose = Math.min(position.contracts, bot.maxContractsPerOrder);
      return {
        shouldTrade: true,
        action: 'sell',
        side: position.side,
        contracts: contractsToClose,
        priceCents: exitBid,
        estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
        blockedByRisk: false,
        updatedPeakBidCents: newPeakGeneric,
        ...(newPeakGenericAt ? { updatedPeakBidAt: newPeakGenericAt } : {}),
        updatedLowBidCents: newLow,
        ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
        reason: `Take Profit tercapai: ${position.side.toUpperCase()} bid ${exitBid}¢ vs entry ${position.avgEntryCents}¢ (+${pnlPerContractCents}¢).`,
      };
    }

    if (pnlPerContractCents <= -bot.stopLossCents) {
      const contractsToClose = Math.min(position.contracts, bot.maxContractsPerOrder);
      return {
        shouldTrade: true,
        action: 'sell',
        side: position.side,
        contracts: contractsToClose,
        priceCents: exitBid,
        estimatedFeeUsd: calcKalshiFee(contractsToClose, exitBid),
        blockedByRisk: false,
        updatedPeakBidCents: newPeakGeneric,
        ...(newPeakGenericAt ? { updatedPeakBidAt: newPeakGenericAt } : {}),
        updatedLowBidCents: newLow,
        ...(newLowAt ? { updatedLowBidAt: newLowAt } : {}),
        reason: `Stop Loss terpicu: ${position.side.toUpperCase()} bid ${exitBid}¢ vs entry ${position.avgEntryCents}¢ (${pnlPerContractCents}¢).`,
      };
    }
  }

  if (ctx.openOrderCount >= riskLimits.maxOpenOrders) {
    return noTrade(`Batas maksimum order terbuka tercapai (${riskLimits.maxOpenOrders}).`, true);
  }

  // 1x trade per pair (per 15m contract ticker) guard — exits above still run unconditionally
  if (ctx.hasTradedCurrentMarket) {
    return noTrade(
      'Sudah 1x trade pada kontrak 15m ini (maks 1x/pair) — menunggu kontrak berikutnya.',
      false
    );
  }

  // Entry window guard:
  // - Varian B (preopen_spike): wait 5-15s safe post-open stabilization, allow up to 90s (01:30)
  // - Varian A & standard strategies: allow entries between minutes 7:00 and 13:00
  const closeMs = Date.parse(market.closeTime);
  const currentMs = ctx.nowMs ?? Date.now();
  if (Number.isFinite(closeMs)) {
    const FIFTEEN_MIN_MS = 15 * 60_000;
    const openMs = closeMs - FIFTEEN_MIN_MS;
    const elapsedMs = currentMs - openMs;
    const clampedElapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
    const elMin = String(Math.floor(clampedElapsedSec / 60)).padStart(2, '0');
    const elSec = String(clampedElapsedSec % 60).padStart(2, '0');

    if (bot.strategy === 'preopen_spike') {
      const delayMinSec = Math.max(0, bot.entryDelayMinSec ?? 5);
      const delayMaxSec = Math.max(delayMinSec, bot.entryDelayMaxSec ?? 15);
      const windowEndSec = Math.max(delayMaxSec, bot.entryWindowEndSec ?? 90);
      const winMin = String(Math.floor(windowEndSec / 60)).padStart(2, '0');
      const winSec = String(windowEndSec % 60).padStart(2, '0');

      if (elapsedMs < delayMinSec * 1000) {
        return noTrade(
          `Varian B menunggu jeda aman open 00:${String(delayMinSec).padStart(2, '0')}–00:${String(delayMaxSec).padStart(2, '0')} (berjalan ${elMin}:${elSec}).`,
          false
        );
      }
      if (elapsedMs > windowEndSec * 1000) {
        return noTrade(
          `Lewat jendela entry open Varian B (${winMin}:${winSec}, berjalan ${elMin}:${elSec}) — tunggu kontrak 15m berikutnya.`,
          false
        );
      }
      if (elapsedMs < delayMaxSec * 1000 && metrics.spreadCents > 2) {
        return noTrade(
          `Jeda aman ${delayMinSec}–${delayMaxSec} dtk: spread open masih ${metrics.spreadCents}¢ (> 2¢), menunggu stabilisasi...`,
          false
        );
      }
    } else {
      const ENTRY_START_MS = 7 * 60_000;
      const ENTRY_END_MS = 13 * 60_000;

      if (elapsedMs < ENTRY_START_MS) {
        return noTrade(
          `Menunggu jendela entry menit 07:00–13:00 (berjalan ${elMin}:${elSec}).`,
          false
        );
      }
      if (elapsedMs > ENTRY_END_MS) {
        return noTrade(
          `Lewat batas entry menit 13:00 (berjalan ${elMin}:${elSec}) — tunggu kontrak 15m baru.`,
          false
        );
      }
    }
  }

  // Liquidity guard: ensure real orderbook has bids/asks on at least one side
  if (orderbook.yesBids.length === 0 && orderbook.noBids.length === 0) {
    return noTrade('Orderbook Kalshi kosong — menunggu likuiditas real.', false);
  }

  // Spread guard for non-market-making strategies
  if (bot.strategy !== 'market_maker' && metrics.spreadCents > bot.maxSpreadCents) {
    return noTrade(
      `Spread terlalu lebar (${metrics.spreadCents}¢ > batas ${bot.maxSpreadCents}¢). Menunggu likuiditas.`,
      false
    );
  }

  // Determine entry signal according to strategy
  let entrySide: OrderSide | null = null;
  let entryPriceCents = 0;
  let signalReason = '';

  if (bot.strategy === 'trailing_momentum') {
    const minEntry = clampCents(bot.entryTriggerCents ?? 85);
    const tpDelta = Math.max(1, bot.takeProfitCents || 10);
    const configuredMax = clampCents(bot.maxEntryPriceCents ?? 91);
    const maxEntry = Math.max(minEntry, configuredMax);
    const isNoSl = Boolean(bot.noStopLoss) || bot.stopLossCents <= 0;
    const minConf = Math.max(50, Math.min(95, bot.minCandleConfidence ?? 60));
    const pred = market.candlePrediction;

    if (!pred || pred.candleCount < 5) {
      return noTrade('Varian A menunggu data candle 5m untuk membaca arah market...');
    }
    if (pred.direction === 'NEUTRAL' || pred.confidencePct < minConf) {
      return noTrade(
        `Varian A menunggu arah market 5m jelas: prediksi 5m ${pred.direction} (${pred.confidencePct}% < min ${minConf}%).`
      );
    }

    const wantYes = pred.direction === 'BULLISH' && (bot.targetSide === 'auto' || bot.targetSide === 'yes');
    const wantNo = pred.direction === 'BEARISH' && (bot.targetSide === 'auto' || bot.targetSide === 'no');
    if (!wantYes && !wantNo) {
      return noTrade(
        `Varian A prediksi 5m ${pred.direction} (${pred.confidencePct}%), menunggu arah ${bot.targetSide.toUpperCase()}.`
      );
    }

    const candidateSide: OrderSide = wantYes ? 'yes' : 'no';
    const candidateAsk = candidateSide === 'yes' ? metrics.bestYesAsk : metrics.bestNoAsk;

    if (candidateAsk < minEntry) {
      return noTrade(
        `Arah 5m ${pred.direction} ${pred.confidencePct}% searah ${candidateSide.toUpperCase()}, namun Ask ${candidateAsk}¢ < min entry ${minEntry}¢.`
      );
    }
    if (candidateAsk > maxEntry) {
      return noTrade(
        `Arah 5m ${pred.direction} ${pred.confidencePct}% searah ${candidateSide.toUpperCase()}, namun Ask ${candidateAsk}¢ > maks entry ${maxEntry}¢.`
      );
    }

    // 5m trend EMA guard
    if (candidateSide === 'yes' && pred.emaFast < pred.emaSlow) {
      return noTrade(
        `Tren 5m belum konfirmasi naik (EMA5 ${pred.emaFast} < EMA13 ${pred.emaSlow}) — tunda BUY YES.`
      );
    }
    if (candidateSide === 'no' && pred.emaFast > pred.emaSlow) {
      return noTrade(
        `Tren 5m belum konfirmasi turun (EMA5 ${pred.emaFast} > EMA13 ${pred.emaSlow}) — tunda BUY NO.`
      );
    }
    if (candidateSide === 'yes' && pred.rsi > 78) {
      return noTrade(
        `RSI 5m ${pred.rsi.toFixed(0)} Overbought (>78) — hindari kejar pucuk BUY YES @ ${candidateAsk}¢.`
      );
    }
    if (candidateSide === 'no' && pred.rsi < 22) {
      return noTrade(
        `RSI 5m ${pred.rsi.toFixed(0)} Oversold (<22) — rawan pantulan balik, tunda BUY NO @ ${candidateAsk}¢.`
      );
    }
    if (
      candidateSide === 'yes' &&
      pred.lastCandleDir === 'BEARISH' &&
      pred.patterns.some((p) => p.includes('Bearish') || p.includes('Shooting Star') || p.includes('Reversal Turun'))
    ) {
      return noTrade(`Candle 5m menunjukkan pembalikan turun (${pred.patterns[0]}) — tunda BUY YES.`);
    }
    if (
      candidateSide === 'no' &&
      pred.lastCandleDir === 'BULLISH' &&
      pred.patterns.some((p) => p.includes('Bullish') || p.includes('Hammer') || p.includes('Reversal Naik'))
    ) {
      return noTrade(`Candle 5m menunjukkan pantulan naik (${pred.patterns[0]}) — tunda BUY NO.`);
    }

    // 1m entry confirmation: verify short-term 1m candle aligns with 5m market direction
    if (pred.timeframe === '5m' && !pred.confirm1m) {
      return noTrade('Varian A menunggu konfirmasi candle 1m untuk entry...');
    }
    const c1m = pred.confirm1m ?? pred;

    if (candidateSide === 'yes') {
      if (c1m.lastCandleDir && c1m.lastCandleDir !== 'BULLISH') {
        return noTrade(
          `Konfirmasi 1m terakhir ${c1m.lastCandleDir} (bukan hijau/naik) — tunggu konfirm 1m naik sesuai arah 5m BULLISH.`
        );
      }
      if (c1m.direction === 'BEARISH') {
        return noTrade(
          `Konfirmasi 1m masih BEARISH melawan arah market 5m BULLISH — tunda BUY YES.`
        );
      }
      if (c1m.emaFast < c1m.emaSlow) {
        return noTrade(
          `Konfirmasi 1m EMA5 (${c1m.emaFast}) < EMA13 (${c1m.emaSlow}) — momentum 1m belum konfirmasi naik untuk BUY YES.`
        );
      }
      if (c1m.rsi > 78) {
        return noTrade(
          `RSI 1m ${c1m.rsi.toFixed(0)} Overbought (>78) — hindari kejar pucuk BUY YES @ ${candidateAsk}¢.`
        );
      }
      if (
        c1m.patterns.some(
          (p) =>
            p.includes('Bearish') ||
            p.includes('Shooting Star') ||
            p.includes('Turun Beruntun') ||
            p.includes('Doji') ||
            p.includes('Reversal Turun')
        )
      ) {
        return noTrade(
          `Konfirmasi 1m menunjukkan tekanan turun/konsolidasi (${c1m.patterns[0]}) — tunda BUY YES.`
        );
      }
    } else {
      if (c1m.lastCandleDir && c1m.lastCandleDir !== 'BEARISH') {
        return noTrade(
          `Konfirmasi 1m terakhir ${c1m.lastCandleDir} (bukan merah/turun) — tunggu konfirm 1m turun sesuai arah 5m BEARISH.`
        );
      }
      if (c1m.direction === 'BULLISH') {
        return noTrade(
          `Konfirmasi 1m masih BULLISH melawan arah market 5m BEARISH — tunda BUY NO.`
        );
      }
      if (c1m.emaFast > c1m.emaSlow) {
        return noTrade(
          `Konfirmasi 1m EMA5 (${c1m.emaFast}) > EMA13 (${c1m.emaSlow}) — momentum 1m belum konfirmasi turun untuk BUY NO.`
        );
      }
      if (c1m.rsi < 22) {
        return noTrade(
          `RSI 1m ${c1m.rsi.toFixed(0)} Oversold (<22) — rawan pantulan balik, tunda BUY NO @ ${candidateAsk}¢.`
        );
      }
      if (
        c1m.patterns.some(
          (p) =>
            p.includes('Bullish') ||
            p.includes('Hammer') ||
            p.includes('Naik Beruntun') ||
            p.includes('Doji') ||
            p.includes('Reversal Naik')
        )
      ) {
        return noTrade(
          `Konfirmasi 1m menunjukkan pantulan naik/konsolidasi (${c1m.patterns[0]}) — tunda BUY NO.`
        );
      }
    }

    // Contract price trajectory + live bid + Kalshi 1m candle confirmation: strictly block falling knives
    const candidateBid = candidateSide === 'yes' ? metrics.bestYesBid : metrics.bestNoBid;
    const candidateBidHistory = candidateSide === 'yes' ? market.yesBidHistory : market.noBidHistory;
    const risingCheck = evaluateRisingPriceMomentum(
      market.priceHistory,
      metrics.midPriceCents,
      candidateSide,
      {
        sideBid: candidateBid,
        sideAsk: candidateAsk,
        sideBidHistory: candidateBidHistory,
        kalshiLast1mBar: market.kalshiLast1mBar,
        nowMs: ctx.nowMs,
      }
    );
    if (!risingCheck.ok) {
      return noTrade(risingCheck.reason);
    }

    entrySide = candidateSide;
    entryPriceCents = candidateAsk;
    const patternNote = pred.patterns.slice(0, 2).join(' + ') || 'Tren 5m';
    const fixedTpTarget =
      typeof bot.takeProfitTargetCents === 'number' &&
      bot.takeProfitTargetCents >= 50 &&
      bot.takeProfitTargetCents <= 99
        ? Math.round(bot.takeProfitTargetCents)
        : null;
    const isHoldSettle = Boolean(bot.holdToSettle) || (fixedTpTarget === null && bot.takeProfitCents <= 0);
    const tpTargetPrice = fixedTpTarget ?? Math.min(99, entryPriceCents + tpDelta);
    const trailingEnabled = bot.useTrailingStop ?? (fixedTpTarget === null);
    const trailActDelta = Math.max(1, bot.trailingActivationDeltaCents ?? 3);
    const minTrailProfit = Math.max(1, bot.trailingMinProfitCents ?? 3);
    const trailDist = Math.max(1, bot.trailingDistanceCents ?? 2);
    const exitNote = isHoldSettle
      ? `Tanpa TP · Hold sampai Settle, ${isNoSl ? 'No SL' : `SL -${bot.stopLossCents}¢`}`
      : !trailingEnabled
        ? `TP ${tpTargetPrice}¢ (atau Settle), ${isNoSl ? 'No SL' : `SL -${bot.stopLossCents}¢`}`
        : `TP +${tpDelta}¢ → ${tpTargetPrice}¢, Trail +${trailActDelta}¢/-${trailDist}¢ min +${minTrailProfit}¢, ${isNoSl ? 'No SL' : `SL -${bot.stopLossCents}¢`}`;
    signalReason = `Varian A ${minEntry}–${maxEntry}¢ [${risingCheck.startPrice}→${risingCheck.currPrice}¢ ↑] + Arah 5m ${pred.direction} ${pred.confidencePct}% (${patternNote}) + Konfirm 1m ${c1m.lastCandleDir ?? c1m.direction}: BUY ${candidateSide.toUpperCase()} @ ${candidateAsk}¢ (${exitNote}).`;
  } else if (bot.strategy === 'mean_reversion') {
    const anchor = bot.fairValueCents > 0 ? bot.fairValueCents : calcSma(market.priceHistory, 8);
    const yesEdge = anchor - metrics.bestYesAsk;
    const noEdge = 100 - anchor - metrics.bestNoAsk;

    if (yesEdge >= bot.entryEdgeCents && (bot.targetSide === 'auto' || bot.targetSide === 'yes')) {
      entrySide = 'yes';
      entryPriceCents = metrics.bestYesAsk;
      signalReason = `Mean Reversion BUY YES @ ${entryPriceCents}¢ (Fair ${anchor}¢, Edge +${yesEdge.toFixed(1)}¢).`;
    } else if (noEdge >= bot.entryEdgeCents && (bot.targetSide === 'auto' || bot.targetSide === 'no')) {
      entrySide = 'no';
      entryPriceCents = metrics.bestNoAsk;
      signalReason = `Mean Reversion BUY NO @ ${entryPriceCents}¢ (Fair NO ${(100 - anchor).toFixed(0)}¢, Edge +${noEdge.toFixed(1)}¢).`;
    } else {
      return noTrade(
        `Tidak ada edge cukup: YES ask ${metrics.bestYesAsk}¢ vs Fair ${anchor}¢ (butuh >= ${bot.entryEdgeCents}¢).`
      );
    }
  } else if (bot.strategy === 'orderbook_imbalance') {
    const imbalancePct = Math.round(metrics.imbalanceRatio * 100);
    const thresholdRatio = Math.min(0.85, Math.max(0.15, bot.entryEdgeCents / 25));

    if (
      metrics.imbalanceRatio >= thresholdRatio &&
      (bot.targetSide === 'auto' || bot.targetSide === 'yes')
    ) {
      entrySide = 'yes';
      entryPriceCents = metrics.bestYesAsk;
      signalReason = `Orderbook Imbalance +${imbalancePct}% (YES depth ${metrics.yesDepthTop3} vs NO ${metrics.noDepthTop3}). BUY YES @ ${entryPriceCents}¢.`;
    } else if (
      metrics.imbalanceRatio <= -thresholdRatio &&
      (bot.targetSide === 'auto' || bot.targetSide === 'no')
    ) {
      entrySide = 'no';
      entryPriceCents = metrics.bestNoAsk;
      signalReason = `Orderbook Imbalance ${imbalancePct}% (NO depth ${metrics.noDepthTop3} vs YES ${metrics.yesDepthTop3}). BUY NO @ ${entryPriceCents}¢.`;
    } else {
      return noTrade(
        `Imbalance orderbook netral (${imbalancePct}%, butuh +/-${Math.round(thresholdRatio * 100)}%).`
      );
    }
  } else if (bot.strategy === 'market_maker') {
    if (metrics.spreadCents < Math.max(2, bot.entryEdgeCents)) {
      return noTrade(
        `Spread ${metrics.spreadCents}¢ terlalu sempit untuk market making (min ${Math.max(2, bot.entryEdgeCents)}¢).`
      );
    }
    if (bot.targetSide === 'no' || (bot.targetSide === 'auto' && position?.side === 'yes')) {
      entrySide = 'no';
      entryPriceCents = clampCents(metrics.bestNoBid + 1);
      signalReason = `Market Maker quote NO @ ${entryPriceCents}¢ (Spread ${metrics.spreadCents}¢).`;
    } else {
      entrySide = 'yes';
      entryPriceCents = clampCents(metrics.bestYesBid + 1);
      signalReason = `Market Maker quote YES @ ${entryPriceCents}¢ (Spread ${metrics.spreadCents}¢).`;
    }
  } else if (bot.strategy === 'momentum_breakout') {
    const history = market.priceHistory;
    const prev = history.length >= 4 ? history[history.length - 4] : market.previousPrice;
    const delta = market.lastPrice - prev;

    if (delta >= bot.entryEdgeCents && (bot.targetSide === 'auto' || bot.targetSide === 'yes')) {
      entrySide = 'yes';
      entryPriceCents = metrics.bestYesAsk;
      signalReason = `Momentum Breakout +${delta}¢ (${prev}¢ -> ${market.lastPrice}¢). BUY YES @ ${entryPriceCents}¢.`;
    } else if (delta <= -bot.entryEdgeCents && (bot.targetSide === 'auto' || bot.targetSide === 'no')) {
      entrySide = 'no';
      entryPriceCents = metrics.bestNoAsk;
      signalReason = `Momentum Breakdown ${delta}¢ (${prev}¢ -> ${market.lastPrice}¢). BUY NO @ ${entryPriceCents}¢.`;
    } else {
      return noTrade(`Momentum ${delta >= 0 ? '+' : ''}${delta}¢ belum menembus ambang ${bot.entryEdgeCents}¢.`);
    }
  } else if (bot.strategy === 'candle_prediction') {
    const pred = market.candlePrediction;
    const minConf = Math.max(50, Math.min(95, bot.minCandleConfidence ?? 60));
    if (!pred || pred.candleCount < 5) {
      return noTrade('Menunggu data candle 5m untuk membaca arah harga...');
    }
    if (pred.direction === 'NEUTRAL' || pred.confidencePct < minConf) {
      return noTrade(
        `Candle 5m ${pred.direction} (${pred.confidencePct}% < min ${minConf}%): ${pred.patterns.slice(0, 2).join(', ') || 'Konsolidasi'}.`
      );
    }

    const wantYes = pred.direction === 'BULLISH' && (bot.targetSide === 'auto' || bot.targetSide === 'yes');
    const wantNo = pred.direction === 'BEARISH' && (bot.targetSide === 'auto' || bot.targetSide === 'no');
    if (!wantYes && !wantNo) {
      return noTrade(`Prediksi 5m ${pred.direction} (${pred.confidencePct}%), menunggu arah ${bot.targetSide.toUpperCase()}.`);
    }

    const candidateSide: OrderSide = wantYes ? 'yes' : 'no';
    const candidateAsk = candidateSide === 'yes' ? metrics.bestYesAsk : metrics.bestNoAsk;
    if (candidateAsk < 25 || candidateAsk > 88) {
      return noTrade(
        `Prediksi 5m ${pred.direction} ${pred.confidencePct}%, namun harga ${candidateSide.toUpperCase()} Ask ${candidateAsk}¢ di luar zona wajar (25–88¢).`
      );
    }
    if (pred.timeframe === '5m' && !pred.confirm1m) {
      return noTrade('Menunggu konfirmasi candle 1m untuk entry...');
    }
    const c1m = pred.confirm1m ?? pred;
    const oppositeDir = pred.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    if (c1m.lastCandleDir && c1m.lastCandleDir !== pred.direction) {
      return noTrade(
        `Konfirmasi 1m terakhir ${c1m.lastCandleDir} melawan arah 5m ${pred.direction} — tunda entry.`
      );
    }
    if (c1m.direction === oppositeDir) {
      return noTrade(
        `Konfirmasi 1m ${c1m.direction} berlawanan dengan arah 5m ${pred.direction} — tunda entry.`
      );
    }
    const candidateBidCandle = candidateSide === 'yes' ? metrics.bestYesBid : metrics.bestNoBid;
    const risingCheck = evaluateRisingPriceMomentum(
      market.priceHistory,
      metrics.midPriceCents,
      candidateSide,
      {
        sideBid: candidateBidCandle,
        sideAsk: candidateAsk,
        sideBidHistory: candidateSide === 'yes' ? market.yesBidHistory : market.noBidHistory,
        kalshiLast1mBar: market.kalshiLast1mBar,
        nowMs: ctx.nowMs,
      }
    );
    if (!risingCheck.ok) {
      return noTrade(risingCheck.reason);
    }

    entrySide = candidateSide;
    entryPriceCents = candidateAsk;
    const patternNote = pred.patterns.slice(0, 2).join(' + ') || 'Tren 5m';
    signalReason = `Baca Candle 5m ${pred.direction} ${pred.confidencePct}% (${patternNote}) + Konfirm 1m ${c1m.lastCandleDir ?? c1m.direction} [${risingCheck.startPrice}→${risingCheck.currPrice}¢ ↑]: BUY ${candidateSide.toUpperCase()} @ ${candidateAsk}¢ → proyeksi YES ~${pred.predictedYesCents}¢.`;
  } else if (bot.strategy === 'preopen_spike') {
    const pred = market.preOpenPrediction ?? market.candlePrediction;
    const minConf = Math.max(50, Math.min(95, bot.minCandleConfidence ?? 58));
    if (!pred || pred.candleCount < 5) {
      return noTrade('Varian B menunggu data candle 1m pre-open untuk memprediksi arah...');
    }
    if (pred.direction === 'NEUTRAL' || pred.confidencePct < minConf) {
      return noTrade(
        `Pre-Open ${pred.direction} (${pred.confidencePct}% < min ${minConf}%): ${pred.patterns.slice(0, 2).join(', ') || 'Konsolidasi'}.`
      );
    }

    const wantYes = pred.direction === 'BULLISH' && (bot.targetSide === 'auto' || bot.targetSide === 'yes');
    const wantNo = pred.direction === 'BEARISH' && (bot.targetSide === 'auto' || bot.targetSide === 'no');
    if (!wantYes && !wantNo) {
      return noTrade(`Pre-Open ${pred.direction} (${pred.confidencePct}%), menunggu arah ${bot.targetSide.toUpperCase()}.`);
    }

    // Post-open sharp reversal safeguard if live candlePrediction contradicts locked preOpenPrediction strongly
    if (
      market.preOpenPrediction &&
      market.candlePrediction &&
      market.candlePrediction.direction !== 'NEUTRAL' &&
      market.candlePrediction.direction !== pred.direction &&
      market.candlePrediction.confidencePct >= 68
    ) {
      return noTrade(
        `Diblokir konfirmasi post-open: candle 1m berbalik ${market.candlePrediction.direction} (${market.candlePrediction.confidencePct}%) melawan bias pre-open ${pred.direction}.`
      );
    }

    const candidateSide: OrderSide = wantYes ? 'yes' : 'no';
    const candidateAsk = candidateSide === 'yes' ? metrics.bestYesAsk : metrics.bestNoAsk;
    const maxEntryCents = Math.max(40, Math.min(80, bot.maxEntryPriceCents ?? 65));
    const isNoSl = bot.noStopLoss ?? bot.stopLossCents <= 0;
    if (candidateAsk < 35 || candidateAsk > maxEntryCents) {
      return noTrade(
        `Pre-Open ${pred.direction} ${pred.confidencePct}%, namun harga ${candidateSide.toUpperCase()} Ask ${candidateAsk}¢ di luar zona entry open (35–${maxEntryCents}¢).`
      );
    }

    entrySide = candidateSide;
    entryPriceCents = candidateAsk;
    const patternNote = pred.patterns.slice(0, 2).join(' + ') || 'Pre-Open 1m';
    const slTag = isNoSl ? 'No SL' : `SL -${bot.stopLossCents}¢`;
    signalReason = `Varian B Pre-Open ${pred.direction} ${pred.confidencePct}% (${patternNote}): BUY ${candidateSide.toUpperCase()} @ ${candidateAsk}¢ (Max ${maxEntryCents}¢, TP +${bot.takeProfitCents}¢, Trail +${bot.trailingActivationDeltaCents ?? 10}¢/-${bot.trailingDistanceCents ?? 2}¢, ${slTag}, HC ${bot.hardCloseMinute ?? 6}m).`;
  }

  if (!entrySide) {
    return noTrade('Tidak ada sinyal valid.');
  }

  // Optional candle-reading anti-reversal filter for legacy non-candle strategies
  if (
    bot.strategy !== 'candle_prediction' &&
    bot.strategy !== 'preopen_spike' &&
    bot.strategy !== 'trailing_momentum' &&
    bot.useCandleFilter &&
    market.candlePrediction
  ) {
    const pred = market.candlePrediction;
    const guardThreshold = Math.max(55, Math.min(95, bot.minCandleConfidence ?? 62));
    if (
      pred.predictedSide !== 'neutral' &&
      pred.predictedSide !== entrySide &&
      pred.confidencePct >= guardThreshold
    ) {
      return noTrade(
        `Diblokir Baca Candle: prediksi ${pred.direction} ${pred.confidencePct}% (${pred.patterns[0] ?? 'Momentum'}) melawan BUY ${entrySide.toUpperCase()} @ ${entryPriceCents}¢.`
      );
    }
    if (pred.predictedSide === entrySide) {
      signalReason += ` [Candle ${pred.direction} ${pred.confidencePct}% searah]`;
    }
  }

  // Position limit check
  const currentContractsSameMarket = position ? position.contracts : 0;
  if (position && position.side === entrySide && currentContractsSameMarket >= bot.maxPositionContracts) {
    return noTrade(
      `Posisi maksimal tercapai (${currentContractsSameMarket}/${bot.maxPositionContracts} kontrak).`,
      true
    );
  }

  const remainingAllowed =
    position && position.side === entrySide
      ? Math.max(0, bot.maxPositionContracts - currentContractsSameMarket)
      : bot.maxPositionContracts;

  const contracts = Math.min(bot.maxContractsPerOrder, remainingAllowed);
  if (contracts <= 0) {
    return noTrade('Kuota posisi penuh.', true);
  }

  const orderCostUsd = calcContractCost(contracts, entryPriceCents);
  const feeUsd = calcKalshiFee(contracts, entryPriceCents);
  const totalNeededUsd = Number((orderCostUsd + feeUsd).toFixed(2));

  // Market exposure guardrail
  const currentMarketExposureUsd =
    position ? calcContractCost(position.contracts, position.avgEntryCents) : 0;
  if (currentMarketExposureUsd + orderCostUsd > riskLimits.maxExposurePerMarketUsd) {
    return noTrade(
      `Eksposur market melebihi batas ($${(currentMarketExposureUsd + orderCostUsd).toFixed(2)} > $${riskLimits.maxExposurePerMarketUsd.toFixed(2)}).`,
      true
    );
  }

  // Cash check
  if (availableCashUsd < totalNeededUsd) {
    return noTrade(
      `Saldo tunai tidak cukup ($${availableCashUsd.toFixed(2)} < butuh $${totalNeededUsd.toFixed(2)}).`,
      true
    );
  }

  return {
    shouldTrade: true,
    action: 'buy',
    side: entrySide,
    contracts,
    priceCents: entryPriceCents,
    estimatedFeeUsd: feeUsd,
    blockedByRisk: false,
    reason: signalReason,
  };
}

/**
 * Deterministic historical/synthetic tick backtester for Kalshi binary strategies.
 */
export function runBacktest(params: BacktestParams, priceSeries: number[]): BacktestResult {
  const series = priceSeries.length > 0 ? priceSeries.map(clampCents) : [50];
  let cash = params.initialCapitalUsd;
  let openSide: OrderSide | null = null;
  let openContracts = 0;
  let openAvgPrice = 0;
  let openPeakPrice = 0;
  let openEntryTick = -1;
  let openEntryFee = 0;
  let trailingActive = false;
  let totalFeesUsd = 0;
  let wins = 0;
  let closedTrades = 0;

  const trigger = clampCents(params.entryTriggerCents ?? 85);
  const trailDist = Math.max(1, params.trailingDistanceCents ?? 2);
  const trailActDelta = Math.max(1, params.trailingActivationDeltaCents ?? 10);
  const hardCloseBars = Math.max(2, (params.hardCloseMinute ?? 6) * 2);

  const equityCurve: number[] = [];
  const trades: BacktestTrade[] = [];

  for (let i = 0; i < series.length; i++) {
    const yesPrice = series[i];
    const noPrice = clampCents(100 - yesPrice);
    const sma = calcSma(series.slice(0, i + 1), 6);

    // Check exit first
    if (openSide && openContracts > 0) {
      const currentMark = openSide === 'yes' ? yesPrice : noPrice;
      const diffCents = currentMark - openAvgPrice;
      let shouldExit = false;
      let reason = '';

      if (params.strategy === 'preopen_spike') {
        openPeakPrice = Math.max(openPeakPrice, currentMark);
        if (openPeakPrice - openAvgPrice >= trailActDelta) {
          trailingActive = true;
        }
        const trailStopLevel = clampCents(openPeakPrice - trailDist);
        const heldBars = i - openEntryTick;
        const isNoSl = params.noStopLoss ?? params.stopLossCents <= 0;

        if (heldBars >= hardCloseBars) {
          shouldExit = true;
          reason = `Hard Close Menit ${params.hardCloseMinute ?? 6}:00 (${diffCents >= 0 ? '+' : ''}${diffCents}¢)`;
        } else if (diffCents >= params.takeProfitCents) {
          shouldExit = true;
          reason = `Target TP Varian B (+${diffCents}¢)`;
        } else if (trailingActive && currentMark <= trailStopLevel) {
          shouldExit = true;
          reason = `Trailing Stop Varian B @ ${currentMark}¢ (Peak ${openPeakPrice}¢ - ${trailDist}¢)`;
        } else if (!isNoSl && params.stopLossCents > 0 && diffCents <= -params.stopLossCents) {
          shouldExit = true;
          reason = `Stop Loss Varian B (${diffCents}¢)`;
        } else if (i === series.length - 1) {
          shouldExit = true;
          reason = 'Tutup posisi akhir periode backtest';
        }
      } else if (params.strategy === 'candle_prediction' && params.holdToSettle) {
        if (diffCents <= -params.stopLossCents) {
          shouldExit = true;
          reason = `Hard Stop Loss (${diffCents}¢)`;
        } else if (i === series.length - 1) {
          shouldExit = true;
          reason = 'Tutup posisi akhir periode backtest';
        }
      } else if (params.strategy === 'trailing_momentum') {
        openPeakPrice = Math.max(openPeakPrice, currentMark);
        const isNoSl = Boolean(params.noStopLoss) || params.stopLossCents <= 0;
        const fixedTpTarget =
          typeof params.takeProfitTargetCents === 'number' &&
          params.takeProfitTargetCents >= 50 &&
          params.takeProfitTargetCents <= 99
            ? Math.round(params.takeProfitTargetCents)
            : null;
        const isHoldSettle =
          Boolean(params.holdToSettle) || (fixedTpTarget === null && params.takeProfitCents <= 0);
        const tpDelta = Math.max(1, params.takeProfitCents || 15);
        const trailingEnabled = params.useTrailingStop ?? (fixedTpTarget === null);
        const minTrailProfit = Math.max(1, params.trailingMinProfitCents ?? 3);
        const trailArmDelta = Math.max(
          1,
          params.trailingActivationDeltaCents ?? (params.strategy === 'trailing_momentum' ? 3 : 10)
        );
        if (trailingEnabled && openPeakPrice - openAvgPrice >= trailArmDelta) {
          trailingActive = true;
        }
        const trailStopLevel = Math.max(
          clampCents(Math.round(openAvgPrice) + minTrailProfit),
          clampCents(Math.round(openPeakPrice) - trailDist)
        );

        const tpTargetPrice = fixedTpTarget ?? Math.min(99, Math.round(openAvgPrice) + tpDelta);
        const tpHitBt =
          fixedTpTarget !== null
            ? currentMark >= tpTargetPrice
            : currentMark >= tpTargetPrice || diffCents >= tpDelta;

        if (isHoldSettle) {
          if (!isNoSl && params.stopLossCents > 0 && diffCents <= -params.stopLossCents) {
            shouldExit = true;
            reason = `Stop Loss (${diffCents}¢)`;
          } else if (i === series.length - 1) {
            shouldExit = true;
            reason = `Hold sampai Settle / Akhir Backtest (${diffCents >= 0 ? '+' : ''}${diffCents}¢)`;
          }
        } else if (tpHitBt) {
          shouldExit = true;
          reason =
            fixedTpTarget !== null
              ? `TP Varian A (${tpTargetPrice}¢, +${diffCents}¢)`
              : `TP Varian A (+${diffCents}¢, target ${tpTargetPrice}¢)`;
        } else if (
          trailingEnabled &&
          trailingActive &&
          currentMark < openPeakPrice &&
          currentMark <= trailStopLevel &&
          diffCents >= minTrailProfit
        ) {
          shouldExit = true;
          reason = `Trailing Stop Varian A @ ${currentMark}¢ (Peak ${openPeakPrice}¢ - ${trailDist}¢, min +${minTrailProfit}¢ = +${diffCents}¢)`;
        } else if (!isNoSl && params.stopLossCents > 0 && diffCents <= -params.stopLossCents) {
          shouldExit = true;
          reason = `Stop Loss (${diffCents}¢)`;
        } else if (i === series.length - 1) {
          shouldExit = true;
          reason = 'Tutup posisi akhir periode backtest';
        }
      } else {
        shouldExit =
          diffCents >= params.takeProfitCents ||
          diffCents <= -params.stopLossCents ||
          i === series.length - 1;
        reason =
          i === series.length - 1
            ? 'Tutup posisi akhir periode backtest'
            : diffCents >= params.takeProfitCents
              ? `Take Profit (+${diffCents}¢)`
              : `Stop Loss (${diffCents}¢)`;
      }

      if (shouldExit) {
        const grossProceeds = calcContractCost(openContracts, currentMark);
        const exitFee = calcKalshiFee(openContracts, currentMark);
        const costBasis = calcContractCost(openContracts, openAvgPrice);
        const tradePnl = Number((grossProceeds - costBasis - exitFee - openEntryFee).toFixed(2));
        cash = Number((cash + grossProceeds - exitFee).toFixed(2));
        totalFeesUsd = Number((totalFeesUsd + exitFee).toFixed(2));
        closedTrades += 1;
        if (tradePnl > 0) wins += 1;

        trades.push({
          tickIndex: i,
          side: openSide,
          action: 'sell',
          priceCents: currentMark,
          contracts: openContracts,
          feeUsd: exitFee,
          pnlUsd: tradePnl,
          equityUsd: cash,
          reason,
        });

        openSide = null;
        openContracts = 0;
        openAvgPrice = 0;
        openPeakPrice = 0;
        openEntryTick = -1;
        openEntryFee = 0;
        trailingActive = false;
      }
    } else if (i < series.length - 1) {
      // Entry logic
      let enterSide: OrderSide | null = null;
      let enterPrice = 0;
      let reason = '';

      if (params.strategy === 'trailing_momentum' && i >= 10) {
        const rollingCandles: OhlcCandle[] = [];
        for (let k = Math.max(0, i - 24); k <= i - 1; k += 2) {
          const chunk = series.slice(k, Math.min(i + 1, k + 2));
          rollingCandles.push({
            timeSec: 1700000000 + k * 60,
            open: chunk[0],
            high: Math.max(...chunk),
            low: Math.min(...chunk),
            close: chunk[chunk.length - 1],
            volume: 100,
          });
        }
        const rolling5m = aggregateCandlesTo5m(rollingCandles);
        const use5m = rolling5m.length >= 5;
        const pred = analyzeCandlesAndPredict({
          candles: use5m ? rolling5m : rollingCandles,
          ...(use5m ? { candles1m: rollingCandles } : {}),
          symbol: params.ticker,
          currentYesCents: yesPrice,
          source: use5m ? 'kalshi_5m' : 'kalshi_1m',
          timeframe: use5m ? '5m' : '1m',
        });
        const c1m = pred?.confirm1m ?? pred;
        const minConf = Math.max(50, Math.min(95, params.minCandleConfidence ?? 60));
        const minEntry = clampCents(trigger);
        const configuredMax = clampCents(params.maxEntryPriceCents ?? 91);
        const maxEntry = Math.max(minEntry, configuredMax);
        const btHist = series.slice(Math.max(0, i - 10), i + 1);

        if (
          pred &&
          pred.direction === 'BULLISH' &&
          pred.confidencePct >= minConf &&
          c1m &&
          (!c1m.lastCandleDir || c1m.lastCandleDir === 'BULLISH') &&
          c1m.direction !== 'BEARISH' &&
          c1m.rsi <= 78 &&
          yesPrice >= minEntry &&
          yesPrice <= maxEntry &&
          evaluateRisingPriceMomentum(btHist, yesPrice, 'yes').ok
        ) {
          enterSide = 'yes';
          enterPrice = yesPrice;
          reason = `Varian A ${minEntry}–${maxEntry}¢ (Naik) + Candle ${use5m ? '5m+1m' : '1m'} BULLISH ${pred.confidencePct}% BUY YES @ ${yesPrice}¢`;
        } else if (
          pred &&
          pred.direction === 'BEARISH' &&
          pred.confidencePct >= minConf &&
          c1m &&
          (!c1m.lastCandleDir || c1m.lastCandleDir === 'BEARISH') &&
          c1m.direction !== 'BULLISH' &&
          c1m.rsi >= 22 &&
          noPrice >= minEntry &&
          noPrice <= maxEntry &&
          evaluateRisingPriceMomentum(btHist, yesPrice, 'no').ok
        ) {
          enterSide = 'no';
          enterPrice = noPrice;
          reason = `Varian A ${minEntry}–${maxEntry}¢ (Naik) + Candle ${use5m ? '5m+1m' : '1m'} BEARISH ${pred.confidencePct}% BUY NO @ ${noPrice}¢`;
        }
      } else if (params.strategy === 'mean_reversion') {
        const anchor = params.fairValueCents > 0 ? params.fairValueCents : sma;
        if (anchor - yesPrice >= params.entryEdgeCents) {
          enterSide = 'yes';
          enterPrice = yesPrice;
          reason = `Mean Reversion BUY YES @ ${yesPrice}¢ (Fair ${anchor}¢)`;
        } else if (yesPrice - anchor >= params.entryEdgeCents) {
          enterSide = 'no';
          enterPrice = noPrice;
          reason = `Mean Reversion BUY NO @ ${noPrice}¢ (Fair YES ${anchor}¢)`;
        }
      } else if (params.strategy === 'momentum_breakout') {
        const prev = i >= 3 ? series[i - 3] : series[0];
        const delta = yesPrice - prev;
        if (delta >= params.entryEdgeCents) {
          enterSide = 'yes';
          enterPrice = yesPrice;
          reason = `Momentum Breakout +${delta}¢ BUY YES @ ${yesPrice}¢`;
        } else if (delta <= -params.entryEdgeCents) {
          enterSide = 'no';
          enterPrice = noPrice;
          reason = `Momentum Breakdown ${delta}¢ BUY NO @ ${noPrice}¢`;
        }
      } else if (params.strategy === 'orderbook_imbalance') {
        const deltaFromSma = yesPrice - sma;
        if (deltaFromSma >= Math.max(2, Math.floor(params.entryEdgeCents / 2))) {
          enterSide = 'yes';
          enterPrice = yesPrice;
          reason = `Flow Imbalance BUY YES @ ${yesPrice}¢`;
        } else if (deltaFromSma <= -Math.max(2, Math.floor(params.entryEdgeCents / 2))) {
          enterSide = 'no';
          enterPrice = noPrice;
          reason = `Flow Imbalance BUY NO @ ${noPrice}¢`;
        }
      } else if (params.strategy === 'market_maker') {
        if (sma - yesPrice >= Math.max(2, Math.floor(params.entryEdgeCents / 2))) {
          enterSide = 'yes';
          enterPrice = yesPrice;
          reason = `MM Passive Fill YES @ ${yesPrice}¢ (SMA ${sma}¢)`;
        } else if (yesPrice - sma >= Math.max(2, Math.floor(params.entryEdgeCents / 2))) {
          enterSide = 'no';
          enterPrice = noPrice;
          reason = `MM Passive Fill NO @ ${noPrice}¢ (SMA ${sma}¢)`;
        }
      } else if ((params.strategy === 'candle_prediction' || params.strategy === 'preopen_spike') && i >= 14) {
        const rollingCandles: OhlcCandle[] = [];
        for (let k = Math.max(0, i - 29); k <= i - 2; k += 3) {
          const chunk = series.slice(k, Math.min(i + 1, k + 3));
          rollingCandles.push({
            timeSec: 1700000000 + k * 60,
            open: chunk[0],
            high: Math.max(...chunk),
            low: Math.min(...chunk),
            close: chunk[chunk.length - 1],
            volume: 100,
          });
        }
        const pred = analyzeCandlesAndPredict({
          candles: rollingCandles,
          symbol: params.ticker,
          currentYesCents: yesPrice,
          source: 'kalshi_1m',
        });
        const minConf = Math.max(50, Math.min(95, params.minCandleConfidence ?? (params.strategy === 'preopen_spike' ? 58 : 60)));
        const minAsk = params.strategy === 'preopen_spike' ? 35 : 25;
        const maxAsk = params.strategy === 'preopen_spike' ? Math.max(40, Math.min(80, params.maxEntryPriceCents ?? 65)) : 88;
        if (pred && pred.direction === 'BULLISH' && pred.confidencePct >= minConf && yesPrice >= minAsk && yesPrice <= maxAsk) {
          enterSide = 'yes';
          enterPrice = yesPrice;
          reason =
            params.strategy === 'preopen_spike'
              ? `Varian B Pre-Open BULLISH ${pred.confidencePct}% BUY YES @ ${yesPrice}¢`
              : `Prediksi Candle BULLISH ${pred.confidencePct}% BUY YES @ ${yesPrice}¢`;
        } else if (pred && pred.direction === 'BEARISH' && pred.confidencePct >= minConf && noPrice >= minAsk && noPrice <= maxAsk) {
          enterSide = 'no';
          enterPrice = noPrice;
          reason =
            params.strategy === 'preopen_spike'
              ? `Varian B Pre-Open BEARISH ${pred.confidencePct}% BUY NO @ ${noPrice}¢`
              : `Prediksi Candle BEARISH ${pred.confidencePct}% BUY NO @ ${noPrice}¢`;
        }
      }

      if (enterSide) {
        const cost = calcContractCost(params.contractsPerTrade, enterPrice);
        const fee = calcKalshiFee(params.contractsPerTrade, enterPrice);
        if (cash >= cost + fee) {
          cash = Number((cash - cost - fee).toFixed(2));
          totalFeesUsd = Number((totalFeesUsd + fee).toFixed(2));
          openSide = enterSide;
          openContracts = params.contractsPerTrade;
          openAvgPrice = enterPrice;
          openPeakPrice = enterPrice;
          openEntryTick = i;
          openEntryFee = fee;
          trailingActive = false;

          trades.push({
            tickIndex: i,
            side: enterSide,
            action: 'buy',
            priceCents: enterPrice,
            contracts: params.contractsPerTrade,
            feeUsd: fee,
            pnlUsd: 0,
            equityUsd: Number((cash + cost).toFixed(2)),
            reason,
          });
        }
      }
    }

    const markValue =
      openSide && openContracts > 0
        ? calcContractCost(openContracts, openSide === 'yes' ? yesPrice : noPrice)
        : 0;
    equityCurve.push(Number((cash + markValue).toFixed(2)));
  }

  const finalEquityUsd = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1] : params.initialCapitalUsd;
  const totalReturnPct =
    params.initialCapitalUsd > 0
      ? Number((((finalEquityUsd - params.initialCapitalUsd) / params.initialCapitalUsd) * 100).toFixed(2))
      : 0;

  return {
    finalEquityUsd,
    totalReturnPct,
    maxDrawdownPct: calcMaxDrawdownPct(equityCurve),
    totalTrades: closedTrades,
    winRatePct: closedTrades > 0 ? Number(((wins / closedTrades) * 100).toFixed(1)) : 0,
    totalFeesUsd,
    equityCurve,
    trades,
  };
}
