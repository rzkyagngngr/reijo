import React, { useMemo, useState } from 'react';
import { Layers, Pause, Pencil, Play, StepForward, Trash2, Zap } from 'lucide-react';
import { formatSpotPrice } from '../engine/candleAnalyzer';
import { formatPairLabel } from '../engine/kalshiMath';
import type { BotConfig, KalshiMarket, StrategyType } from '../engine/types';

interface StrategiesViewProps {
  bots: BotConfig[];
  markets: KalshiMarket[];
  onCreateBot: () => void;
  onEditBot: (bot: BotConfig) => void;
  onToggleBot: (bot: BotConfig) => Promise<void>;
  onStepBotTick: (botId: string) => Promise<void>;
  onDeleteBot: (botId: string) => Promise<void>;
  onRunAllCycle: () => Promise<void>;
  onDeploy15mSuite: (strategy?: 'trailing_momentum' | 'candle_prediction' | 'preopen_spike') => Promise<void>;
  busyAction: string | null;
}

const STRATEGY_LABELS: Record<StrategyType, string> = {
  trailing_momentum: 'Varian A · Arah 5m + Konfirm 1m · Entry 85–91¢ Naik · TP 99¢',
  candle_prediction: 'Varian A · Baca Candle 5m + Konfirm 1m',
  preopen_spike: 'Varian B · Pre-Open Spike (Menit 0–6)',
  mean_reversion: 'Mean Reversion',
  orderbook_imbalance: 'Orderbook Imbalance',
  market_maker: 'Spread Market Maker',
  momentum_breakout: 'Momentum Breakout',
};

function getBotVariant(bot: BotConfig): 'A' | 'B' {
  return bot.strategy === 'preopen_spike' || bot.id.startsWith('bot-varb-') ? 'B' : 'A';
}

