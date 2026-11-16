import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { formatPairLabel } from '../engine/kalshiMath';
import type { BotConfig, ExecutionMode, KalshiMarket, OrderSide, StrategyType } from '../engine/types';

interface BotFormModalProps {
  open: boolean;
  onClose: () => void;
  markets: KalshiMarket[];
  initialTicker?: string;
  editingBot?: BotConfig | null;
  hasCredentials: boolean;
  onSubmit: (payload: Partial<BotConfig>, editingId?: string) => Promise<string | null>;
}

const STRATEGY_DESCRIPTIONS: Record<StrategyType, string> = {
  trailing_momentum:
    'Varian A — Entry menit 7–13 (maks 1x/pair) saat harga 85–91¢ naik ketat (anti pisau jatuh & cek bid orderbook), arah 5m & konfirmasi 1m, TP 99¢ (atau Settle), No SL.',
  candle_prediction:
    'Varian A — Membaca arah market 5m (Engulfing, Hammer, Shooting Star, EMA5/13, RSI 9, ATR) + konfirmasi entry candle 1m untuk otomatis entry YES/NO.',
  preopen_spike:
    'Varian B — Baca candle pre-open sebelum market buka, tunggu jeda aman 5–15 dtk, max entry 65¢, target TP +15 s/d +18¢, Trailing Stop aktif di +10¢ (auto-close turun -2¢), Tanpa SL & Hard Close melewati menit ke-6.',
  mean_reversion: 'Beli saat harga pasar menyimpang di bawah Fair Value sebesar >= Entry Edge.',
  orderbook_imbalance: 'Eksekusi mengikuti dominasi likuiditas antrean bid YES vs NO pada 3 level teratas.',
  market_maker: 'Menempatkan quote pasif di dalam spread lebar untuk menangkap selisih bid-ask.',
  momentum_breakout: 'Mengikuti penembusan harga dalam 4 tick terakhir dengan Take Profit & Stop Loss ketat.',
};

