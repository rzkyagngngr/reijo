import React from 'react';
import { calcPositionPnl } from '../engine/kalshiMath';
import type { KalshiMarket, PortfolioState } from '../engine/types';

interface KpiStripProps {
  portfolio: PortfolioState;
  markets: KalshiMarket[];
}

export const KpiStrip: React.FC<KpiStripProps> = ({ portfolio, markets }) => {
  let positionsValueUsd = 0;
  let unrealizedPnlUsd = 0;

  for (const pos of portfolio.positions) {
    const market = markets.find((m) => m.ticker === pos.ticker);
    const yesBid = market ? market.yesBid : pos.avgEntryCents;
    const noBid = market ? market.noBid : 100 - pos.avgEntryCents;
    const metrics = calcPositionPnl(pos, yesBid, noBid);
    positionsValueUsd += metrics.marketValueUsd;
    unrealizedPnlUsd += metrics.unrealizedPnlUsd;
  }

  const totalEquityUsd = portfolio.cashUsd + positionsValueUsd;
  const totalNetPnlUsd = totalEquityUsd - portfolio.startingCashUsd;
  const totalReturnPct =
    portfolio.startingCashUsd > 0 ? (totalNetPnlUsd / portfolio.startingCashUsd) * 100 : 0;
  const runningBots = portfolio.bots.filter((b) => b.status === 'running').length;
  const botTradesTotal = portfolio.bots.reduce((sum, b) => sum + b.tradesExecuted, 0);
  const recentFilled = portfolio.orders.filter((o) => o.status === 'filled').length;
  const filledOrders = portfolio.totalFilledOrders ?? Math.max(botTradesTotal, recentFilled);

  return (
    <section
      aria-label="Ringkasan Portofolio"
      className="bg-slate-900 border border-slate-800 rounded-lg grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-800"
    >
      <div className="p-4 lg:px-5">
        <div className="text-xs font-medium text-slate-400">Total Ekuitas</div>
        <div className="mt-1.5 flex items-baseline gap-2.5">
          <span className="text-2xl font-semibold tracking-tight text-slate-100 font-mono tabular-nums">
            ${totalEquityUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span
            className={`text-xs font-mono tabular-nums font-medium ${
              totalNetPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {totalNetPnlUsd >= 0 ? '+' : ''}
            {totalReturnPct.toFixed(2)}%
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
          Modal awal ${portfolio.startingCashUsd.toFixed(2)}
        </div>
      </div>

      <div className="p-4 lg:px-5">
        <div className="text-xs font-medium text-slate-400">PnL Terealisasi & Terbuka</div>
        <div className="mt-1.5 flex items-baseline gap-2.5">
          <span
            className={`text-2xl font-semibold tracking-tight font-mono tabular-nums ${
              portfolio.dailyRealizedPnlUsd + unrealizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {portfolio.dailyRealizedPnlUsd + unrealizedPnlUsd >= 0 ? '+' : '-'}$
            {Math.abs(portfolio.dailyRealizedPnlUsd + unrealizedPnlUsd).toFixed(2)}
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
          Realized ${portfolio.dailyRealizedPnlUsd.toFixed(2)} · Open ${unrealizedPnlUsd.toFixed(2)}
        </div>
      </div>

      <div className="p-4 lg:px-5">
        <div className="text-xs font-medium text-slate-400">Kas Tersedia</div>
        <div className="mt-1.5 flex items-baseline gap-2.5">
          <span className="text-2xl font-semibold tracking-tight text-slate-100 font-mono tabular-nums">
            ${portfolio.cashUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
          {portfolio.positions.length} posisi terbuka · ${positionsValueUsd.toFixed(2)} terpakai
        </div>
      </div>

      <div className="p-4 lg:px-5">
        <div className="text-xs font-medium text-slate-400">Bot & Eksekusi</div>
        <div className="mt-1.5 flex items-baseline gap-2.5">
          <span className="text-2xl font-semibold tracking-tight text-slate-100 font-mono tabular-nums">
            {runningBots} / {portfolio.bots.length}
          </span>
          <span className="text-xs font-medium text-slate-400">bot aktif</span>
        </div>
        <div className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
          {filledOrders.toLocaleString('en-US')} order tereksekusi · Mode {portfolio.executionMode === 'live' ? 'Live API' : 'Paper'}
        </div>
      </div>
    </section>
  );
};