export const StrategiesView: React.FC<StrategiesViewProps> = ({
  bots,
  markets,
  onCreateBot,
  onEditBot,
  onToggleBot,
  onStepBotTick,
  onDeleteBot,
  onRunAllCycle,
  onDeploy15mSuite,
  busyAction,
}) => {
  const [variantFilter, setVariantFilter] = useState<'all' | 'A' | 'B'>('all');

  const variantStats = useMemo(() => {
    const varA = bots.filter((b) => getBotVariant(b) === 'A');
    const varB = bots.filter((b) => getBotVariant(b) === 'B');
    const sumStats = (list: BotConfig[]) => ({
      total: list.length,
      running: list.filter((b) => b.status === 'running').length,
      trades: list.reduce((s, b) => s + b.tradesExecuted, 0),
      pnl: Number(list.reduce((s, b) => s + b.realizedPnlUsd, 0).toFixed(2)),
    });
    return { A: sumStats(varA), B: sumStats(varB) };
  }, [bots]);

  const filteredBots = useMemo(() => {
    if (variantFilter === 'all') return bots;
    return bots.filter((b) => getBotVariant(b) === variantFilter);
  }, [bots, variantFilter]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Mesin Bot & Strategi Terpisah (Varian A & B)</h2>
          <p className="text-xs text-slate-400">
            Varian A (menit 7–13, entry 85–91¢ harga naik ketat / anti pisau jatuh + arah 5m &amp; konfirmasi 1m, TP 99¢ atau Settle, No SL) &amp; Varian B (prediksi pre-open, tunggu 5–15 dtk, max 65¢, TP +16¢, Trail +10¢/-2¢, No SL, Hard Close 6m) berjalan independen.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onDeploy15mSuite('preopen_spike')}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-sky-300 bg-sky-950/60 border border-sky-800/70 rounded-md hover:bg-sky-900/60 disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Deploy Varian B (Pre-Open)</span>
          </button>
          <button
            type="button"
            onClick={() => onDeploy15mSuite('trailing_momentum')}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-300 bg-emerald-950/60 border border-emerald-800/70 rounded-md hover:bg-emerald-900/60 disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Deploy Varian A (85–91¢ TP 99¢)</span>
          </button>
          <button
            type="button"
            onClick={onRunAllCycle}
            disabled={busyAction !== null || bots.every((b) => b.status !== 'running')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-700 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Eksekusi Semua</span>
          </button>
          <button
            type="button"
            onClick={onCreateBot}
            className="px-3.5 py-2 text-xs font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500 whitespace-nowrap shrink-0 transition-colors"
          >
            + Tambah Bot
          </button>
        </div>
      </div>

      {/* Varian A vs Varian B Summary & Filter Strip */}
      <div className="border-b border-slate-800 bg-slate-950/50">
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800">
          <div className="px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 text-[11px] font-mono font-semibold text-emerald-300 bg-emerald-950/60 border border-emerald-800/70 rounded">
                  Varian A
                </span>
                <span className="text-xs font-semibold text-slate-200">Entry 85–91¢ Naik Ketat · TP 99¢ · Menit 7–13</span>
              </div>
              <p className="mt-1 text-[11px] font-mono text-slate-400">
                Entry 85–91¢ (Anti Pisau Jatuh &amp; Bid Support) · Prediksi 5m + Konfirm 1m · TP 99¢ (atau Settle) · No SL
              </p>
            </div>
            <div className="text-right font-mono tabular-nums shrink-0">
              <div className="text-xs text-slate-300">
                {variantStats.A.running}/{variantStats.A.total} aktif · {variantStats.A.trades} eks
              </div>
              <div
                className={`text-sm font-semibold ${
                  variantStats.A.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {variantStats.A.pnl >= 0 ? '+' : '-'}${Math.abs(variantStats.A.pnl).toFixed(2)}
              </div>
            </div>
          </div>

          <div className="px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 text-[11px] font-mono font-semibold text-sky-300 bg-sky-950/60 border border-sky-800/70 rounded">
                  Varian B
                </span>
                <span className="text-xs font-semibold text-slate-200">Pre-Open Spike · Menit 0–6</span>
              </div>
              <p className="mt-1 text-[11px] font-mono text-slate-400">
                Jeda 5–15 dtk · Max 65¢ · TP +16¢ · Trail +10¢/-2¢ · No SL · HC 6m
              </p>
            </div>
            <div className="text-right font-mono tabular-nums shrink-0">
              <div className="text-xs text-slate-300">
                {variantStats.B.running}/{variantStats.B.total} aktif · {variantStats.B.trades} eks
              </div>
              <div
                className={`text-sm font-semibold ${
                  variantStats.B.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {variantStats.B.pnl >= 0 ? '+' : '-'}${Math.abs(variantStats.B.pnl).toFixed(2)}
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded-md" role="group" aria-label="Filter varian strategi">
            {(
              [
                ['all', `Semua (${bots.length})`],
                ['A', `Varian A (${variantStats.A.total})`],
                ['B', `Varian B (${variantStats.B.total})`],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setVariantFilter(val)}
                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap transition-colors ${
                  variantFilter === val
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Menampilkan {filteredBots.length} dari {bots.length} bot
          </span>
        </div>
      </div>

      {filteredBots.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm text-slate-400">
            {bots.length === 0
              ? 'Belum ada bot strategi yang dikonfigurasi.'
              : `Tidak ada bot pada filter Varian ${variantFilter}.`}
          </p>
          <button
            type="button"
            onClick={bots.length === 0 ? onCreateBot : () => setVariantFilter('all')}
            className="mt-3 px-4 py-2 text-xs font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500"
          >
            {bots.length === 0 ? 'Buat Bot Pertama' : 'Tampilkan Semua Bot'}
          </button>
        </div>
      ) : (
        <div className="divide-y divide-slate-800">
          {filteredBots.map((bot) => {
            const market = markets.find((m) => m.ticker === bot.ticker);
            const variant = getBotVariant(bot);
            const pred =
              bot.strategy === 'preopen_spike'
                ? (market?.preOpenPrediction ?? market?.candlePrediction)
                : market?.candlePrediction;
            const isRunning = bot.status === 'running';
            return (
              <div
                key={bot.id}
                className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-800/40 transition-colors"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border ${
                        variant === 'B'
                          ? 'text-sky-300 bg-sky-950/60 border-sky-800/70'
                          : 'text-emerald-300 bg-emerald-950/60 border-emerald-800/70'
                      }`}
                    >
                      Varian {variant}
                    </span>
                    <h3 className="text-sm font-semibold text-slate-100">{bot.name}</h3>
                    <span className="text-xs text-slate-600" aria-hidden="true">·</span>
                    <span
                      className={`text-xs font-medium ${
                        isRunning ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {isRunning ? 'Aktif (Running)' : 'Dijeda (Paused)'}
                    </span>
                    <span className="text-xs text-slate-600" aria-hidden="true">·</span>
                    <span className="text-xs font-mono text-slate-400">
                      {STRATEGY_LABELS[bot.strategy]} · Mode {bot.executionMode.toUpperCase()}
                    </span>
                  </div>

                  <div className="text-xs text-slate-400 font-mono tabular-nums">
                    Pair: <span className="font-semibold text-slate-200">{formatPairLabel(bot.ticker)}</span>
                    {market ? ` (${market.category} · Last ${market.lastPrice}¢ · Ask ${market.yesAsk}¢)` : ''}
                    {bot.strategy === 'preopen_spike' ? (
                      <>
                        {' '}· Jendela 00:{String(bot.entryDelayMinSec ?? 5).padStart(2, '0')}–01:30 (jeda{' '}
                        {bot.entryDelayMinSec ?? 5}–{bot.entryDelayMaxSec ?? 15} dtk) · Max Entry{' '}
                        {bot.maxEntryPriceCents ?? 65}¢ · TP +{bot.takeProfitCents}¢ · Trail +
                        {bot.trailingActivationDeltaCents ?? 10}¢/-{bot.trailingDistanceCents ?? 2}¢ ·{' '}
                        {bot.noStopLoss || bot.stopLossCents <= 0 ? 'No SL' : `SL -${bot.stopLossCents}¢`} · Hard Close{' '}
                        {bot.hardCloseMinute ?? 6}m · Min Conf {bot.minCandleConfidence ?? 58}% · Size{' '}
                        {bot.maxContractsPerOrder}/{bot.maxPositionContracts}
                      </>
                    ) : bot.strategy === 'trailing_momentum' ? (
                      <>
                        {' '}· Jendela Menit 7–13 · Maks 1x/Pair · Entry {bot.entryTriggerCents ?? 85}–
                        {Math.max(
                          bot.entryTriggerCents ?? 85,
                          bot.maxEntryPriceCents ?? 91
                        )}¢ · Arah 5m + Konfirm 1m &gt;={bot.minCandleConfidence ?? 60}% ·{' '}
                        {bot.holdToSettle || ((bot.takeProfitTargetCents ?? 0) < 50 && bot.takeProfitCents <= 0)
                          ? 'Tanpa TP (Hold sampai Settle)'
                          : (bot.takeProfitTargetCents ?? 0) >= 50
                            ? `TP ${bot.takeProfitTargetCents}¢${bot.useTrailingStop ? ` · Trail +${bot.trailingActivationDeltaCents ?? 3}¢/-${bot.trailingDistanceCents ?? 2}¢ (Min +${bot.trailingMinProfitCents ?? 3}¢)` : ' (atau Settle)'}`
                            : `TP +${bot.takeProfitCents || 15}¢ · Trail +${bot.trailingActivationDeltaCents ?? 3}¢/-${bot.trailingDistanceCents ?? 2}¢ (Min +${bot.trailingMinProfitCents ?? 3}¢)`}{' '}
                        · {bot.noStopLoss || bot.stopLossCents <= 0 ? 'No SL' : `SL -${bot.stopLossCents}¢`} · Size{' '}
                        {bot.maxContractsPerOrder}/{bot.maxPositionContracts}
                      </>
                    ) : bot.strategy === 'candle_prediction' ? (
                      <>
                        {' '}· Jendela Menit 7–13 · Min Conf {bot.minCandleConfidence ?? 60}% ·{' '}
                        {bot.holdToSettle ? 'Hold Fix Settle' : `TP +${bot.takeProfitCents}¢`} ·{' '}
                        {bot.noStopLoss || bot.stopLossCents <= 0 ? 'No SL' : `SL -${bot.stopLossCents}¢`} · Size{' '}
                        {bot.maxContractsPerOrder}/{bot.maxPositionContracts}
                      </>
                    ) : (
                      <>
                        {' '}· Jendela Menit 7–13 · Maks 1x/Pair · Fair {bot.fairValueCents}¢ · Edge{' '}
                        {bot.entryEdgeCents}¢ · TP/SL +{bot.takeProfitCents}¢/-{bot.stopLossCents}¢ · Size{' '}
                        {bot.maxContractsPerOrder}/{bot.maxPositionContracts}
                      </>
                    )}
                  </div>

                  {pred && (
                    <div className="text-xs font-mono tabular-nums space-y-0.5">
                      <div>
                        <span className="text-slate-400">
                          {bot.strategy === 'preopen_spike'
                            ? `Prediksi Pre-Open ${(pred.timeframe ?? '5m').toUpperCase()}: `
                            : `Prediksi Arah ${(pred.timeframe ?? '5m').toUpperCase()}: `}
                        </span>
                        <span
                          className={`font-semibold ${
                            pred.direction === 'BULLISH'
                              ? 'text-emerald-400'
                              : pred.direction === 'BEARISH'
                                ? 'text-red-400'
                                : 'text-slate-300'
                          }`}
                        >
                          {pred.direction === 'BULLISH'
                            ? '▲ NAIK (YES)'
                            : pred.direction === 'BEARISH'
                              ? '▼ TURUN (NO)'
                              : '• NETRAL'}{' '}
                          {pred.confidencePct}%
                        </span>
                        <span className="text-slate-400">
                          {' '}· Proyeksi{' '}
                          {pred.source === 'kalshi_1m' || pred.source === 'kalshi_5m'
                            ? `${Math.round(pred.currentPrice)}¢ → ${Math.round(pred.predictedPrice)}¢`
                            : `${formatSpotPrice(pred.currentPrice, pred.symbol)} → ${formatSpotPrice(pred.predictedPrice, pred.symbol)}`}
                          {pred.patterns.length > 0 ? ` · ${pred.patterns.slice(0, 2).join(', ')}` : ''}
                        </span>
                      </div>
                      {pred.confirm1m && (
                        <div className="text-[11px] text-slate-400">
                          Konfirm 1m:{' '}
                          <span
                            className={`font-semibold ${
                              pred.confirm1m.lastCandleDir === 'BULLISH'
                                ? 'text-emerald-400'
                                : pred.confirm1m.lastCandleDir === 'BEARISH'
                                  ? 'text-red-400'
                                  : 'text-slate-300'
                            }`}
                          >
                            Candle {pred.confirm1m.lastCandleDir === 'BULLISH' ? 'HIJAU ↑' : pred.confirm1m.lastCandleDir === 'BEARISH' ? 'MERAH ↓' : 'NETRAL'}
                          </span>
                          {' · '}EMA5/13 {pred.confirm1m.emaFast >= pred.confirm1m.emaSlow ? 'Bull' : 'Bear'} · RSI{' '}
                          {pred.confirm1m.rsi.toFixed(0)}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="text-xs text-slate-400">
                    Sinyal terakhir: <span className="text-slate-200">{bot.lastSignalReason}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 shrink-0">
                  <div className="text-right mr-2 font-mono tabular-nums">
                    <div className="text-xs text-slate-400">{bot.tradesExecuted} eksekusi</div>
                    <div
                      className={`text-sm font-semibold ${
                        bot.realizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {bot.realizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(bot.realizedPnlUsd).toFixed(2)}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onToggleBot(bot)}
                    disabled={busyAction !== null}
                    aria-label={isRunning ? `Jeda ${bot.name}` : `Aktifkan ${bot.name}`}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border whitespace-nowrap shrink-0 transition-colors ${
                      isRunning
                        ? 'text-amber-300 bg-amber-950/60 border-amber-800/70 hover:bg-amber-900/60'
                        : 'text-emerald-300 bg-emerald-950/60 border-emerald-800/70 hover:bg-emerald-900/60'
                    }`}
                  >
                    {isRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    <span>{isRunning ? 'Jeda' : 'Aktifkan'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onStepBotTick(bot.id)}
                    disabled={busyAction !== null}
                    aria-label={`Uji 1 tick ${bot.name}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-700 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 transition-colors"
                  >
                    <StepForward className="w-3.5 h-3.5" />
                    <span>Run Tick</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onEditBot(bot)}
                    aria-label={`Edit ${bot.name}`}
                    className="p-2 text-slate-300 hover:text-slate-100 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => onDeleteBot(bot.id)}
                    aria-label={`Hapus ${bot.name}`}
                    className="p-2 text-red-400 hover:text-red-300 border border-slate-700 rounded-md hover:bg-red-950/50 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

