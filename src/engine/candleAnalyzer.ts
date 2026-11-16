import { clampCents } from './kalshiMath.ts';
import type { Candle1mConfirmation, CandlePrediction, OhlcCandle, PredictionDirection } from './types.ts';

/**
 * Parse Kalshi contract target/strike price from yes_sub_title or subtitle,
 * e.g. "Target Price: $68,252.69" -> 68252.69, "Target Price: 1.0542" -> 1.0542.
 */
export function parseKalshiTargetPrice(text: string | undefined | null): number | null {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/target\s*price\s*:\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const normalized = match[1].replace(/,/g, '');
  const val = Number(normalized);
  return Number.isFinite(val) && val > 0 ? val : null;
}

/**
 * Format spot price according to asset price scale (FX 4 decimals, JPY/mid 2-3 decimals, BTC/ETH 2 decimals).
 */
export function formatSpotPrice(price: number, symbol = ''): string {
  if (!Number.isFinite(price)) return '—';
  const upper = symbol.toUpperCase();
  if (upper.includes('JPY')) return price.toFixed(3);
  if (price < 5) return price.toFixed(4);
  if (price < 200) return price.toFixed(2);
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function roundForPriceScale(value: number, referencePrice: number): number {
  if (!Number.isFinite(value)) return referencePrice;
  if (referencePrice < 5) return Number(value.toFixed(5));
  if (referencePrice < 200) return Number(value.toFixed(3));
  return Number(value.toFixed(2));
}

/**
 * Compute Exponential Moving Average series for `values`.
 */
export function calcEmaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const p = Math.max(1, period);
  const k = 2 / (p + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/**
 * Compute Wilder/simple RSI over `period` closes (returns 50 if insufficient history).
 */
export function calcRsi(closes: number[], period = 9): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 95;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

/**
 * Compute Average True Range (ATR) over trailing `period` candles.
 */
export function calcAtr(candles: OhlcCandle[], period = 7): number {
  if (candles.length === 0) return 0;
  if (candles.length === 1) return Math.max(0, candles[0].high - candles[0].low);
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-Math.max(1, period));
  return slice.reduce((acc, v) => acc + v, 0) / slice.length;
}

/**
 * Detect classic price-action candlestick patterns on the most recent 1-3 candles.
 */
export function detectCandlePatterns(candles: OhlcCandle[]): {
  patterns: string[];
  bullishBias: number;
  bearishBias: number;
} {
  if (candles.length === 0) {
    return { patterns: [], bullishBias: 0, bearishBias: 0 };
  }

  const patterns: string[] = [];
  let bullishBias = 0;
  let bearishBias = 0;

  const last = candles[candles.length - 1];
  const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
  const prev2 = candles.length >= 3 ? candles[candles.length - 3] : null;

  const range = Math.max(1e-9, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const isBull = last.close > last.open;
  const isBear = last.close < last.open;

  // Engulfing on last 2 bars
  if (prev) {
    const prevBull = prev.close > prev.open;
    const prevBear = prev.close < prev.open;
    const prevBody = Math.abs(prev.close - prev.open);
    if (
      isBull &&
      prevBear &&
      body > prevBody * 0.9 &&
      last.close >= prev.open &&
      last.open <= prev.close
    ) {
      patterns.push('Bullish Engulfing');
      bullishBias += 22;
    } else if (
      isBear &&
      prevBull &&
      body > prevBody * 0.9 &&
      last.open >= prev.close &&
      last.close <= prev.open
    ) {
      patterns.push('Bearish Engulfing');
      bearishBias += 22;
    }
  }

  // Hammer / Lower Wick Rejection vs Shooting Star / Upper Wick Rejection
  if (lowerWick >= Math.max(body * 1.8, range * 0.48) && upperWick <= range * 0.25) {
    patterns.push('Hammer / Rejection Bawah');
    bullishBias += 16;
  } else if (upperWick >= Math.max(body * 1.8, range * 0.48) && lowerWick <= range * 0.25) {
    patterns.push('Shooting Star / Rejection Atas');
    bearishBias += 16;
  }

  // Strong directional body (Marubozu / Momentum Candle)
  if (body >= range * 0.65 && range > 0) {
    if (isBull) {
      patterns.push('Candle Momentum Bullish');
      bullishBias += 14;
    } else if (isBear) {
      patterns.push('Candle Momentum Bearish');
      bearishBias += 14;
    }
  } else if (body <= range * 0.14 && range > 0) {
    patterns.push('Doji / Konsolidasi');
  }

  // 3 consecutive candles in same direction
  if (prev && prev2) {
    const c1 = prev2.close - prev2.open;
    const c2 = prev.close - prev.open;
    const c3 = last.close - last.open;
    if (c1 > 0 && c2 > 0 && c3 > 0 && last.close > prev.close && prev.close > prev2.close) {
      patterns.push('3 Candle Naik Beruntun');
      bullishBias += 15;
    } else if (c1 < 0 && c2 < 0 && c3 < 0 && last.close < prev.close && prev.close < prev2.close) {
      patterns.push('3 Candle Turun Beruntun');
      bearishBias += 15;
    }
  }

  return { patterns, bullishBias, bearishBias };
}

/**
 * Aggregate 1-minute OHLC candles into 5-minute OHLC candles aligned to 300-second UTC boundaries.
 */
export function aggregateCandlesTo5m(candles1m: OhlcCandle[]): OhlcCandle[] {
  const valid = candles1m
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.timeSec > 0
    )
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec);
  if (valid.length === 0) return [];

  const buckets = new Map<number, OhlcCandle>();
  for (const c of valid) {
    const bucketSec = Math.floor(c.timeSec / 300) * 300;
    const existing = buckets.get(bucketSec);
    if (!existing) {
      buckets.set(bucketSec, {
        timeSec: bucketSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number.isFinite(c.volume) ? c.volume : 0,
      });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += Number.isFinite(c.volume) ? c.volume : 0;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.timeSec - b.timeSec);
}

export interface AnalyzeCandlesInput {
  candles: OhlcCandle[];
  kalshiCandles?: OhlcCandle[];
  candles1m?: OhlcCandle[];
  kalshiCandles1m?: OhlcCandle[];
  symbol: string;
  currentYesCents: number;
  targetPrice?: number | null;
  source?: CandlePrediction['source'];
  timeframe?: '5m' | '1m';
  remainingSec?: number;
}

/**
 * Analyze OHLC candles (5m primary for market direction or 1m for entry confirmation)
 * + indicators + Kalshi target/contract momentum to predict next price direction.
 */
export function analyzeCandlesAndPredict(input: AnalyzeCandlesInput): CandlePrediction | null {
  if (!Array.isArray(input?.candles)) {
    return null;
  }
  const validCandles = input.candles.filter(
    (c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low
  );
  if (validCandles.length < 5) {
    return null;
  }

  const closes = validCandles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];
  const ema5Series = calcEmaSeries(closes, 5);
  const ema13Series = calcEmaSeries(closes, 13);
  const emaFast = ema5Series[ema5Series.length - 1];
  const emaSlow = ema13Series[ema13Series.length - 1];
  const prevEmaFast = ema5Series[Math.max(0, ema5Series.length - 3)];
  const emaSlope = emaFast - prevEmaFast;

  const rsi = calcRsi(closes, 9);
  const atr = calcAtr(validCandles, 7);
  const safeAtr = atr > 0 ? atr : Math.max(Math.abs(currentPrice) * 0.001, 1e-5);

  let bullishScore = 0;
  let bearishScore = 0;
  const indicatorTags: string[] = [];

  // 1. EMA trend + slope
  if (emaFast > emaSlow && emaSlope > 0) {
    bullishScore += 22;
    indicatorTags.push('EMA5 > EMA13');
  } else if (emaFast < emaSlow && emaSlope < 0) {
    bearishScore += 22;
    indicatorTags.push('EMA5 < EMA13');
  } else if (emaFast > emaSlow) {
    bullishScore += 10;
  } else if (emaFast < emaSlow) {
    bearishScore += 10;
  }

  // 2. RSI momentum
  if (rsi >= 58 && rsi <= 78) {
    bullishScore += 14;
    indicatorTags.push(`RSI ${rsi.toFixed(0)} Bullish`);
  } else if (rsi <= 42 && rsi >= 22) {
    bearishScore += 14;
    indicatorTags.push(`RSI ${rsi.toFixed(0)} Bearish`);
  } else if (rsi > 80) {
    // Overbought exhaustion risk
    bearishScore += 8;
    indicatorTags.push(`RSI ${rsi.toFixed(0)} Overbought`);
  } else if (rsi < 20) {
    // Oversold bounce risk
    bullishScore += 8;
    indicatorTags.push(`RSI ${rsi.toFixed(0)} Oversold`);
  }

  // 3. Price-action patterns
  const patternInfo = detectCandlePatterns(validCandles);
  bullishScore += patternInfo.bullishBias;
  bearishScore += patternInfo.bearishBias;

  // 4. Last candle close location inside range & 3-bar drift
  const lastCandle = validCandles[validCandles.length - 1];
  const lastRange = Math.max(1e-9, lastCandle.high - lastCandle.low);
  const closePos = (lastCandle.close - lastCandle.low) / lastRange; // 0=low, 1=high
  if (closePos >= 0.72) bullishScore += 12;
  else if (closePos <= 0.28) bearishScore += 12;

  const base3 = closes[Math.max(0, closes.length - 4)];
  const driftAtr = (currentPrice - base3) / safeAtr;
  if (driftAtr >= 0.45) bullishScore += 12;
  else if (driftAtr <= -0.45) bearishScore += 12;

  // 5. Kalshi target/strike distance (if same scale as spot price, i.e. spot_5m / spot_1m / hybrid)
  const targetPrice = typeof input.targetPrice === 'number' && input.targetPrice > 0 ? input.targetPrice : null;
  const resolvedTf: '5m' | '1m' =
    input.timeframe ?? (input.source === 'spot_1m' || input.source === 'kalshi_1m' ? '1m' : '5m');
  const isKalshiCentSource = input.source === 'kalshi_1m' || input.source === 'kalshi_5m';

  if (targetPrice !== null && !isKalshiCentSource) {
    const ratio = currentPrice / targetPrice;
    if (ratio > 0.7 && ratio < 1.3) {
      const distAtr = (currentPrice - targetPrice) / safeAtr;
      if (distAtr >= 0.4) {
        bullishScore += 12;
        indicatorTags.push(`Di Atas Target`);
      } else if (distAtr <= -0.4) {
        bearishScore += 12;
        indicatorTags.push(`Di Bawah Target`);
      }
    }
  }

  // 6. Optional Kalshi contract candle confirmation when spot is primary
  let usedSource: CandlePrediction['source'] = input.source ?? (resolvedTf === '5m' ? 'spot_5m' : 'spot_1m');
  if (
    input.kalshiCandles &&
    input.kalshiCandles.length >= 3 &&
    (usedSource === 'spot_5m' || usedSource === 'spot_1m')
  ) {
    usedSource = 'hybrid';
    const kc = input.kalshiCandles;
    const kDelta = kc[kc.length - 1].close - kc[Math.max(0, kc.length - 3)].open;
    if (kDelta >= 4) bullishScore += 10;
    else if (kDelta <= -4) bearishScore += 10;
  }

  // 7. Real-time latest candle direction & anti-reversal check
  const prevCandle = validCandles[validCandles.length - 2];
  const lastBodyRatio = Math.abs(lastCandle.close - lastCandle.open) / lastRange;
  const lastCandleDir: PredictionDirection =
    lastCandle.close > lastCandle.open && lastBodyRatio >= 0.16
      ? 'BULLISH'
      : lastCandle.close < lastCandle.open && lastBodyRatio >= 0.16
        ? 'BEARISH'
        : 'NEUTRAL';
  const prevRange = Math.max(1e-9, prevCandle.high - prevCandle.low);
  const prevBodyRatio = Math.abs(prevCandle.close - prevCandle.open) / prevRange;
  const prevCandleDir: PredictionDirection =
    prevCandle.close > prevCandle.open && prevBodyRatio >= 0.16
      ? 'BULLISH'
      : prevCandle.close < prevCandle.open && prevBodyRatio >= 0.16
        ? 'BEARISH'
        : 'NEUTRAL';
  const shortTermDriftPct =
    prevCandle.open > 0
      ? Number((((lastCandle.close - prevCandle.open) / prevCandle.open) * 100).toFixed(4))
      : 0;

  if (emaFast > emaSlow && lastCandleDir === 'BEARISH' && lastCandle.close < prevCandle.open) {
    bullishScore = Math.max(0, bullishScore - 16);
    indicatorTags.push('Reversal Turun Aktif');
  } else if (emaFast < emaSlow && lastCandleDir === 'BULLISH' && lastCandle.close > prevCandle.open) {
    bearishScore = Math.max(0, bearishScore - 16);
    indicatorTags.push('Reversal Naik Aktif');
  }

  const net = bullishScore - bearishScore;
  let direction: PredictionDirection = 'NEUTRAL';
  if (net >= 12) direction = 'BULLISH';
  else if (net <= -12) direction = 'BEARISH';

  const confidencePct =
    direction === 'NEUTRAL'
      ? Math.min(54, Math.max(45, 50 + Math.round(Math.abs(net) * 0.3)))
      : Math.min(96, 54 + Math.round(Math.abs(net) * 0.62));

  const predictedSide = direction === 'BULLISH' ? 'yes' : direction === 'BEARISH' ? 'no' : 'neutral';

  // Project expected move for next bar proportional to directional strength & ATR
  const signedStrength = Math.max(-1, Math.min(1, net / 55));
  const projectedMove = signedStrength * safeAtr * 1.15;
  const isKalshiOutput = usedSource === 'kalshi_1m' || usedSource === 'kalshi_5m';
  const predictedPrice = roundForPriceScale(
    isKalshiOutput ? clampCents(currentPrice + projectedMove) : Math.max(0.0001, currentPrice + projectedMove),
    currentPrice
  );
  const predictedDeltaPct =
    currentPrice > 0 ? Number((((predictedPrice - currentPrice) / currentPrice) * 100).toFixed(3)) : 0;

  // Project Kalshi YES probability cents
  const centsShift =
    direction === 'NEUTRAL'
      ? 0
      : Math.round(signedStrength * Math.max(3, Math.min(14, (confidencePct - 50) * 0.3)));
  const predictedYesCents = clampCents(input.currentYesCents + centsShift);

  const allPatterns = [...patternInfo.patterns, ...indicatorTags].slice(0, 4);
  const dirLabel =
    direction === 'BULLISH'
      ? 'PREDIKSI NAIK (YES)'
      : direction === 'BEARISH'
        ? 'PREDIKSI TURUN (NO)'
        : 'SIDEWAYS / NETRAL';

  const priceFrom = isKalshiOutput ? `${Math.round(currentPrice)}¢` : formatSpotPrice(currentPrice, input.symbol);
  const priceTo = isKalshiOutput ? `${Math.round(predictedPrice)}¢` : formatSpotPrice(predictedPrice, input.symbol);
  const deltaSign = predictedDeltaPct >= 0 ? '+' : '';
  const patternSummary = allPatterns.length > 0 ? allPatterns.slice(0, 2).join(' + ') : `Konsolidasi ${resolvedTf}`;

  const summary =
    direction === 'NEUTRAL'
      ? `${dirLabel} [${resolvedTf}] (${confidencePct}%): ${patternSummary} · proyeksi datar di ${priceFrom} (YES ~${predictedYesCents}¢).`
      : `${dirLabel} [${resolvedTf}] (${confidencePct}%): ${patternSummary} · proyeksi ${priceFrom} → ${priceTo} (${deltaSign}${predictedDeltaPct.toFixed(2)}%, YES ~${predictedYesCents}¢).`;

  const confirm1m =
    resolvedTf === '5m' && input.candles1m && input.candles1m.length >= 5
      ? analyze1mEntryConfirmation({
          candles1m: input.candles1m,
          kalshiCandles1m: input.kalshiCandles1m,
          symbol: input.symbol,
          currentYesCents: input.currentYesCents,
          targetPrice,
          source: isKalshiCentSource ? 'kalshi_1m' : 'spot_1m',
        })
      : undefined;

  return {
    source: usedSource,
    symbol: input.symbol,
    timeframe: resolvedTf,
    currentPrice: roundForPriceScale(currentPrice, currentPrice),
    targetPrice,
    predictedPrice,
    predictedDeltaPct,
    predictedYesCents,
    direction,
    predictedSide,
    confidencePct,
    emaFast: roundForPriceScale(emaFast, currentPrice),
    emaSlow: roundForPriceScale(emaSlow, currentPrice),
    rsi,
    atr: roundForPriceScale(safeAtr, currentPrice),
    bullishScore,
    bearishScore,
    patterns: allPatterns,
    summary,
    candleCount: validCandles.length,
    lastCandleDir,
    prevCandleDir,
    shortTermDriftPct,
    ...(confirm1m ? { confirm1m } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Compute 1-minute entry timing confirmation to filter entries aligned with 5-minute market direction.
 */
export function analyze1mEntryConfirmation(input: {
  candles1m: OhlcCandle[];
  kalshiCandles1m?: OhlcCandle[];
  symbol: string;
  currentYesCents: number;
  targetPrice?: number | null;
  source?: 'spot_1m' | 'kalshi_1m';
}): Candle1mConfirmation | undefined {
  const pred1m = analyzeCandlesAndPredict({
    candles: input.candles1m,
    kalshiCandles: input.kalshiCandles1m,
    symbol: input.symbol,
    currentYesCents: input.currentYesCents,
    targetPrice: input.targetPrice ?? null,
    source: input.source ?? 'spot_1m',
    timeframe: '1m',
  });
  if (!pred1m) return undefined;

  return {
    direction: pred1m.direction,
    lastCandleDir: pred1m.lastCandleDir ?? 'NEUTRAL',
    ...(pred1m.prevCandleDir ? { prevCandleDir: pred1m.prevCandleDir } : {}),
    emaFast: pred1m.emaFast,
    emaSlow: pred1m.emaSlow,
    rsi: pred1m.rsi,
    patterns: pred1m.patterns,
    summary: pred1m.summary,
    candleCount: pred1m.candleCount,
    updatedAt: pred1m.updatedAt,
  };
}

/**
 * Analyze spot/contract candles right before/at 15m market open for Varian B (Pre-Open Spike).
 * Filters out exhausted overbought/oversold traps (RSI > 78 or RSI < 22) and favors fresh EMA/candle momentum + volume uptick.
 */
export function analyzePreOpenSetup(
  candles: OhlcCandle[],
  symbol: string,
  currentYesCents = 50,
  source: CandlePrediction['source'] = 'spot_5m'
): CandlePrediction | null {
  const valid = candles.filter(
    (c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low
  );
  if (valid.length < 5) return null;

  const basePred = analyzeCandlesAndPredict({
    candles: valid,
    symbol,
    currentYesCents,
    targetPrice: null,
    source,
  });
  if (!basePred) return null;

  const last = valid[valid.length - 1];
  const prevVolSlice = valid.slice(Math.max(0, valid.length - 6), valid.length - 1);
  const avgPrevVol =
    prevVolSlice.length > 0
      ? prevVolSlice.reduce((s, c) => s + (c.volume || 0), 0) / prevVolSlice.length
      : 0;
  const volSpike = avgPrevVol > 0 && last.volume >= avgPrevVol * 1.25;

  let bullishScore = basePred.bullishScore;
  let bearishScore = basePred.bearishScore;
  const tags = [...basePred.patterns];

  // Guard against exhausted overbought/oversold mean-reversion traps at market open
  if (basePred.rsi > 78 && basePred.direction === 'BULLISH') {
    bullishScore = Math.max(0, bullishScore - 18);
    tags.unshift(`RSI ${basePred.rsi.toFixed(0)} Jenuh Beli`);
  } else if (basePred.rsi < 22 && basePred.direction === 'BEARISH') {
    bearishScore = Math.max(0, bearishScore - 18);
    tags.unshift(`RSI ${basePred.rsi.toFixed(0)} Jenuh Jual`);
  } else if (volSpike && basePred.direction !== 'NEUTRAL') {
    if (basePred.direction === 'BULLISH') bullishScore += 10;
    else bearishScore += 10;
    tags.unshift('Volume Spike Pre-Open');
  }

  const net = bullishScore - bearishScore;
  let direction: PredictionDirection = 'NEUTRAL';
  if (net >= 12) direction = 'BULLISH';
  else if (net <= -12) direction = 'BEARISH';

  const confidencePct =
    direction === 'NEUTRAL'
      ? Math.min(54, Math.max(45, 50 + Math.round(Math.abs(net) * 0.3)))
      : Math.min(96, 54 + Math.round(Math.abs(net) * 0.62));

  const predictedSide = direction === 'BULLISH' ? 'yes' : direction === 'BEARISH' ? 'no' : 'neutral';
  const dirLabel =
    direction === 'BULLISH'
      ? 'PRE-OPEN NAIK (YES)'
      : direction === 'BEARISH'
        ? 'PRE-OPEN TURUN (NO)'
        : 'PRE-OPEN NETRAL';

  const dedupTags = Array.from(new Set(tags)).slice(0, 4);
  const tagText = dedupTags.slice(0, 2).join(' + ') || 'Konsolidasi 1m';

  return {
    ...basePred,
    direction,
    predictedSide,
    confidencePct,
    bullishScore,
    bearishScore,
    patterns: dedupTags,
    summary: `${dirLabel} (${confidencePct}%): ${tagText} · siap pantau open 5–15 dtk.`,
  };
}

