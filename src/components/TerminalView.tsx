import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Play, RefreshCw, Search } from 'lucide-react';
import { formatSpotPrice } from '../engine/candleAnalyzer';
import {
  calcContractCost,
  calcKalshiFee,
  calcOrderbookMetrics,
  formatPairLabel,
  formatRemainingTime,
} from '../engine/kalshiMath';
import type {
  CandlePrediction,
  ExecutionMode,
  KalshiMarket,
  MarketCategory,
  OhlcCandle,
  OrderAction,
  OrderBook,
  OrderSide,
} from '../engine/types';
import { CandlestickChart } from './CandlestickChart';
import { ProbabilityChart } from './ProbabilityChart';

interface TerminalViewProps {
  markets: KalshiMarket[];
  orderbooks: Record<string, OrderBook>;
  selectedTicker: string;
  onSelectTicker: (ticker: string) => void;
  onRefreshFeed: () => Promise<void>;
  onRunBotCycle: () => Promise<void>;
  onPlaceManualOrder: (payload: {
    ticker: string;
    side: OrderSide;
    action: OrderAction;
    contracts: number;
    priceCents: number;
    mode: ExecutionMode;
  }) => Promise<string | null>;
  onOpenBotForTicker: (ticker: string) => void;
  executionMode: ExecutionMode;
  busyAction: string | null;
  nowMs: number;
  wsConnected: boolean;
}

type FilterCategory = 'All' | MarketCategory;

const CATEGORIES: FilterCategory[] = ['All', 'Crypto', 'Commodities', 'Forex'];