export const BotFormModal: React.FC<BotFormModalProps> = ({
  open,
  onClose,
  markets,
  initialTicker,
  editingBot,
  hasCredentials,
  onSubmit,
}) => {
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [strategy, setStrategy] = useState<StrategyType>('trailing_momentum');
  const [targetSide, setTargetSide] = useState<OrderSide | 'auto'>('auto');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('paper');
  const [fairValueCents, setFairValueCents] = useState('85');
  const [entryEdgeCents, setEntryEdgeCents] = useState('2');
  const [takeProfitCents, setTakeProfitCents] = useState('15');
  const [stopLossCents, setStopLossCents] = useState('0');
  const [noStopLoss, setNoStopLoss] = useState(true);
  const [entryTriggerCents, setEntryTriggerCents] = useState('85');
  const [trailingActivationCents, setTrailingActivationCents] = useState('88');
  const [trailingDistanceCents, setTrailingDistanceCents] = useState('2');
  const [takeProfitTargetCents, setTakeProfitTargetCents] = useState('99');
  const [holdToSettle, setHoldToSettle] = useState(false);
  const [useTrailingStop, setUseTrailingStop] = useState(false);
  const [useCandleFilter, setUseCandleFilter] = useState(true);
  const [minCandleConfidence, setMinCandleConfidence] = useState('60');
  const [maxEntryPriceCents, setMaxEntryPriceCents] = useState('91');
  const [trailingActivationDeltaCents, setTrailingActivationDeltaCents] = useState('3');
  const [trailingMinProfitCents, setTrailingMinProfitCents] = useState('3');
  const [hardCloseMinute, setHardCloseMinute] = useState('6');
  const [entryDelayMinSec, setEntryDelayMinSec] = useState('5');
  const [entryDelayMaxSec, setEntryDelayMaxSec] = useState('15');
  const [maxContractsPerOrder, setMaxContractsPerOrder] = useState('1');
  const [maxPositionContracts, setMaxPositionContracts] = useState('1');
  const [maxSpreadCents, setMaxSpreadCents] = useState('2');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const lastInitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      lastInitKeyRef.current = null;
      return;
    }
    const initKey = `${editingBot?.id ?? 'new'}:${initialTicker ?? ''}`;
    if (lastInitKeyRef.current === initKey) return;
    lastInitKeyRef.current = initKey;
    setErrorMsg(null);
    if (editingBot) {
      const botNoSl = Boolean(editingBot.noStopLoss) || editingBot.stopLossCents <= 0;
      setName(editingBot.name);
      setTicker(editingBot.ticker);
      setStrategy(editingBot.strategy);
      setTargetSide(editingBot.targetSide);
      setExecutionMode(editingBot.executionMode);
      setFairValueCents(String(editingBot.fairValueCents));
      setEntryEdgeCents(String(editingBot.entryEdgeCents));
      setTakeProfitCents(String(editingBot.takeProfitCents));
      setNoStopLoss(botNoSl);
      setStopLossCents(String(botNoSl ? 0 : editingBot.stopLossCents));
      setEntryTriggerCents(String(editingBot.entryTriggerCents ?? 85));
      setTrailingActivationCents(String(editingBot.trailingActivationCents ?? 88));
      setTrailingDistanceCents(String(editingBot.trailingDistanceCents ?? 2));
      setTakeProfitTargetCents(String(editingBot.takeProfitTargetCents ?? (editingBot.holdToSettle ? 0 : 99)));
      setHoldToSettle(
        editingBot.holdToSettle ??
          (editingBot.strategy === 'candle_prediction')
      );
      setUseTrailingStop(
        editingBot.useTrailingStop ?? ((editingBot.takeProfitTargetCents ?? 99) < 50)
      );
      setUseCandleFilter(editingBot.useCandleFilter ?? true);
      setMinCandleConfidence(String(editingBot.minCandleConfidence ?? 60));
      setMaxEntryPriceCents(
        String(editingBot.maxEntryPriceCents ?? (editingBot.strategy === 'preopen_spike' ? 65 : 91))
      );
      setTrailingActivationDeltaCents(
        String(editingBot.trailingActivationDeltaCents ?? (editingBot.strategy === 'preopen_spike' ? 10 : 3))
      );
      setTrailingMinProfitCents(String(editingBot.trailingMinProfitCents ?? 3));
      setHardCloseMinute(String(editingBot.hardCloseMinute ?? 6));
      setEntryDelayMinSec(String(editingBot.entryDelayMinSec ?? 5));
      setEntryDelayMaxSec(String(editingBot.entryDelayMaxSec ?? 15));
      setMaxContractsPerOrder(String(editingBot.maxContractsPerOrder));
      setMaxPositionContracts(String(editingBot.maxPositionContracts));
      setMaxSpreadCents(String(editingBot.maxSpreadCents));
    } else {
      const targetTicker = initialTicker || markets[0]?.ticker || '';
      const targetMarket = markets.find((m) => m.ticker === targetTicker);
      setName('');
      setTicker(targetTicker);
      setStrategy('trailing_momentum');
      setTargetSide('auto');
      setExecutionMode('paper');
      setFairValueCents(String(targetMarket?.lastPrice ?? 85));
      setEntryEdgeCents('2');
      setTakeProfitCents('15');
      setNoStopLoss(true);
      setStopLossCents('0');
      setEntryTriggerCents('85');
      setTrailingActivationCents('88');
      setTrailingDistanceCents('2');
      setTakeProfitTargetCents('99');
      setHoldToSettle(false);
      setUseTrailingStop(false);
      setUseCandleFilter(true);
      setMinCandleConfidence('60');
      setMaxEntryPriceCents('91');
      setTrailingActivationDeltaCents('3');
      setTrailingMinProfitCents('3');
      setHardCloseMinute('6');
      setEntryDelayMinSec('5');
      setEntryDelayMaxSec('15');
      setMaxContractsPerOrder('1');
      setMaxPositionContracts('1');
      setMaxSpreadCents('2');
    }
  }, [open, editingBot, initialTicker, markets]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleStrategyChange = (next: StrategyType) => {
    setStrategy(next);
    if (next === 'preopen_spike') {
      setMaxEntryPriceCents('65');
      setTakeProfitCents('16');
      setNoStopLoss(true);
      setStopLossCents('0');
      setTrailingActivationDeltaCents('10');
      setTrailingDistanceCents('2');
      setHardCloseMinute('6');
      setEntryDelayMinSec('5');
      setEntryDelayMaxSec('15');
      setMinCandleConfidence('58');
      setUseCandleFilter(true);
      setMaxSpreadCents('3');
    } else if (next === 'trailing_momentum') {
      setEntryTriggerCents('85');
      setMaxEntryPriceCents('91');
      setTrailingActivationCents('88');
      setTakeProfitTargetCents('99');
      setTakeProfitCents('15');
      setNoStopLoss(true);
      setStopLossCents('0');
      setTrailingActivationDeltaCents('3');
      setTrailingMinProfitCents('3');
      setTrailingDistanceCents('2');
      setHoldToSettle(false);
      setUseTrailingStop(false);
      setUseCandleFilter(true);
      setMinCandleConfidence('60');
      setMaxSpreadCents('2');
    } else if (next === 'candle_prediction') {
      setHoldToSettle(true);
      setUseCandleFilter(true);
      setNoStopLoss(false);
      setMinCandleConfidence('60');
      setTakeProfitCents('10');
      setStopLossCents('70');
      setMaxSpreadCents('4');
    } else {
      setNoStopLoss(false);
      setStopLossCents('10');
      setMaxSpreadCents('6');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    const err = await onSubmit(
      {
        name,
        ticker,
        strategy,
        targetSide,
        executionMode,
        fairValueCents: Number(fairValueCents),
        entryEdgeCents: Number(entryEdgeCents),
        takeProfitCents: Number(takeProfitCents),
        noStopLoss,
        stopLossCents: noStopLoss ? 0 : Number(stopLossCents),
        useCandleFilter,
        minCandleConfidence: Number(minCandleConfidence),
        ...(strategy === 'candle_prediction' ? { holdToSettle } : {}),
        ...(strategy === 'preopen_spike'
          ? {
              maxEntryPriceCents: Number(maxEntryPriceCents),
              trailingActivationDeltaCents: Number(trailingActivationDeltaCents),
              trailingDistanceCents: Number(trailingDistanceCents),
              hardCloseMinute: Number(hardCloseMinute),
              entryDelayMinSec: Number(entryDelayMinSec),
              entryDelayMaxSec: Number(entryDelayMaxSec),
              entryWindowEndSec: 90,
            }
          : {}),
        ...(strategy === 'trailing_momentum'
          ? {
              entryTriggerCents: Number(entryTriggerCents),
              maxEntryPriceCents: Number(maxEntryPriceCents),
              entryBandCents: 0,
              trailingActivationCents: Number(trailingActivationCents),
              trailingActivationDeltaCents: Number(trailingActivationDeltaCents),
              trailingMinProfitCents: Number(trailingMinProfitCents),
              trailingDistanceCents: Number(trailingDistanceCents),
              takeProfitTargetCents: holdToSettle ? 0 : Number(takeProfitTargetCents),
              holdToSettle,
              useTrailingStop,
            }
          : {}),
        maxContractsPerOrder: Number(maxContractsPerOrder),
        maxPositionContracts: Number(maxPositionContracts),
        maxSpreadCents: Number(maxSpreadCents),
      },
      editingBot?.id
    );
    setSubmitting(false);
    if (err) {
      setErrorMsg(err);
    } else {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-modal-title"
    >
      <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 id="bot-modal-title" className="text-base font-semibold text-slate-100">
            {editingBot ? `Edit Bot: ${editingBot.name}` : 'Buat Bot Trading Kalshi'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup dialog bot"
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          {errorMsg && (
            <div role="alert" className="p-3 text-xs text-red-300 bg-red-950/60 border border-red-900/70 rounded-md">
              {errorMsg}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="bot-name" className="block text-xs font-medium text-slate-300 mb-1">
                Nama Bot
              </label>
              <input
                id="bot-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mis. BTC 15m Trail 80→90"
                className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 placeholder:text-slate-500 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label htmlFor="bot-ticker" className="block text-xs font-medium text-slate-300 mb-1">
                Target Market Kalshi
              </label>
              <select
                id="bot-ticker"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {markets.map((m) => (
                  <option key={m.ticker} value={m.ticker}>
                    {formatPairLabel(m.ticker)} · {m.category} ({m.lastPrice}¢)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label htmlFor="bot-strategy" className="block text-xs font-medium text-slate-300 mb-1">
                Strategi Algoritma
              </label>
              <select
                id="bot-strategy"
                value={strategy}
                onChange={(e) => handleStrategyChange(e.target.value as StrategyType)}
                className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="trailing_momentum">Varian A · Arah 5m + Konfirm 1m · Entry 85–91¢ Naik (TP 99¢)</option>
                <option value="preopen_spike">Varian B · Pre-Open Spike (Max 65¢, No SL, HC 6m)</option>
                <option value="candle_prediction">Varian A · Baca Candle 5m + Konfirm 1m</option>
                <option value="mean_reversion">Mean Reversion (Fair Value)</option>
                <option value="orderbook_imbalance">Orderbook Imbalance</option>
                <option value="market_maker">Spread Market Maker</option>
                <option value="momentum_breakout">Momentum Breakout</option>
              </select>
              <p className="mt-1 text-xs text-slate-400">{STRATEGY_DESCRIPTIONS[strategy]}</p>
            </div>

            <div>
              <label htmlFor="bot-side" className="block text-xs font-medium text-slate-300 mb-1">
                Arah Kontrak
              </label>
              <select
                id="bot-side"
                value={targetSide}
                onChange={(e) => setTargetSide(e.target.value as OrderSide | 'auto')}
                className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="auto">Auto (YES / NO)</option>
                <option value="yes">YES Only</option>
                <option value="no">NO Only</option>
              </select>
            </div>
          </div>

          {strategy === 'preopen_spike' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label htmlFor="bot-max-entry" className="block text-xs font-medium text-slate-300 mb-1">
                  Max Entry (¢)
                </label>
                <input
                  id="bot-max-entry"
                  type="number"
                  min={40}
                  max={80}
                  value={maxEntryPriceCents}
                  onChange={(e) => setMaxEntryPriceCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-tp" className="block text-xs font-medium text-slate-300 mb-1">
                  Target TP (+¢ · 15–18)
                </label>
                <input
                  id="bot-tp"
                  type="number"
                  min={5}
                  max={45}
                  value={takeProfitCents}
                  onChange={(e) => setTakeProfitCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-hard-close" className="block text-xs font-medium text-slate-300 mb-1">
                  Hard Close (Menit)
                </label>
                <input
                  id="bot-hard-close"
                  type="number"
                  min={1}
                  max={14}
                  value={hardCloseMinute}
                  onChange={(e) => setHardCloseMinute(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-trail-delta" className="block text-xs font-medium text-slate-300 mb-1">
                  Trail Aktif (+¢)
                </label>
                <input
                  id="bot-trail-delta"
                  type="number"
                  min={3}
                  max={30}
                  value={trailingActivationDeltaCents}
                  onChange={(e) => setTrailingActivationDeltaCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-trail-dist" className="block text-xs font-medium text-slate-300 mb-1">
                  Auto Close Turun (-¢)
                </label>
                <input
                  id="bot-trail-dist"
                  type="number"
                  min={1}
                  max={15}
                  value={trailingDistanceCents}
                  onChange={(e) => setTrailingDistanceCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-min-conf" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Conf Pre-Open (%)
                </label>
                <input
                  id="bot-min-conf"
                  type="number"
                  min={50}
                  max={95}
                  value={minCandleConfidence}
                  onChange={(e) => setMinCandleConfidence(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-delay-min" className="block text-xs font-medium text-slate-300 mb-1">
                  Jeda Min (Detik)
                </label>
                <input
                  id="bot-delay-min"
                  type="number"
                  min={0}
                  max={60}
                  value={entryDelayMinSec}
                  onChange={(e) => setEntryDelayMinSec(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-delay-max" className="block text-xs font-medium text-slate-300 mb-1">
                  Jeda Max (Detik)
                </label>
                <input
                  id="bot-delay-max"
                  type="number"
                  min={5}
                  max={60}
                  value={entryDelayMaxSec}
                  onChange={(e) => setEntryDelayMaxSec(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              {!noStopLoss && (
                <div>
                  <label htmlFor="bot-sl" className="block text-xs font-medium text-slate-300 mb-1">
                    Stop Loss (-¢)
                  </label>
                  <input
                    id="bot-sl"
                    type="number"
                    min={5}
                    max={60}
                    value={stopLossCents}
                    onChange={(e) => setStopLossCents(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              )}
              <label className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-slate-300 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={noStopLoss}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setNoStopLoss(checked);
                    setStopLossCents(checked ? '0' : '20');
                  }}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500"
                />
                <span>Tanpa Stop Loss (No SL — cukup Hard Close setelah melewati menit ke-{hardCloseMinute || 6})</span>
              </label>
            </div>
          ) : strategy === 'trailing_momentum' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label htmlFor="bot-trigger" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Entry (¢)
                </label>
                <input
                  id="bot-trigger"
                  type="number"
                  min={50}
                  max={94}
                  value={entryTriggerCents}
                  onChange={(e) => setEntryTriggerCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-max-entry-a" className="block text-xs font-medium text-slate-300 mb-1">
                  Max Entry (¢)
                </label>
                <input
                  id="bot-max-entry-a"
                  type="number"
                  min={50}
                  max={94}
                  value={maxEntryPriceCents}
                  onChange={(e) => setMaxEntryPriceCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-min-conf" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Conf Candle (%)
                </label>
                <input
                  id="bot-min-conf"
                  type="number"
                  min={50}
                  max={95}
                  value={minCandleConfidence}
                  onChange={(e) => setMinCandleConfidence(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              {!holdToSettle && (
                <>
                  <div>
                    <label htmlFor="bot-tp-target" className="block text-xs font-medium text-slate-300 mb-1">
                      Target Harga TP (¢)
                    </label>
                    <input
                      id="bot-tp-target"
                      type="number"
                      min={50}
                      max={99}
                      value={takeProfitTargetCents}
                      onChange={(e) => setTakeProfitTargetCents(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  {useTrailingStop && (
                    <>
                      <div>
                        <label htmlFor="bot-trail-act-a" className="block text-xs font-medium text-slate-300 mb-1">
                          Trail Aktif (+¢)
                        </label>
                        <input
                          id="bot-trail-act-a"
                          type="number"
                          min={1}
                          max={30}
                          value={trailingActivationDeltaCents}
                          onChange={(e) => setTrailingActivationDeltaCents(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label htmlFor="bot-trail-min-a" className="block text-xs font-medium text-slate-300 mb-1">
                          Min Jual Trail (+¢)
                        </label>
                        <input
                          id="bot-trail-min-a"
                          type="number"
                          min={1}
                          max={30}
                          value={trailingMinProfitCents}
                          onChange={(e) => setTrailingMinProfitCents(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label htmlFor="bot-trail-dist-a" className="block text-xs font-medium text-slate-300 mb-1">
                          Jarak Trail (-¢)
                        </label>
                        <input
                          id="bot-trail-dist-a"
                          type="number"
                          min={1}
                          max={15}
                          value={trailingDistanceCents}
                          onChange={(e) => setTrailingDistanceCents(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                    </>
                  )}
                </>
              )}
              {!noStopLoss && (
                <div>
                  <label htmlFor="bot-sl" className="block text-xs font-medium text-slate-300 mb-1">
                    Stop Loss (-¢)
                  </label>
                  <input
                    id="bot-sl"
                    type="number"
                    min={1}
                    max={90}
                    value={stopLossCents}
                    onChange={(e) => setStopLossCents(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              )}
              {!holdToSettle && (
                <label className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-slate-300 pt-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useTrailingStop}
                    onChange={(e) => setUseTrailingStop(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>
                    Aktifkan Trailing Stop (+{trailingActivationDeltaCents || 3}¢/-{trailingDistanceCents || 2}¢, min jual +{trailingMinProfitCents || 3}¢) sebelum TP {takeProfitTargetCents || 99}¢
                  </span>
                </label>
              )}
              <label className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-slate-300 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={holdToSettle}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setHoldToSettle(checked);
                    if (checked) {
                      setTakeProfitCents('0');
                      setTakeProfitTargetCents('0');
                      setUseTrailingStop(false);
                    } else {
                      setTakeProfitCents('15');
                      setTakeProfitTargetCents('99');
                    }
                  }}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500"
                />
                <span>
                  Tanpa TP · Hold sampai Fix Settle (biarkan posisi selesai 15m tanpa jual di {takeProfitTargetCents || 99}¢)
                </span>
              </label>
              <label className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-slate-300 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={noStopLoss}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setNoStopLoss(checked);
                    setStopLossCents(checked ? '0' : '20');
                  }}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500"
                />
                <span>
                  Tanpa Stop Loss (No SL{holdToSettle ? ' — hold penuh sampai settlement Kalshi' : ` — jual di TP ${takeProfitTargetCents || 99}¢ atau Settle`})
                </span>
              </label>
            </div>
          ) : strategy === 'candle_prediction' ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label htmlFor="bot-min-conf" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Confidence (%)
                </label>
                <input
                  id="bot-min-conf"
                  type="number"
                  min={50}
                  max={95}
                  value={minCandleConfidence}
                  onChange={(e) => setMinCandleConfidence(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-tp" className="block text-xs font-medium text-slate-300 mb-1">
                  Take Profit (¢)
                </label>
                <input
                  id="bot-tp"
                  type="number"
                  min={1}
                  max={90}
                  value={takeProfitCents}
                  onChange={(e) => setTakeProfitCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-sl" className="block text-xs font-medium text-slate-300 mb-1">
                  Hard SL (¢)
                </label>
                <input
                  id="bot-sl"
                  type="number"
                  min={1}
                  max={90}
                  value={stopLossCents}
                  onChange={(e) => setStopLossCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <label className="sm:col-span-3 flex items-center gap-2 text-xs text-slate-300 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={holdToSettle}
                  onChange={(e) => setHoldToSettle(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500"
                />
                <span>Hold sampai Fix Settle (keluar hanya jika Hard SL tersentuh)</span>
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label htmlFor="bot-fair" className="block text-xs font-medium text-slate-300 mb-1">
                  Fair Value (¢)
                </label>
                <input
                  id="bot-fair"
                  type="number"
                  min={1}
                  max={99}
                  value={fairValueCents}
                  onChange={(e) => setFairValueCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-edge" className="block text-xs font-medium text-slate-300 mb-1">
                  Entry Edge (¢)
                </label>
                <input
                  id="bot-edge"
                  type="number"
                  min={1}
                  max={40}
                  value={entryEdgeCents}
                  onChange={(e) => setEntryEdgeCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-tp" className="block text-xs font-medium text-slate-300 mb-1">
                  Take Profit (¢)
                </label>
                <input
                  id="bot-tp"
                  type="number"
                  min={1}
                  max={90}
                  value={takeProfitCents}
                  onChange={(e) => setTakeProfitCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bot-sl" className="block text-xs font-medium text-slate-300 mb-1">
                  Stop Loss (¢)
                </label>
                <input
                  id="bot-sl"
                  type="number"
                  min={1}
                  max={90}
                  value={stopLossCents}
                  onChange={(e) => setStopLossCents(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="bot-qty" className="block text-xs font-medium text-slate-300 mb-1">
                Kontrak / Order
              </label>
              <input
                id="bot-qty"
                type="number"
                min={1}
                value={maxContractsPerOrder}
                onChange={(e) => setMaxContractsPerOrder(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label htmlFor="bot-maxpos" className="block text-xs font-medium text-slate-300 mb-1">
                Maks Posisi (Kontrak)
              </label>
              <input
                id="bot-maxpos"
                type="number"
                min={1}
                value={maxPositionContracts}
                onChange={(e) => setMaxPositionContracts(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label htmlFor="bot-spread" className="block text-xs font-medium text-slate-300 mb-1">
                Batas Spread (¢)
              </label>
              <input
                id="bot-spread"
                type="number"
                min={1}
                max={30}
                value={maxSpreadCents}
                onChange={(e) => setMaxSpreadCents(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800">
            <label htmlFor="bot-mode" className="block text-xs font-medium text-slate-300 mb-1">
              Mode Eksekusi
            </label>
            <select
              id="bot-mode"
              value={executionMode}
              onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
              className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="paper">Paper Trading (Simulasi Saldo & Ledger Lokal)</option>
              <option value="live" disabled={!hasCredentials}>
                Live Kalshi API {!hasCredentials ? '(Butuh env KALSHI_API_KEY_ID & PRIVATE_KEY)' : '(Aktif)'}
              </option>
            </select>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-950 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Menyimpan...' : editingBot ? 'Simpan Perubahan' : 'Simpan & Aktifkan Bot'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
