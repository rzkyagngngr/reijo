import React, { useMemo, useState } from 'react';
import { calcEmaSeries, formatSpotPrice } from '../engine/candleAnalyzer';
import type { CandlePrediction, OhlcCandle } from '../engine/types';

interface CandlestickChartProps {
  candles: OhlcCandle[];
  mode: 'spot' | 'kalshi';
  timeframe?: '5m' | '1m';
  symbol: string;
  targetPrice?: number | null;
  prediction?: CandlePrediction | null;
  height?: number;
}

export const CandlestickChart: React.FC<CandlestickChartProps> = ({
  candles,
  mode,
  timeframe = '1m',
  symbol,
  targetPrice = null,
  prediction = null,
  height = 195,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const visibleCandles = useMemo(() => candles.slice(-36), [candles]);
  const closes = useMemo(() => visibleCandles.map((c) => c.close), [visibleCandles]);
  const ema5 = useMemo(() => calcEmaSeries(closes, 5), [closes]);
  const ema13 = useMemo(() => calcEmaSeries(closes, 13), [closes]);

  if (visibleCandles.length < 2) {
    return (
      <div className="h-[160px] flex items-center justify-center text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded-md">
        Belum ada cukup bar candle {timeframe} untuk ditampilkan pada feed ini.
      </div>
    );
  }

  const width = 540;
  const padLeft = 56;
  const padRight = 38;
  const padTop = 14;
  const padBottom = 22;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const lows = visibleCandles.map((c) => c.low);
  const highs = visibleCandles.map((c) => c.high);

  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);

  // Include targetPrice / predictedPrice in range only if reasonably close (same asset scale)
  let rangeMin = rawMin;
  let rangeMax = rawMax;
  const midRef = (rawMin + rawMax) / 2;
  if (
    mode === 'spot' &&
    typeof targetPrice === 'number' &&
    targetPrice > 0 &&
    midRef > 0 &&
    Math.abs(targetPrice - midRef) / midRef < 0.03
  ) {
    rangeMin = Math.min(rangeMin, targetPrice);
    rangeMax = Math.max(rangeMax, targetPrice);
  }
  if (prediction && prediction.source !== 'kalshi_1m' && prediction.source !== 'kalshi_5m' && mode === 'spot') {
    if (midRef > 0 && Math.abs(prediction.predictedPrice - midRef) / midRef < 0.03) {
      rangeMin = Math.min(rangeMin, prediction.predictedPrice);
      rangeMax = Math.max(rangeMax, prediction.predictedPrice);
    }
  } else if (prediction && mode === 'kalshi') {
    rangeMin = Math.min(rangeMin, prediction.predictedYesCents);
    rangeMax = Math.max(rangeMax, prediction.predictedYesCents);
  }

  const padding = Math.max((rangeMax - rangeMin) * 0.1, mode === 'kalshi' ? 2 : midRef * 0.0005);
  const minVal = mode === 'kalshi' ? Math.max(0, Math.floor(rangeMin - padding)) : rangeMin - padding;
  const maxVal = mode === 'kalshi' ? Math.min(100, Math.ceil(rangeMax + padding)) : rangeMax + padding;
  const span = Math.max(1e-9, maxVal - minVal);

  const toY = (v: number) => padTop + (1 - (v - minVal) / span) * innerH;
  const slotW = innerW / visibleCandles.length;
  const candleW = Math.max(3, Math.min(10, slotW * 0.62));
  const toX = (idx: number) => padLeft + (idx + 0.5) * slotW;

  const ema5Path = ema5
    .map((v, idx) => `${idx === 0 ? 'M' : 'L'} ${toX(idx).toFixed(1)} ${toY(v).toFixed(1)}`)
    .join(' ');
  const ema13Path = ema13
    .map((v, idx) => `${idx === 0 ? 'M' : 'L'} ${toX(idx).toFixed(1)} ${toY(v).toFixed(1)}`)
    .join(' ');

  const activeIdx =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < visibleCandles.length
      ? hoverIdx
      : visibleCandles.length - 1;
  const activeCandle = visibleCandles[activeIdx];

  const formatVal = (v: number) => (mode === 'kalshi' ? `${Math.round(v)}¢` : formatSpotPrice(v, symbol));
  const formatTimeWib = (sec: number) =>
    new Date(sec * 1000).toLocaleTimeString('id-ID', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Jakarta',
    });

  const yTicks = [0, 0.5, 1].map((t) => {
    const val = minVal + (1 - t) * span;
    return { val, y: padTop + t * innerH };
  });

  const showTargetLine =
    mode === 'spot' &&
    typeof targetPrice === 'number' &&
    targetPrice >= minVal &&
    targetPrice <= maxVal;

  const projectedVal =
    prediction && mode === 'kalshi'
      ? prediction.predictedYesCents
      : prediction && mode === 'spot' && prediction.source !== 'kalshi_1m' && prediction.source !== 'kalshi_5m'
        ? prediction.predictedPrice
        : null;
  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const lastX = toX(visibleCandles.length - 1);
  const lastY = toY(lastCandle.close);
  const projX = width - 14;
  const projY = projectedVal !== null ? toY(Math.max(minVal, Math.min(maxVal, projectedVal))) : null;
  const projColor =
    prediction?.direction === 'BULLISH'
      ? '#10B981'
      : prediction?.direction === 'BEARISH'
        ? '#EF4444'
        : '#94A3B8';

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400 mb-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <span className="text-slate-200 font-semibold">{formatTimeWib(activeCandle.timeSec)} WIB</span>
          <span>O {formatVal(activeCandle.open)}</span>
          <span>H {formatVal(activeCandle.high)}</span>
          <span>L {formatVal(activeCandle.low)}</span>
          <span className={activeCandle.close >= activeCandle.open ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
            C {formatVal(activeCandle.close)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-sky-400">EMA5</span>
          <span className="text-amber-400">EMA13</span>
          {showTargetLine && <span className="text-violet-400">Target</span>}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Grafik Candlestick ${timeframe} ${symbol}`}
        className="w-full h-auto overflow-visible select-none bg-slate-950/60 border border-slate-800/80 rounded-md"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padLeft}
              y1={tick.y}
              x2={width - padRight}
              y2={tick.y}
              stroke="#1E293B"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={padLeft - 6}
              y={tick.y + 3.5}
              textAnchor="end"
              className="fill-slate-400 text-[9.5px] font-mono tabular-nums"
            >
              {formatVal(tick.val)}
            </text>
          </g>
        ))}

        {showTargetLine && targetPrice !== null && (
          <g>
            <line
              x1={padLeft}
              y1={toY(targetPrice)}
              x2={width - padRight}
              y2={toY(targetPrice)}
              stroke="#A78BFA"
              strokeWidth="1.2"
              strokeDasharray="4 3"
            />
            <text
              x={padLeft + 4}
              y={toY(targetPrice) - 3}
              className="fill-violet-300 text-[9px] font-mono"
            >
              Target {formatVal(targetPrice)}
            </text>
          </g>
        )}

        {/* EMA overlays */}
        <path d={ema13Path} fill="none" stroke="#F59E0B" strokeWidth="1.3" strokeOpacity="0.85" />
        <path d={ema5Path} fill="none" stroke="#38BDF8" strokeWidth="1.4" strokeOpacity="0.9" />

        {/* Candlesticks */}
        {visibleCandles.map((c, idx) => {
          const x = toX(idx);
          const isUp = c.close >= c.open;
          const color = isUp ? '#10B981' : '#EF4444';
          const yHigh = toY(c.high);
          const yLow = toY(c.low);
          const yOpen = toY(c.open);
          const yClose = toY(c.close);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
          const isHovered = idx === activeIdx;

          return (
            <g key={`${c.timeSec}-${idx}`}>
              {isHovered && (
                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={padTop + innerH}
                  stroke="#334155"
                  strokeWidth="1"
                />
              )}
              <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth="1.2" />
              <rect
                x={x - candleW / 2}
                y={bodyTop}
                width={candleW}
                height={bodyH}
                fill={color}
                fillOpacity={isUp ? 0.9 : 0.92}
                rx="0.5"
              />
              <rect
                x={x - slotW / 2}
                y={padTop}
                width={slotW}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            </g>
          );
        })}

        {/* Predicted next direction projection arrow on right */}
        {projY !== null && prediction && (
          <g>
            <line
              x1={lastX}
              y1={lastY}
              x2={projX}
              y2={projY}
              stroke={projColor}
              strokeWidth="1.8"
              strokeDasharray="3 2"
            />
            <circle cx={projX} cy={projY} r="3.5" fill={projColor} />
            <text
              x={projX - 2}
              y={Math.max(padTop + 9, Math.min(padTop + innerH - 3, projY - 6))}
              textAnchor="end"
              className="text-[9px] font-mono font-semibold"
              fill={projColor}
            >
              {prediction.direction === 'BULLISH' ? '▲' : prediction.direction === 'BEARISH' ? '▼' : '•'}{' '}
              {prediction.confidencePct}%
            </text>
          </g>
        )}

        {/* X-axis first/mid/last timestamps */}
        {[0, Math.floor(visibleCandles.length / 2), visibleCandles.length - 1].map((idx) => (
          <text
            key={idx}
            x={toX(idx)}
            y={height - 6}
            textAnchor="middle"
            className="fill-slate-500 text-[9px] font-mono"
          >
            {formatTimeWib(visibleCandles[idx].timeSec)}
          </text>
        ))}
      </svg>
    </div>
  );
};