export const TerminalView: React.FC<TerminalViewProps> = ({
  markets,
  orderbooks,
  selectedTicker,
  onSelectTicker,
  onRefreshFeed,
  onRunBotCycle,
  onPlaceManualOrder,
  onOpenBotForTicker,
  executionMode,
  busyAction,
  nowMs,
  wsConnected,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<FilterCategory>('All');
  const [orderSide, setOrderSide] = useState<OrderSide>('yes');
  const [orderAction, setOrderAction] = useState<OrderAction>('buy');
  const [contractsInput, setContractsInput] = useState('1');
  const [limitPriceInput, setLimitPriceInput] = useState('');
  const [orderMessage, setOrderMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [chartTab, setChartTab] = useState<'spot5m' | 'spot1m' | 'kalshi' | 'prob'>('spot5m');
  const [candleData, setCandleData] = useState<{
    ticker: string;
    spotCandles: OhlcCandle[];
    spotCandles5m?: OhlcCandle[];
    spotCandles1m?: OhlcCandle[];
    kalshiCandles: OhlcCandle[];
    kalshiCandles5m?: OhlcCandle[];
    kalshiCandles1m?: OhlcCandle[];
    spotIsFresh: boolean;
    targetPrice: number | null;
    prediction: CandlePrediction | null;
  } | null>(null);

  const filteredMarkets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return markets.filter((m) => {
      if (categoryFilter !== 'All' && m.category !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        m.ticker.toLowerCase().includes(q) ||
        formatPairLabel(m.ticker).toLowerCase().includes(q) ||
        m.title.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q) ||
        (m.pairSymbol?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [markets, searchQuery, categoryFilter]);

  const activeMarket = useMemo(
    () => markets.find((m) => m.ticker === selectedTicker) ?? markets[0],
    [markets, selectedTicker]
  );

  const activeTicker = activeMarket?.ticker ?? '';

  useEffect(() => {
    if (!activeTicker) return;
    let cancelled = false;
    const loadCandles = async () => {
      try {
        const res = await fetch(`/api/candles/${encodeURIComponent(activeTicker)}`);
        if (!res.ok) return;
        const json = (await res.json()) as {
          ticker: string;
          spotCandles: OhlcCandle[];
          spotCandles5m?: OhlcCandle[];
          spotCandles1m?: OhlcCandle[];
          kalshiCandles: OhlcCandle[];
          kalshiCandles5m?: OhlcCandle[];
          kalshiCandles1m?: OhlcCandle[];
          spotIsFresh: boolean;
          targetPrice: number | null;
          prediction: CandlePrediction | null;
        };
        if (!cancelled) {
          setCandleData(json);
        }
      } catch {
        // Keep last candle snapshot
      }
    };
    void loadCandles();
    const timer = window.setInterval(() => {
      void loadCandles();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTicker]);

  const activePrediction =
    (candleData?.ticker === activeTicker ? candleData.prediction : null) ??
    activeMarket?.candlePrediction ??
    null;

  const activeOrderbook = activeMarket ? orderbooks[activeMarket.ticker] : undefined;
  const bookMetrics = activeOrderbook ? calcOrderbookMetrics(activeOrderbook) : null;
  const activeRemaining = activeMarket
    ? formatRemainingTime(activeMarket.closeTime, nowMs)
    : null;

  const defaultLimitPrice = activeMarket
    ? orderAction === 'buy'
      ? orderSide === 'yes'
        ? activeMarket.yesAsk
        : activeMarket.noAsk
      : orderSide === 'yes'
        ? activeMarket.yesBid
        : activeMarket.noBid
    : 50;

  const effectivePriceCents = limitPriceInput !== '' ? Number(limitPriceInput) : defaultLimitPrice;
  const parsedContracts = Math.max(0, Math.round(Number(contractsInput || 0)));
  const estCostUsd = calcContractCost(parsedContracts, effectivePriceCents);
  const estFeeUsd = calcKalshiFee(parsedContracts, effectivePriceCents);

  const handleSelectMarket = (market: KalshiMarket) => {
    onSelectTicker(market.ticker);
    setLimitPriceInput('');
    setOrderMessage(null);
  };

  const handleOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMarket) return;
    setOrderMessage(null);
    const err = await onPlaceManualOrder({
      ticker: activeMarket.ticker,
      side: orderSide,
      action: orderAction,
      contracts: Number(contractsInput),
      priceCents: effectivePriceCents,
      mode: executionMode,
    });
    if (err) {
      setOrderMessage({ type: 'err', text: err });
    } else {
      setOrderMessage({
        type: 'ok',
        text: `Order ${orderAction.toUpperCase()} ${parsedContracts} ${orderSide.toUpperCase()} @ ${effectivePriceCents}¢ tereksekusi.`,
      });
    }
  };

  const maxLevelQty = useMemo(() => {
    if (!activeOrderbook) return 1;
    const all = [...activeOrderbook.yesBids, ...activeOrderbook.noBids].map((l) => l.quantity);
    return Math.max(1, ...all);
  }, [activeOrderbook]);

  return (
    <div className="space-y-4">
      {/* Workspace Toolbar */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 min-w-0">
          <div className="relative w-full sm:w-60">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Cari ticker atau judul market Kalshi"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari ticker atau kontrak..."
              className="pl-9 pr-3 py-1.5 w-full text-sm bg-slate-950 text-slate-100 placeholder:text-slate-500 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-md overflow-x-auto max-w-full" role="group" aria-label="Filter kategori market">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors ${
                  categoryFilter === cat
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onRefreshFeed}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-700 rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busyAction === 'refresh' ? 'animate-spin' : ''}`} />
            <span>Sinkron Kalshi</span>
          </button>
          <button
            type="button"
            onClick={onRunBotCycle}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{busyAction === 'cycle' ? 'Menjalankan...' : 'Jalankan Siklus Bot'}</span>
          </button>
        </div>
      </div>

      {/* Main 2-column Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Left: High-Density Market Table */}
        <div className="xl:col-span-7 bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Pasar Kontrak 15 Menit Kalshi</h2>
              <p className="text-xs text-slate-400">
                {filteredMarkets.length} pair 15m aktif (Kripto, Komoditi, Forex) · Klik baris untuk orderbook & bot
              </p>
            </div>
            <span
              className={`text-xs font-mono whitespace-nowrap shrink-0 ${
                wsConnected ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {wsConnected ? 'Stream WS Real-Time' : 'Menyambungkan WS...'}
            </span>
          </div>

          {filteredMarkets.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm text-slate-400">Tidak ada market Kalshi yang cocok dengan filter.</p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setCategoryFilter('All');
                }}
                className="mt-3 px-3 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 rounded-md hover:bg-slate-800"
              >
                Reset Filter
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-medium text-slate-400">
                    <th className="py-2.5 pl-3.5 pr-2">Kontrak / Ticker</th>
                    <th className="py-2.5 px-2 text-right whitespace-nowrap">YES Bid/Ask</th>
                    <th className="py-2.5 px-2 text-right whitespace-nowrap">NO Bid/Ask</th>
                    <th className="py-2.5 px-2 whitespace-nowrap">Prediksi</th>
                    <th className="py-2.5 px-2 text-right whitespace-nowrap">Sisa</th>
                    <th className="py-2.5 pl-2 pr-3.5 text-right whitespace-nowrap">Vol 24j</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-xs">
                  {filteredMarkets.map((market) => {
                    const isSelected = activeMarket?.ticker === market.ticker;
                    const delta = market.lastPrice - market.previousPrice;
                    const spread = Math.max(0, market.yesAsk - market.yesBid);
                    const remaining = formatRemainingTime(market.closeTime, nowMs);
                    const volLabel =
                      market.volume24h >= 1000
                        ? `${(market.volume24h / 1000).toFixed(1)}K`
                        : market.volume24h.toLocaleString('en-US');
                    const pred = market.candlePrediction;
                    return (
                      <tr
                        key={market.ticker}
                        className={`transition-colors ${
                          isSelected ? 'bg-emerald-950/35' : 'hover:bg-slate-800/50'
                        }`}
                      >
                        <td className="py-2.5 pl-3.5 pr-2 max-w-[215px]">
                          <button
                            type="button"
                            onClick={() => handleSelectMarket(market)}
                            aria-pressed={isSelected}
                            className="text-left w-full focus:outline-none group"
                          >
                            <div className="text-[13px] font-medium text-slate-100 group-hover:text-emerald-300 leading-snug line-clamp-2">
                              {market.title}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-400 font-mono tabular-nums truncate">
                              {formatPairLabel(market.ticker)} · Spr {spread}¢ ·{' '}
                              <span className={delta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {delta >= 0 ? `+${delta}¢` : `${delta}¢`}
                              </span>
                            </div>
                          </button>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className="font-semibold text-emerald-400">{market.yesBid}¢</span>
                          <span className="text-slate-500">/</span>
                          <span className="text-slate-300">{market.yesAsk}¢</span>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className="font-semibold text-red-400">{market.noBid}¢</span>
                          <span className="text-slate-500">/</span>
                          <span className="text-slate-300">{market.noAsk}¢</span>
                        </td>
                        <td className="py-2.5 px-2 font-mono tabular-nums whitespace-nowrap">
                          {pred ? (
                            <span
                              className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${
                                pred.direction === 'BULLISH'
                                  ? 'text-emerald-400'
                                  : pred.direction === 'BEARISH'
                                    ? 'text-red-400'
                                    : 'text-slate-400'
                              }`}
                              title={pred.summary}
                            >
                              {pred.direction === 'BULLISH' ? (
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              ) : pred.direction === 'BEARISH' ? (
                                <ArrowDownRight className="w-3.5 h-3.5" />
                              ) : (
                                <Minus className="w-3 h-3" />
                              )}
                              <span>
                                {pred.direction === 'BULLISH'
                                  ? 'NAIK'
                                  : pred.direction === 'BEARISH'
                                    ? 'TURUN'
                                    : 'NETRAL'}{' '}
                                {pred.confidencePct}%
                              </span>
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td
                          data-testid={`countdown-${market.ticker}`}
                          className={`py-2.5 px-2 text-right font-mono tabular-nums whitespace-nowrap ${
                            remaining.isExpiringSoon ? 'text-amber-400 font-semibold' : 'text-slate-200'
                          }`}
                        >
                          {remaining.formatted}
                        </td>
                        <td className="py-2.5 pl-2 pr-3.5 text-right font-mono tabular-nums text-slate-300 whitespace-nowrap">
                          {volLabel}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: Selected Market Inspector + Orderbook + Quick Order Ticket */}
        {activeMarket && (
          <div className="xl:col-span-5 bg-slate-900 border border-slate-800 rounded-lg divide-y divide-slate-800">
            <div className="p-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-mono tabular-nums text-slate-400">
                  <span>
                    {formatPairLabel(activeMarket.ticker)} · {activeMarket.category} ·{' '}
                    {activeMarket.source === 'kalshi_live' ? 'Feed Kalshi Live' : 'Feed Offline'}
                  </span>
                  {activeRemaining && (
                    <span
                      data-testid="inspector-countdown"
                      className={activeRemaining.isExpiringSoon ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}
                    >
                      · Sisa Waktu {activeRemaining.formatted}
                    </span>
                  )}
                </div>
                <h3 className="mt-1 text-base font-semibold text-slate-100 leading-snug">
                  {activeMarket.title}
                </h3>
                <p className="mt-0.5 text-xs text-slate-400">{activeMarket.subtitle}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums">
                  <span>
                    <span className="text-slate-400">YES </span>
                    <span className="text-emerald-400 font-semibold">Bid {activeMarket.yesBid}¢</span>
                    <span className="text-slate-500"> / </span>
                    <span className="text-slate-200">Ask {activeMarket.yesAsk}¢</span>
                  </span>
                  <span>
                    <span className="text-slate-400">NO </span>
                    <span className="text-red-400 font-semibold">Bid {activeMarket.noBid}¢</span>
                    <span className="text-slate-500"> / </span>
                    <span className="text-slate-200">Ask {activeMarket.noAsk}¢</span>
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenBotForTicker(activeMarket.ticker)}
                className="px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-950/60 border border-emerald-800/70 rounded-md hover:bg-emerald-900/60 whitespace-nowrap shrink-0 transition-colors"
              >
                Buat Bot Market Ini
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  Prediksi Arah 5m &amp; Konfirmasi Entry 1m
                </span>
                <div className="flex flex-wrap items-center gap-1 p-0.5 bg-slate-950 border border-slate-800 rounded-md" role="group" aria-label="Pilih sumber grafik">
                  {(
                    [
                      ['spot5m', 'Candle Spot 5m'],
                      ['spot1m', 'Konfirm 1m'],
                      ['kalshi', 'Candle Kalshi 1m'],
                      ['prob', 'Probabilitas ¢'],
                    ] as const
                  ).map(([tabKey, tabLabel]) => (
                    <button
                      key={tabKey}
                      type="button"
                      onClick={() => setChartTab(tabKey)}
                      className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                        chartTab === tabKey
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tabLabel}
                    </button>
                  ))}
                </div>
              </div>

              {chartTab === 'prob' ? (
                <ProbabilityChart
                  values={activeMarket.priceHistory}
                  unit="cents"
                  height={165}
                  label="Histori Probabilitas YES (¢)"
                />
              ) : (
                <CandlestickChart
                  candles={
                    chartTab === 'kalshi'
                      ? candleData?.ticker === activeTicker
                        ? (candleData.kalshiCandles1m ?? candleData.kalshiCandles)
                        : []
                      : chartTab === 'spot1m'
                        ? candleData?.ticker === activeTicker
                          ? (candleData.spotCandles1m ?? [])
                          : []
                        : candleData?.ticker === activeTicker
                          ? (candleData.spotCandles5m ?? candleData.spotCandles)
                          : []
                  }
                  mode={chartTab === 'kalshi' ? 'kalshi' : 'spot'}
                  timeframe={chartTab === 'spot5m' ? '5m' : '1m'}
                  symbol={activeMarket.pairSymbol ?? formatPairLabel(activeMarket.ticker)}
                  targetPrice={candleData?.targetPrice ?? activeMarket.targetPrice ?? null}
                  prediction={activePrediction}
                  height={185}
                />
              )}

              {activePrediction && (
                <div
                  data-testid="candle-prediction-card"
                  className={`p-3 rounded-md border text-xs space-y-2 ${
                    activePrediction.direction === 'BULLISH'
                      ? 'bg-emerald-950/35 border-emerald-800/70'
                      : activePrediction.direction === 'BEARISH'
                        ? 'bg-red-950/35 border-red-900/70'
                        : 'bg-slate-950/70 border-slate-800'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold">
                      {activePrediction.direction === 'BULLISH' ? (
                        <ArrowUpRight className="w-4 h-4 text-emerald-400" />
                      ) : activePrediction.direction === 'BEARISH' ? (
                        <ArrowDownRight className="w-4 h-4 text-red-400" />
                      ) : (
                        <Minus className="w-4 h-4 text-slate-400" />
                      )}
                      <span
                        className={
                          activePrediction.direction === 'BULLISH'
                            ? 'text-emerald-300'
                            : activePrediction.direction === 'BEARISH'
                              ? 'text-red-300'
                              : 'text-slate-200'
                        }
                      >
                        {activePrediction.direction === 'BULLISH'
                          ? `Prediksi Arah ${(activePrediction.timeframe ?? '5m').toUpperCase()}: NAIK (Saran YES)`
                          : activePrediction.direction === 'BEARISH'
                            ? `Prediksi Arah ${(activePrediction.timeframe ?? '5m').toUpperCase()}: TURUN (Saran NO)`
                            : `Prediksi Arah ${(activePrediction.timeframe ?? '5m').toUpperCase()}: SIDEWAYS / NETRAL`}
                      </span>
                    </div>
                    <span className="font-mono tabular-nums font-semibold text-slate-100">
                      Confidence {activePrediction.confidencePct}%
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 font-mono tabular-nums text-[11px] pt-1 border-t border-slate-800/80">
                    <div>
                      <div className="text-slate-400">Saat Ini → Proyeksi</div>
                      <div className="text-slate-100 font-semibold">
                        {activePrediction.source === 'kalshi_1m' || activePrediction.source === 'kalshi_5m'
                          ? `${Math.round(activePrediction.currentPrice)}¢ → ${Math.round(activePrediction.predictedPrice)}¢`
                          : `${formatSpotPrice(activePrediction.currentPrice, activePrediction.symbol)} → ${formatSpotPrice(activePrediction.predictedPrice, activePrediction.symbol)}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">Proyeksi YES</div>
                      <div className="text-slate-100 font-semibold">
                        {activeMarket.lastPrice}¢ → ~{activePrediction.predictedYesCents}¢
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400">
                        RSI(9) / EMA ({(activePrediction.timeframe ?? '5m').toUpperCase()})
                      </div>
                      <div className="text-slate-100 font-semibold">
                        {activePrediction.rsi.toFixed(0)} · {activePrediction.emaFast >= activePrediction.emaSlow ? 'Bull' : 'Bear'}
                      </div>
                    </div>
                  </div>

                  {activePrediction.patterns.length > 0 && (
                    <div className="text-[11px] text-slate-300">
                      <span className="text-slate-400">Pola {(activePrediction.timeframe ?? '5m').toUpperCase()}: </span>
                      <span className="font-medium text-slate-100">{activePrediction.patterns.join(' · ')}</span>
                    </div>
                  )}
                  <div className="text-[11px] text-slate-400 leading-relaxed">{activePrediction.summary}</div>

                  {activePrediction.confirm1m && (
                    <div
                      data-testid="confirm-1m-panel"
                      className="mt-2 pt-2 border-t border-slate-800/90 space-y-1 text-[11px]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-200">Konfirmasi Entry 1m</span>
                        <span
                          className={`font-mono font-semibold ${
                            activePrediction.direction !== 'NEUTRAL' &&
                            activePrediction.confirm1m.lastCandleDir === activePrediction.direction &&
                            activePrediction.confirm1m.direction !==
                              (activePrediction.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH')
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }`}
                        >
                          {activePrediction.direction !== 'NEUTRAL' &&
                          activePrediction.confirm1m.lastCandleDir === activePrediction.direction &&
                          activePrediction.confirm1m.direction !==
                            (activePrediction.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH')
                            ? `Searah ${activePrediction.direction === 'BULLISH' ? 'NAIK' : 'TURUN'} (Siap Entry)`
                            : 'Menunggu Konfirmasi 1m'}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono tabular-nums text-slate-300">
                        <span>
                          Candle 1m:{' '}
                          <strong
                            className={
                              activePrediction.confirm1m.lastCandleDir === 'BULLISH'
                                ? 'text-emerald-400'
                                : activePrediction.confirm1m.lastCandleDir === 'BEARISH'
                                  ? 'text-red-400'
                                  : 'text-slate-300'
                            }
                          >
                            {activePrediction.confirm1m.lastCandleDir === 'BULLISH'
                              ? 'HIJAU ↑'
                              : activePrediction.confirm1m.lastCandleDir === 'BEARISH'
                                ? 'MERAH ↓'
                                : 'NETRAL'}
                          </strong>
                        </span>
                        <span>
                          EMA5/13 1m:{' '}
                          <strong>
                            {activePrediction.confirm1m.emaFast >= activePrediction.confirm1m.emaSlow ? 'Bull' : 'Bear'}
                          </strong>
                        </span>
                        <span>
                          RSI 1m: <strong>{activePrediction.confirm1m.rsi.toFixed(0)}</strong>
                        </span>
                      </div>
                      <div className="text-slate-400">{activePrediction.confirm1m.summary}</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Dual-Bid Orderbook */}
            {activeOrderbook && bookMetrics && (
              <div className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-2.5">
                  <span className="font-semibold text-slate-200">Order Book Real-Time</span>
                  <span className="font-mono tabular-nums text-slate-400">
                    YES {bookMetrics.bestYesBid}¢/{bookMetrics.bestYesAsk}¢ · NO {bookMetrics.bestNoBid}¢/{bookMetrics.bestNoAsk}¢ · Spread {bookMetrics.spreadCents}¢ · Imb{' '}
                    <span
                      className={
                        bookMetrics.imbalanceRatio >= 0 ? 'text-emerald-400 font-medium' : 'text-red-400 font-medium'
                      }
                    >
                      {bookMetrics.imbalanceRatio >= 0 ? '+' : ''}
                      {Math.round(bookMetrics.imbalanceRatio * 100)}%
                    </span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
                  <div>
                    <div className="flex justify-between text-[11px] text-slate-400 pb-1 border-b border-slate-800">
                      <span>YES Bid</span>
                      <span>Qty</span>
                    </div>
                    <div className="divide-y divide-slate-800/60">
                      {activeOrderbook.yesBids.slice(0, 4).map((lvl, idx) => (
                        <div key={idx} className="relative py-1 flex justify-between items-center">
                          <div
                            className="absolute inset-y-0 right-0 bg-emerald-900/35 pointer-events-none"
                            style={{ width: `${Math.min(100, (lvl.quantity / maxLevelQty) * 100)}%` }}
                          />
                          <span className="relative text-emerald-400 font-medium">{lvl.price}¢</span>
                          <span className="relative text-slate-200">{lvl.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-[11px] text-slate-400 pb-1 border-b border-slate-800">
                      <span>NO Bid</span>
                      <span>Qty</span>
                    </div>
                    <div className="divide-y divide-slate-800/60">
                      {activeOrderbook.noBids.slice(0, 4).map((lvl, idx) => (
                        <div key={idx} className="relative py-1 flex justify-between items-center">
                          <div
                            className="absolute inset-y-0 right-0 bg-red-900/35 pointer-events-none"
                            style={{ width: `${Math.min(100, (lvl.quantity / maxLevelQty) * 100)}%` }}
                          />
                          <span className="relative text-red-400 font-medium">{lvl.price}¢</span>
                          <span className="relative text-slate-200">{lvl.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Quick Order Ticket */}
            <form onSubmit={handleOrderSubmit} className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200">Tiket Eksekusi Manual</span>
                <span className="text-xs text-slate-400 font-mono">
                  Mode: {executionMode === 'live' ? 'Live Kalshi' : 'Paper'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex p-0.5 bg-slate-950 border border-slate-800 rounded-md" role="group" aria-label="Aksi order">
                  <button
                    type="button"
                    onClick={() => setOrderAction('buy')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                      orderAction === 'buy' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Beli (Buy)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderAction('sell')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                      orderAction === 'sell' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Jual (Sell)
                  </button>
                </div>

                <div className="flex p-0.5 bg-slate-950 border border-slate-800 rounded-md" role="group" aria-label="Sisi kontrak">
                  <button
                    type="button"
                    onClick={() => {
                      setOrderSide('yes');
                      setLimitPriceInput('');
                    }}
                    className={`flex-1 py-1.5 text-xs font-semibold rounded transition-colors ${
                      orderSide === 'yes' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    YES {activeMarket.yesAsk}¢
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOrderSide('no');
                      setLimitPriceInput('');
                    }}
                    className={`flex-1 py-1.5 text-xs font-semibold rounded transition-colors ${
                      orderSide === 'no' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    NO {activeMarket.noAsk}¢
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="manual-contracts" className="block text-xs text-slate-400 mb-1">
                    Kontrak
                  </label>
                  <input
                    id="manual-contracts"
                    type="number"
                    min={1}
                    value={contractsInput}
                    onChange={(e) => setContractsInput(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label htmlFor="manual-price" className="block text-xs text-slate-400 mb-1">
                    Harga Limit (¢)
                  </label>
                  <input
                    id="manual-price"
                    type="number"
                    min={1}
                    max={99}
                    value={limitPriceInput === '' ? String(defaultLimitPrice) : limitPriceInput}
                    onChange={(e) => setLimitPriceInput(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums pt-1">
                <span>Estimasi Nilai: ${estCostUsd.toFixed(2)}</span>
                <span>Fee Kalshi: ${estFeeUsd.toFixed(2)}</span>
              </div>

              {orderMessage && (
                <div
                  role="status"
                  className={`p-2.5 text-xs rounded-md border ${
                    orderMessage.type === 'ok'
                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/70'
                      : 'bg-red-950/60 text-red-300 border-red-900/70'
                  }`}
                >
                  {orderMessage.text}
                </div>
              )}

              <button
                type="submit"
                disabled={busyAction !== null}
                className="w-full py-2 px-4 text-sm font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500 disabled:opacity-50 transition-colors"
              >
                {orderAction === 'buy' ? 'Kirim Order Beli' : 'Kirim Order Jual'} {orderSide.toUpperCase()}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
