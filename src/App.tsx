import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bot, CandlestickChart, LayoutDashboard, ShieldCheck, Wallet } from 'lucide-react';
import { BacktestView } from './components/BacktestView';
import { BotFormModal } from './components/BotFormModal';
import { DashboardView } from './components/DashboardView';
import { KpiStrip } from './components/KpiStrip';
import { PortfolioView } from './components/PortfolioView';
import { RiskApiView } from './components/RiskApiView';
import { StrategiesView } from './components/StrategiesView';
import { TerminalView } from './components/TerminalView';
import { getSeriesTicker } from './engine/kalshiMath';
import type {
  ApiConnectionStatus,
  BotConfig,
  ExecutionMode,
  KalshiMarket,
  OrderAction,
  OrderBook,
  OrderSide,
  PortfolioState,
  RealtimeStatePayload,
  RiskLimits,
} from './engine/types';

type NavTab = 'dashboard' | 'terminal' | 'strategies' | 'portfolio' | 'backtest' | 'risk';

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'terminal', label: 'Live Terminal', icon: CandlestickChart },
  { id: 'strategies', label: 'Bot Strategi', icon: Bot },
  { id: 'portfolio', label: 'Portofolio & Order', icon: Wallet },
  { id: 'backtest', label: 'Backtester', icon: Activity },
  { id: 'risk', label: 'Risk & API', icon: ShieldCheck },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [markets, setMarkets] = useState<KalshiMarket[]>([]);
  const [orderbooks, setOrderbooks] = useState<Record<string, OrderBook>>({});
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [apiStatus, setApiStatus] = useState<ApiConnectionStatus | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toastNotice, setToastNotice] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [botModalOpen, setBotModalOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<BotConfig | null>(null);
  const [modalInitialTicker, setModalInitialTicker] = useState<string | undefined>(undefined);

  const serverTimeOffsetMsRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const selectedTickerRef = useRef(selectedTicker);
  selectedTickerRef.current = selectedTicker;

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error('Gagal memuat state bot');
      const data = (await res.json()) as {
        markets: KalshiMarket[];
        orderbooks: Record<string, OrderBook>;
        portfolio: PortfolioState;
        apiStatus: ApiConnectionStatus;
        serverTimeMs?: number;
      };
      if (typeof data.serverTimeMs === 'number') {
        serverTimeOffsetMsRef.current = data.serverTimeMs - Date.now();
        setNowMs(data.serverTimeMs);
      }
      setMarkets(data.markets);
      setOrderbooks(data.orderbooks);
      setPortfolio(data.portfolio);
      setApiStatus(data.apiStatus);
      setSelectedTicker((prev) => prev || data.markets[0]?.ticker || '');
      setLoadError(null);
    } catch {
      setLoadError('Tidak dapat terhubung ke server KalshiBot.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  // Keep 15m countdown clock ticking every 1s synced with serverTimeMs
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now() + serverTimeOffsetMsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Authoritative WebSocket /ws real-time market, orderbook, and bot state stream
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setWsConnected(true);
        setLoadError(null);
        if (selectedTickerRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe_ticker', ticker: selectedTickerRef.current }));
        }
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const payload = JSON.parse(String(event.data)) as RealtimeStatePayload;
          if (typeof payload.serverTimeMs === 'number') {
            serverTimeOffsetMsRef.current = payload.serverTimeMs - Date.now();
            setNowMs(payload.serverTimeMs);
          }
          if (Array.isArray(payload.markets)) {
            setMarkets(payload.markets);
            setSelectedTicker((prev) => {
              if (!prev) return payload.markets[0]?.ticker || '';
              if (payload.markets.some((m) => m.ticker === prev)) return prev;
              const prevSeries = getSeriesTicker(prev);
              const rolled = payload.markets.find(
                (m) => (m.seriesTicker ?? getSeriesTicker(m.ticker)) === prevSeries
              );
              return rolled?.ticker || payload.markets[0]?.ticker || '';
            });
          }
          if (payload.orderbooks) setOrderbooks(payload.orderbooks);
          if (payload.portfolio) setPortfolio(payload.portfolio);
          if (payload.apiStatus) setApiStatus(payload.apiStatus);
          setLoading(false);
          setLoadError(null);
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        wsRef.current = null;
        reconnectTimer = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (selectedTicker && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe_ticker', ticker: selectedTicker }));
    }
  }, [selectedTicker]);

  const handleSelectTicker = async (ticker: string) => {
    setSelectedTicker(ticker);
    try {
      const res = await fetch(`/api/orderbook/${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = (await res.json()) as { orderbook: OrderBook };
        setOrderbooks((prev) => ({ ...prev, [ticker]: data.orderbook }));
      }
    } catch {
      // keep existing orderbook cache
    }
  };

  const handleRefreshFeed = async () => {
    setBusyAction('refresh');
    try {
      const res = await fetch('/api/markets/refresh', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as {
          markets: KalshiMarket[];
          orderbooks: Record<string, OrderBook>;
          apiStatus: ApiConnectionStatus;
          liveOk: boolean;
        };
        setMarkets(data.markets);
        setOrderbooks(data.orderbooks);
        setApiStatus(data.apiStatus);
        setToastNotice(
          data.liveOk
            ? 'Feed market disinkronkan dari Kalshi Trade API v2 (100% Live).'
            : 'Feed publik Kalshi sedang offline — menunggu koneksi data real.'
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunBotCycle = async () => {
    setBusyAction('cycle');
    try {
      const res = await fetch('/api/bots/run-cycle', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as {
          executedCount: number;
          markets: KalshiMarket[];
          orderbooks: Record<string, OrderBook>;
          portfolio: PortfolioState;
        };
        setMarkets(data.markets);
        setOrderbooks(data.orderbooks);
        setPortfolio(data.portfolio);
        setToastNotice(`Siklus bot selesai: ${data.executedCount} order dieksekusi.`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handlePlaceManualOrder = async (payload: {
    ticker: string;
    side: OrderSide;
    action: OrderAction;
    contracts: number;
    priceCents: number;
    mode: ExecutionMode;
    botId?: string | null;
  }): Promise<string | null> => {
    setBusyAction('order');
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { portfolio?: PortfolioState; error?: string };
      if (!res.ok || !data.portfolio) {
        return data.error || 'Gagal mengirim order.';
      }
      setPortfolio(data.portfolio);
      return null;
    } catch {
      return 'Koneksi server gagal saat mengirim order.';
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveBot = async (payload: Partial<BotConfig>, editingId?: string): Promise<string | null> => {
    try {
      const res = await fetch(editingId ? `/api/bots/${editingId}` : '/api/bots', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { portfolio?: PortfolioState; error?: string };
      if (!res.ok || !data.portfolio) {
        return data.error || 'Gagal menyimpan konfigurasi bot.';
      }
      setPortfolio(data.portfolio);
      setToastNotice(editingId ? 'Konfigurasi bot diperbarui.' : 'Bot strategi baru berhasil dibuat.');
      return null;
    } catch {
      return 'Koneksi ke server gagal.';
    }
  };

  const handleToggleBot = async (bot: BotConfig) => {
    setBusyAction(bot.id);
    try {
      const nextStatus = bot.status === 'running' ? 'paused' : 'running';
      const res = await fetch(`/api/bots/${bot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = (await res.json()) as { portfolio?: PortfolioState };
      if (res.ok && data.portfolio) {
        setPortfolio(data.portfolio);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleStepBotTick = async (botId: string) => {
    setBusyAction(botId);
    try {
      const res = await fetch(`/api/bots/${botId}/tick`, { method: 'POST' });
      const data = (await res.json()) as { portfolio?: PortfolioState; note?: string };
      if (res.ok && data.portfolio) {
        setPortfolio(data.portfolio);
        if (data.note) setToastNotice(data.note);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteBot = async (botId: string) => {
    setBusyAction(botId);
    try {
      const res = await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
      const data = (await res.json()) as { portfolio?: PortfolioState };
      if (res.ok && data.portfolio) {
        setPortfolio(data.portfolio);
        setToastNotice('Bot strategi dihapus.');
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeploy15mSuite = async (
    strategy: 'trailing_momentum' | 'candle_prediction' | 'preopen_spike' = 'trailing_momentum'
  ) => {
    setBusyAction('deploy-15m');
    try {
      const res = await fetch('/api/bots/deploy-15m-suite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      const data = (await res.json()) as {
        deployedCount?: number;
        added?: number;
        updated?: number;
        portfolio?: PortfolioState;
        error?: string;
      };
      if (res.ok && data.portfolio) {
        setPortfolio(data.portfolio);
        setToastNotice(
          strategy === 'preopen_spike'
            ? `Strategi Varian B Pre-Open Spike (jeda 5–15 dtk, max 65¢, TP +16¢, Trail +10¢/-2¢, No SL, Hard Close menit 6) ditanamkan pada ${data.deployedCount ?? 15} pair 15m.`
            : strategy === 'candle_prediction'
              ? `Strategi Varian A Baca Candle & Prediksi Arah ditanamkan pada ${data.deployedCount ?? 15} pair 15m.`
              : `Strategi Varian A (Entry 85–91¢ Naik Ketat / Anti Pisau Jatuh + Candle Searah, TP 99¢ atau Settle, No SL) ditanamkan pada ${data.deployedCount ?? 15} pair 15m.`
        );
      } else if (data.error) {
        setToastNotice(data.error);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveRisk = async (
    patch: Partial<RiskLimits> & { executionMode?: ExecutionMode }
  ): Promise<string | null> => {
    try {
      const res = await fetch('/api/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { portfolio?: PortfolioState; error?: string };
      if (!res.ok || !data.portfolio) {
        return data.error || 'Gagal memperbarui risk guardrails.';
      }
      setPortfolio(data.portfolio);
      return null;
    } catch {
      return 'Koneksi ke server gagal.';
    }
  };

  const handleResetPortfolio = async () => {
    const res = await fetch('/api/portfolio/reset', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { portfolio: PortfolioState };
      setPortfolio(data.portfolio);
      setToastNotice('Riwayat dihapus & paper portfolio direset ke saldo awal $20.00 (1 kontrak/order).');
    }
  };

  const handleClearVariantHistory = async (variant: 'A' | 'B') => {
    setBusyAction(`clear-variant-${variant}`);
    try {
      const res = await fetch('/api/portfolio/clear-variant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant }),
      });
      if (res.ok) {
        const data = (await res.json()) as { portfolio: PortfolioState };
        setPortfolio(data.portfolio);
        setToastNotice(`Semua riwayat transaksi & PnL Varian ${variant} berhasil dihapus.`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleTradingControl = async (action: 'live' | 'pause', executionMode?: ExecutionMode) => {
    setBusyAction(`trading-${action}`);
    try {
      const res = await fetch('/api/trading/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, executionMode }),
      });
      const data = (await res.json()) as { portfolio?: PortfolioState; error?: string };
      if (!res.ok || !data.portfolio) {
        setToastNotice(data.error || 'Gagal mengubah status trading.');
        return;
      }
      setPortfolio(data.portfolio);
      setToastNotice(
        action === 'pause'
          ? 'Trading otomatis dijeda (Pause Trade aktif).'
          : `Live Trade aktif (${data.portfolio.executionMode === 'live' ? 'Kalshi Live API' : 'Mode Paper'}).`
      );
    } catch {
      setToastNotice('Koneksi ke server gagal.');
    } finally {
      setBusyAction(null);
    }
  };

  const openCreateBotModal = (ticker?: string) => {
    setEditingBot(null);
    setModalInitialTicker(ticker);
    setBotModalOpen(true);
  };

  const activeNavLabel = NAV_ITEMS.find((n) => n.id === activeTab)?.label ?? 'Live Terminal';

  return (
    <div className="min-h-screen flex bg-slate-950 text-slate-100">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:shrink-0 border-r border-slate-800 bg-slate-900">
        <div className="h-14 px-5 flex items-center border-b border-slate-800">
          <span className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap">
            KalshiBot
          </span>
        </div>

        <nav aria-label="Menu utama" className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-emerald-950/70 text-emerald-300'
                    : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-emerald-400' : 'text-slate-500'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {portfolio && apiStatus && (
          <div className="p-4 border-t border-slate-800 text-xs text-slate-400 space-y-1">
            <div className="font-medium text-slate-200">
              {portfolio.executionMode === 'live' ? 'Mode Live API' : 'Mode Paper Trading'}
            </div>
            <div className="font-mono tabular-nums">
              {portfolio.tradingPaused ? 'Auto-Trade: Dijeda' : 'Auto-Trade: Live'} ·{' '}
              {portfolio.riskLimits.killSwitchActive ? 'Kill Switch ON' : 'Guardrails OK'}
            </div>
            <div className={wsConnected ? 'font-mono text-emerald-400' : 'font-mono text-amber-400'}>
              {wsConnected ? 'Stream WS: Real-Time' : 'Stream WS: Reconnecting'}
            </div>
          </div>
        )}
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: 3 zones separated by gap-8 */}
        <header className="h-14 px-4 lg:px-6 border-b border-slate-800 bg-slate-900 flex items-center justify-between gap-8">
          {/* Zone 1: Brand / Breadcrumb */}
          <div className="font-display text-sm font-semibold text-slate-100 whitespace-nowrap shrink-0">
            <span className="lg:hidden font-bold mr-2">KalshiBot</span>
            <span className="hidden lg:inline text-slate-500 font-normal">Workspace / </span>
            <span>{activeNavLabel}</span>
          </div>

          {/* Zone 2: 4 concise single-line nav links */}
          <nav aria-label="Navigasi cepat" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            {NAV_ITEMS.slice(0, 4).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                  activeTab === item.id
                    ? 'text-slate-100 border-emerald-500'
                    : 'border-transparent hover:text-slate-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: 1 Primary CTA */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => openCreateBotModal(selectedTicker)}
              className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-500 whitespace-nowrap shrink-0 transition-colors"
            >
              + Buat Bot
            </button>
          </div>
        </header>

        {/* Mobile Tab Switcher */}
        <div className="lg:hidden px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center gap-1.5 overflow-x-auto">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <main className="flex-1 p-4 lg:p-6 max-w-[1440px] w-full mx-auto space-y-5">
          {toastNotice && (
            <div
              role="status"
              className="px-4 py-2.5 bg-slate-900 border border-slate-800 rounded-md flex items-center justify-between gap-4 text-xs text-slate-300"
            >
              <span>{toastNotice}</span>
              <button
                type="button"
                onClick={() => setToastNotice(null)}
                className="text-slate-400 hover:text-slate-100 font-medium whitespace-nowrap"
              >
                Tutup
              </button>
            </div>
          )}

          {loading ? (
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 text-center text-sm text-slate-400">
              Memuat data pasar Kalshi & mesin bot...
            </div>
          ) : loadError || !portfolio || !apiStatus ? (
            <div role="alert" className="bg-slate-900 border border-red-900/70 rounded-lg p-6 text-center space-y-3">
              <p className="text-sm text-red-400">{loadError || 'Data portofolio tidak tersedia.'}</p>
              <button
                type="button"
                onClick={fetchState}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-800 border border-slate-700 rounded-md hover:bg-slate-700"
              >
                Coba Lagi
              </button>
            </div>
          ) : (
            <>
              <KpiStrip portfolio={portfolio} markets={markets} />

              {activeTab === 'dashboard' && (
                <DashboardView
                  portfolio={portfolio}
                  apiStatus={apiStatus}
                  onTradingControl={handleTradingControl}
                  onClearVariantHistory={handleClearVariantHistory}
                  busyAction={busyAction}
                />
              )}

              {activeTab === 'terminal' && (
                <TerminalView
                  markets={markets}
                  orderbooks={orderbooks}
                  selectedTicker={selectedTicker}
                  onSelectTicker={handleSelectTicker}
                  onRefreshFeed={handleRefreshFeed}
                  onRunBotCycle={handleRunBotCycle}
                  onPlaceManualOrder={handlePlaceManualOrder}
                  onOpenBotForTicker={(ticker) => openCreateBotModal(ticker)}
                  executionMode={portfolio.executionMode}
                  busyAction={busyAction}
                  nowMs={nowMs}
                  wsConnected={wsConnected}
                />
              )}

              {activeTab === 'strategies' && (
                <StrategiesView
                  bots={portfolio.bots}
                  markets={markets}
                  onCreateBot={() => openCreateBotModal(selectedTicker)}
                  onEditBot={(bot) => {
                    setEditingBot(bot);
                    setBotModalOpen(true);
                  }}
                  onToggleBot={handleToggleBot}
                  onStepBotTick={handleStepBotTick}
                  onDeleteBot={handleDeleteBot}
                  onRunAllCycle={handleRunBotCycle}
                  onDeploy15mSuite={handleDeploy15mSuite}
                  busyAction={busyAction}
                />
              )}

              {activeTab === 'portfolio' && (
                <PortfolioView
                  positions={portfolio.positions}
                  orders={portfolio.orders}
                  markets={markets}
                  executionMode={portfolio.executionMode}
                  onClosePosition={handlePlaceManualOrder}
                  busyAction={busyAction}
                />
              )}

              {activeTab === 'backtest' && <BacktestView markets={markets} />}

              {activeTab === 'risk' && (
                <RiskApiView
                  riskLimits={portfolio.riskLimits}
                  executionMode={portfolio.executionMode}
                  apiStatus={apiStatus}
                  onSaveRisk={handleSaveRisk}
                  onResetPortfolio={handleResetPortfolio}
                />
              )}
            </>
          )}
        </main>
      </div>

      <BotFormModal
        open={botModalOpen}
        onClose={() => setBotModalOpen(false)}
        markets={markets}
        initialTicker={modalInitialTicker}
        editingBot={editingBot}
        hasCredentials={apiStatus?.hasCredentials ?? false}
        onSubmit={handleSaveBot}
      />
    </div>
  );
}
