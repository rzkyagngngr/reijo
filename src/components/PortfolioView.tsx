import React, { useMemo, useState } from 'react';
import { calcPositionPnl, formatPairLabel } from '../engine/kalshiMath';
import type { ExecutionMode, KalshiMarket, OrderAction, OrderRecord, OrderSide, Position } from '../engine/types';

interface PortfolioViewProps {
  positions: Position[];
  orders: OrderRecord[];
  markets: KalshiMarket[];
  executionMode: ExecutionMode;
  onClosePosition: (payload: {
    ticker: string;
    side: OrderSide;
    action: OrderAction;
    contracts: number;
    priceCents: number;
    mode: ExecutionMode;
    botId?: string | null;
  }) => Promise<string | null>;
  busyAction: string | null;
}

type OrderFilter = 'all' | 'filled' | 'risk_blocked' | 'error';

export const PortfolioView: React.FC<PortfolioViewProps> = ({
  positions,
  orders,
  markets,
  executionMode,
  onClosePosition,
  busyAction,
}) => {
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [closeFeedback, setCloseFeedback] = useState<string | null>(null);

  const filteredOrders = useMemo(() => {
    if (filter === 'all') return orders;
    return orders.filter((o) => o.status === filter);
  }, [orders, filter]);

  const handleClose = async (pos: Position, markBid: number) => {
    setCloseFeedback(null);
    const err = await onClosePosition({
      ticker: pos.ticker,
      side: pos.side,
      action: 'sell',
      contracts: pos.contracts,
      priceCents: markBid,
      mode: executionMode,
      botId: pos.botId ?? null,
    });
    if (err) {
      setCloseFeedback(err);
    }
  };

  return (
    <div className="space-y-5">
      {/* Open Positions */}
      <section className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Posisi Kontrak Terbuka</h2>
            <p className="text-xs text-slate-400">Valuasi mark-to-market berdasarkan bid Kalshi terkini</p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-400">{positions.length} posisi</span>
        </div>

        {closeFeedback && (
          <div role="alert" className="mx-5 mt-3 p-2.5 text-xs text-red-300 bg-red-950/60 border border-red-900/70 rounded-md">
            {closeFeedback}
          </div>
        )}

        {positions.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            Belum ada posisi kontrak terbuka. Aktifkan bot atau kirim order manual dari Terminal.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-medium text-slate-400">
                  <th className="py-2.5 px-4">Ticker & Kontrak</th>
                  <th className="py-2.5 px-3">Sisi</th>
                  <th className="py-2.5 px-3 text-right">Kontrak</th>
                  <th className="py-2.5 px-3 text-right">Avg Entry</th>
                  <th className="py-2.5 px-3 text-right">Bid Pasar</th>
                  <th className="py-2.5 px-3 text-right">Nilai Pasar</th>
                  <th className="py-2.5 px-3 text-right">Unrealized PnL</th>
                  <th className="py-2.5 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-sm">
                {positions.map((pos) => {
                  const market = markets.find((m) => m.ticker === pos.ticker);
                  const yesBid = market ? market.yesBid : pos.avgEntryCents;
                  const noBid = market ? market.noBid : 100 - pos.avgEntryCents;
                  const pnl = calcPositionPnl(pos, yesBid, noBid);

                  const rowVariant =
                    pos.variant ?? (pos.botId?.startsWith('bot-varb-') ? 'B' : pos.botId ? 'A' : null);

                  return (
                    <tr key={`${pos.ticker}-${pos.side}-${pos.botId ?? 'manual'}`} className="hover:bg-slate-800/40">
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-slate-100">
                            {formatPairLabel(pos.ticker)}
                          </span>
                          {rowVariant && (
                            <span
                              className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border ${
                                rowVariant === 'B'
                                  ? 'text-sky-300 bg-sky-950/60 border-sky-800/70'
                                  : 'text-emerald-300 bg-emerald-950/60 border-emerald-800/70'
                              }`}
                            >
                              Varian {rowVariant}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 truncate max-w-xs">{pos.marketTitle}</div>
                        {typeof pos.peakBidCents === 'number' && (
                          <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                            Peak {pos.peakBidCents}¢ ·{' '}
                            <span className={pos.trailingActivated ? 'text-emerald-400' : 'text-slate-500'}>
                              {pos.trailingActivated ? 'Trail Stop ON' : 'Trail Standby'}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs font-semibold">
                        <span className={pos.side === 'yes' ? 'text-emerald-400' : 'text-red-400'}>
                          {pos.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                        {pos.contracts}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                        {pos.avgEntryCents}¢
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                        {pnl.markPriceCents}¢
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-100">
                        ${pnl.marketValueUsd.toFixed(2)}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono tabular-nums font-medium ${
                          pnl.unrealizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {pnl.unrealizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(pnl.unrealizedPnlUsd).toFixed(2)} (
                        {pnl.returnPct >= 0 ? '+' : ''}
                        {pnl.returnPct.toFixed(1)}%)
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => handleClose(pos, pnl.markPriceCents)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-700 rounded hover:bg-slate-800 whitespace-nowrap"
                        >
                          Tutup Posisi
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Execution Ledger */}
      <section className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Riwayat Eksekusi & Log Sinyal</h2>
            <p className="text-xs text-slate-400">
              Menampilkan {orders.length} log terbaru (maks. 250 riwayat terakhir disimpan untuk order tereksekusi & Risk Guardrail)
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-md" role="group" aria-label="Filter status order">
            {(
              [
                ['all', 'Semua'],
                ['filled', 'Filled'],
                ['risk_blocked', 'Risk Blocked'],
                ['error', 'Error'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setFilter(val)}
                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
                  filter === val ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredOrders.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">Tidak ada riwayat order pada filter ini.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-medium text-slate-400">
                  <th className="py-2.5 px-4">Waktu & Sumber</th>
                  <th className="py-2.5 px-3">Ticker</th>
                  <th className="py-2.5 px-3">Order</th>
                  <th className="py-2.5 px-3 text-right">Harga</th>
                  <th className="py-2.5 px-3 text-right">Fee / Total</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-4">Alasan Sinyal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-xs">
                {filteredOrders.map((ord) => (
                  <tr key={ord.id} className="hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <div className="font-medium text-slate-100">{ord.botName}</div>
                      <div className="text-slate-400 font-mono tabular-nums">
                        {new Date(ord.createdAt).toLocaleTimeString('id-ID', { hour12: false })} · {ord.mode.toUpperCase()}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono font-medium text-slate-200 whitespace-nowrap">
                      {formatPairLabel(ord.ticker)}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap text-slate-200">
                      <span className={ord.side === 'yes' ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
                        {ord.action.toUpperCase()} {ord.side.toUpperCase()}
                      </span>{' '}
                      × {ord.contracts}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                      {ord.priceCents}¢
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300 whitespace-nowrap">
                      ${ord.feeUsd.toFixed(2)} / ${ord.totalUsd.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap font-medium">
                      <span
                        className={
                          ord.status === 'filled'
                            ? 'text-emerald-400'
                            : ord.status === 'risk_blocked'
                              ? 'text-amber-400'
                              : 'text-red-400'
                        }
                      >
                        {ord.status === 'filled'
                          ? 'Filled'
                          : ord.status === 'risk_blocked'
                            ? 'Risk Blocked'
                            : 'Error'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-300 max-w-md">{ord.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
