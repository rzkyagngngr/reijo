import React, { useState } from 'react';

interface ProbabilityChartProps {
  values: number[];
  unit?: 'cents' | 'usd';
  height?: number;
  accentColor?: string;
  label?: string;
}

export const ProbabilityChart: React.FC<ProbabilityChartProps> = ({
  values,
  unit = 'cents',
  height = 170,
  accentColor = '#10B981',
  label = 'Grafik Harga',
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const safeValues = values.length > 1 ? values : [values[0] ?? 50, values[0] ?? 50];

  const width = 520;
  const padLeft = 40;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 22;

  const rawMin = Math.min(...safeValues);
  const rawMax = Math.max(...safeValues);
  const minVal = unit === 'cents' ? Math.max(0, Math.floor((rawMin - 4) / 5) * 5) : rawMin * 0.99;
  const maxVal =
    unit === 'cents'
      ? Math.min(100, Math.ceil((rawMax + 4) / 5) * 5 || 100)
      : rawMax * 1.01 || rawMin + 10;
  const span = Math.max(1, maxVal - minVal);

  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const points = safeValues.map((v, i) => {
    const x = padLeft + (i / (safeValues.length - 1)) * innerW;
    const y = padTop + (1 - (v - minVal) / span) * innerH;
    return { x, y, v, i };
  });

  const linePath = points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + innerH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;

  const yTicks = [0, 0.5, 1].map((t) => {
    const val = minVal + (1 - t) * span;
    const y = padTop + t * innerH;
    return { val, y };
  });

  const activePoint = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : points[points.length - 1];

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
        <span>{label}</span>
        <span className="font-mono tabular-nums font-medium text-slate-100">
          {hoverIdx !== null ? `Tick #${activePoint.i + 1}: ` : 'Terakhir: '}
          {unit === 'cents' ? `${activePoint.v.toFixed(0)}¢` : `$${activePoint.v.toFixed(2)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className="w-full h-auto overflow-visible select-none"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={`grad-${unit}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accentColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={accentColor} stopOpacity="0.0" />
          </linearGradient>
        </defs>

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
              className="fill-slate-400 text-[10px] font-mono tabular-nums"
            >
              {unit === 'cents' ? `${Math.round(tick.val)}¢` : `$${Math.round(tick.val)}`}
            </text>
          </g>
        ))}

        <path d={areaPath} fill={`url(#grad-${unit})`} />
        <path d={linePath} fill="none" stroke={accentColor} strokeWidth="2" strokeLinejoin="round" />

        {activePoint && (
          <g>
            <line
              x1={activePoint.x}
              y1={padTop}
              x2={activePoint.x}
              y2={padTop + innerH}
              stroke="#334155"
              strokeWidth="1"
            />
            <circle cx={activePoint.x} cy={activePoint.y} r="3.5" fill="#0F172A" stroke={accentColor} strokeWidth="2" />
          </g>
        )}

        {points.map((p) => (
          <rect
            key={p.i}
            x={p.x - innerW / safeValues.length / 2}
            y={padTop}
            width={Math.max(8, innerW / safeValues.length)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(p.i)}
          />
        ))}
      </svg>
    </div>
  );
};
