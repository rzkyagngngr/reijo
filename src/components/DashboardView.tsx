import React, { useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Pause, Play, Trash2 } from 'lucide-react';
import {
  buildCalendarMonthGrid,
  formatContractElapsedMinute,
  formatPairLabel,
  getDateKeyWib,
} from '../engine/kalshiMath';
import type {
  ApiConnectionStatus,
  DailyPnlRecord,
  DailyTradeEntry,
  ExecutionMode,
  PortfolioState,
} from '../engine/types';

function resolveEntryVariant(entry: DailyTradeEntry): 'A' | 'B' | 'MANUAL' {
  if (entry.botName.includes('Manual') && !entry.botId) return 'MANUAL';
  if (
    entry.variant === 'B' ||
    entry.botId?.startsWith('bot-varb-') ||
    entry.botName.includes('Varian B')
  ) {
    return 'B';
  }
  return 'A';
}

interface DashboardViewProps {
  portfolio: PortfolioState;
  apiStatus: ApiConnectionStatus;
  onTradingControl: (action: 'live' | 'pause', executionMode?: ExecutionMode) => Promise<void>;
  onClearVariantHistory?: (variant: 'A' | 'B') => Promise<void>;
  busyAction: string | null;
}

function formatWibDateLabel(dateKey: string): string {
  const todayKey = getDateKeyWib(Date.now());
  const parsed = Date.parse(`${dateKey}T12:00:00+07:00`);
  if (!Number.isFinite(parsed)) return dateKey;
  const formatted = new Intl.DateTimeFormat('id-ID', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(parsed));
  return dateKey === todayKey ? `${formatted} (Hari Ini)` : formatted;
}

function parseDateKeyYearMonth(dateKey: string): { year: number; monthIndex0: number } {
  const [yStr, mStr] = dateKey.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
    return { year: y, monthIndex0: m - 1 };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), monthIndex0: now.getUTCMonth() };
}

function formatWibClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('id-ID', {
    hour12: false,
    timeZone: 'Asia/Jakarta',
  });
}

const WEEKDAY_HEADERS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'] as const;

export const DashboardView: React.FC<DashboardViewProps> = ({
  portfolio,
  apiStatus,
  onTradingControl,
  onClearVariantHistory,
  busyAction,
}) => {
  const todayKey = getDateKeyWib(Date.now());
  const runningBots = portfolio.bots.filter((b) => b.status === 'running').length;
  const isPaused = Boolean(portfolio.tradingPaused) || runningBots === 0;

  const dailyRecords = useMemo<DailyPnlRecord[]>(() => {
    const history = portfolio.dailyHistory ?? {};
    const list = Object.values(history).sort((a, b) => b.date.localeCompare(a.date));
    if (list.length === 0) {
      return [
        {
          date: todayKey,
          realizedPnlUsd: 0,
          feesUsd: 0,
          entriesCount: 0,
          exitsCount: 0,
          wins: 0,
          losses: 0,
          entriesByTicker: {},
          entries: [],
        },
      ];
    }
    return list;
  }, [portfolio.dailyHistory, todayKey]);

  const initialDate = dailyRecords[0]?.date ?? todayKey;
  const [selectedDate, setSelectedDate] = useState<string>(initialDate);
  const [viewedMonth, setViewedMonth] = useState<{ year: number; monthIndex0: number }>(() =>
    parseDateKeyYearMonth(initialDate)
  );
  const [timeFilter, setTimeFilter] = useState<string>('');
  const [pairFilter, setPairFilter] = useState<string>('ALL');
  const [actionFilter, setActionFilter] = useState<string>('ALL');
  const [priceFilter, setPriceFilter] = useState<string>('ALL');
  const [lowFilter, setLowFilter] = useState<string>('ALL');
  const [highFilter, setHighFilter] = useState<string>('ALL');
  const [pnlFilter, setPnlFilter] = useState<string>('ALL');
  const [settleFilter, setSettleFilter] = useState<string>('ALL');
  const [noteFilter, setNoteFilter] = useState<string>('');

  const hasActiveColumnFilter =
    timeFilter.trim() !== '' ||
    pairFilter !== 'ALL' ||
    actionFilter !== 'ALL' ||
    priceFilter !== 'ALL' ||
    lowFilter !== 'ALL' ||
    highFilter !== 'ALL' ||
    pnlFilter !== 'ALL' ||
    settleFilter !== 'ALL' ||
    noteFilter.trim() !== '';

  const resetColumnFilters = () => {
    setTimeFilter('');
    setPairFilter('ALL');
    setActionFilter('ALL');
    setPriceFilter('ALL');
    setLowFilter('ALL');
    setHighFilter('ALL');
    setPnlFilter('ALL');
    setSettleFilter('ALL');
    setNoteFilter('');
  };

  const activeDay = useMemo<DailyPnlRecord>(() => {
    const found = portfolio.dailyHistory?.[selectedDate] ?? dailyRecords.find((d) => d.date === selectedDate);
    if (found) return found;
    return {
      date: selectedDate,
      realizedPnlUsd: 0,
      feesUsd: 0,
      entriesCount: 0,
      exitsCount: 0,
      wins: 0,
      losses: 0,
      entriesByTicker: {},
      entries: [],
    };
  }, [portfolio.dailyHistory, dailyRecords, selectedDate]);

  const calendarGrid = useMemo(
    () => buildCalendarMonthGrid(viewedMonth.year, viewedMonth.monthIndex0, portfolio.dailyHistory, todayKey),
    [viewedMonth.year, viewedMonth.monthIndex0, portfolio.dailyHistory, todayKey]
  );

  const shiftMonth = (deltaMonths: number) => {
    setViewedMonth((prev) => {
      const d = new Date(Date.UTC(prev.year, prev.monthIndex0 + deltaMonths, 1));
      return { year: d.getUTCFullYear(), monthIndex0: d.getUTCMonth() };
    });
  };

  const handleSelectCalendarDate = (dateKey: string) => {
    setSelectedDate(dateKey);
    setViewedMonth(parseDateKeyYearMonth(dateKey));
    resetColumnFilters();
  };

  const buyRefByTradeKey = useMemo(() => {
    const map = new Map<string, DailyTradeEntry>();
    for (const dayRec of dailyRecords) {
      for (const e of dayRec.entries) {
        if (e.action === 'buy') {
          const key = `${e.botId ?? e.botName}::${e.ticker}::${e.side}`;
          if (!map.has(key)) map.set(key, e);
        }
      }
    }
    return map;
  }, [dailyRecords]);

  const uniquePairsForDay = useMemo(() => {
    const set = new Set<string>();
    for (const entry of activeDay?.entries ?? []) {
      set.add(formatPairLabel(entry.ticker));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeDay]);

  const filteredEntries = useMemo(() => {
    const raw = activeDay?.entries ?? [];
    const timeQ = timeFilter.trim().toLowerCase();
    const noteQ = noteFilter.trim().toLowerCase();

    return raw.filter((item) => {
      if (timeQ) {
        const timeStr = new Date(item.createdAt)
          .toLocaleTimeString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' })
          .toLowerCase();
        if (!timeStr.includes(timeQ)) return false;
      }

      if (pairFilter !== 'ALL') {
        const entryVar = resolveEntryVariant(item);
        if (pairFilter === 'MANUAL') {
          if (entryVar !== 'MANUAL') return false;
        } else if (pairFilter === 'VARIAN_A') {
          if (entryVar !== 'A') return false;
        } else if (pairFilter === 'VARIAN_B') {
          if (entryVar !== 'B') return false;
        } else if (formatPairLabel(item.ticker) !== pairFilter) {
          return false;
        }
      }

      if (actionFilter !== 'ALL') {
        if (actionFilter === 'buy' && item.action !== 'buy') return false;
        if (actionFilter === 'sell' && item.action !== 'sell') return false;
        if (actionFilter === 'yes' && item.side !== 'yes') return false;
        if (actionFilter === 'no' && item.side !== 'no') return false;
        if (actionFilter === 'buy_yes' && !(item.action === 'buy' && item.side === 'yes')) return false;
        if (actionFilter === 'buy_no' && !(item.action === 'buy' && item.side === 'no')) return false;
        if (actionFilter === 'sell_yes' && !(item.action === 'sell' && item.side === 'yes')) return false;
        if (actionFilter === 'sell_no' && !(item.action === 'sell' && item.side === 'no')) return false;
      }

      if (priceFilter !== 'ALL') {
        const p = item.priceCents;
        if (priceFilter === 'le_65' && p > 65) return false;
        if (priceFilter === '66_78' && (p < 66 || p > 78)) return false;
        if (priceFilter === '79_80' && (p < 79 || p > 80)) return false;
        if (priceFilter === '81_99' && (p < 81 || p > 99)) return false;
        if (priceFilter === '100' && p !== 100) return false;
      }

      if (lowFilter !== 'ALL') {
        const low = typeof item.lowestBidCents === 'number' ? item.lowestBidCents : null;
        if (low === null) return false;
        if (lowFilter === 'le_10' && low > 10) return false;
        if (lowFilter === 'le_50' && low > 50) return false;
        if (lowFilter === 'le_65' && low > 65) return false;
        if (lowFilter === 'le_70' && low > 70) return false;
        if (lowFilter === 'le_75' && low > 75) return false;
        if (lowFilter === 'ge_76' && low < 76) return false;
      }

      if (highFilter !== 'ALL') {
        const high = typeof item.highestBidCents === 'number' ? item.highestBidCents : null;
        if (high === null) return false;
        if (highFilter === 'ge_99' && high < 99) return false;
        if (highFilter === '95_98' && (high < 95 || high > 98)) return false;
        if (highFilter === '90_94' && (high < 90 || high > 94)) return false;
        if (highFilter === 'le_89' && high > 89) return false;
      }

      if (pnlFilter !== 'ALL') {
        if (pnlFilter === 'profit' && !(item.netPnlUsd !== null && item.netPnlUsd > 0)) return false;
        if (pnlFilter === 'loss' && !(item.netPnlUsd !== null && item.netPnlUsd < 0)) return false;
        if (pnlFilter === 'zero' && item.netPnlUsd !== 0) return false;
      }

      if (settleFilter !== 'ALL') {
        const outcome = item.settleOutcome ?? 'pending';
        const resSide =
          item.settleResultSide ??
          (outcome === 'win' ? item.side : outcome === 'lose' ? (item.side === 'yes' ? 'no' : 'yes') : undefined);
        if (settleFilter === 'win' && outcome !== 'win') return false;
        if (settleFilter === 'lose' && outcome !== 'lose') return false;
        if (settleFilter === 'pending' && outcome !== 'pending') return false;
        if (settleFilter === 'settle_yes' && resSide !== 'yes') return false;
        if (settleFilter === 'settle_no' && resSide !== 'no') return false;
      }

      if (noteQ && !item.reason.toLowerCase().includes(noteQ)) return false;

      return true;
    });
  }, [activeDay, timeFilter, pairFilter, actionFilter, priceFilter, lowFilter, highFilter, pnlFilter, settleFilter, noteFilter]);

  const totalHistoricalPnl = useMemo(
    () => dailyRecords.reduce((sum, d) => sum + d.realizedPnlUsd, 0),
    [dailyRecords]
  );
  const totalHistoricalEntries = useMemo(
    () => dailyRecords.reduce((sum, d) => sum + d.entriesCount, 0),
    [dailyRecords]
  );

  const dayClosedCount = activeDay.wins + activeDay.losses;
  const dayWinRatePct = dayClosedCount > 0 ? (activeDay.wins / dayClosedCount) * 100 : 0;

  const fixSettleStats = useMemo(() => {
    const byContract = new Map<string, 'win' | 'lose' | 'pending'>();
    for (const entry of activeDay.entries) {
      const key = `${entry.ticker}:${entry.side}`;
      const status =
        entry.settleOutcome === 'win' || entry.settleOutcome === 'lose'
          ? entry.settleOutcome
          : 'pending';
      const prev = byContract.get(key);
      if (!prev || prev === 'pending') {
        byContract.set(key, status);
      }
    }
    let wins = 0;
    let losses = 0;
    let pending = 0;
    for (const status of byContract.values()) {
      if (status === 'win') wins += 1;
      else if (status === 'lose') losses += 1;
      else pending += 1;
    }
    return { wins, losses, pending, settled: wins + losses };
  }, [activeDay]);

  const variantDayStats = useMemo(() => {
    const computeFor = (target: 'A' | 'B') => {
      const list = activeDay.entries.filter((e) => resolveEntryVariant(e) === target);
      const buys = list.filter((e) => e.action === 'buy');
      const sells = list.filter((e) => e.action === 'sell');
      const closedKeys = new Set(sells.map((e) => `${e.botId ?? e.botName}::${e.ticker}::${e.side}`));
      const openFees = buys
        .filter((e) => !closedKeys.has(`${e.botId ?? e.botName}::${e.ticker}::${e.side}`))
        .reduce((sum, e) => sum + e.feeUsd, 0);
      const sellNet = sells.reduce((sum, e) => sum + (e.netPnlUsd ?? 0), 0);
      const wins = sells.filter((e) => (e.netPnlUsd ?? 0) > 0).length;
      const losses = sells.filter((e) => (e.netPnlUsd ?? 0) <= 0).length;
      return {
        entries: buys.length,
        exits: sells.length,
        wins,
        losses,
        pnlUsd: Number((sellNet - openFees).toFixed(2)),
      };
    };
    return { A: computeFor('A'), B: computeFor('B') };
  }, [activeDay]);

  const hasVariantBHistory = useMemo(() => {
    const hasDailyB = Object.values(portfolio.dailyHistory ?? {}).some((rec) =>
      rec.entries.some((e) => resolveEntryVariant(e) === 'B')
    );
    const hasOrdersB = portfolio.orders.some(
      (o) => o.botId?.startsWith('bot-varb-') || o.botName.includes('Varian B')
    );
    const hasBotPnlB = portfolio.bots.some(
      (b) =>
        (b.strategy === 'preopen_spike' || b.id.startsWith('bot-varb-')) &&
        (b.tradesExecuted > 0 || b.realizedPnlUsd !== 0)
    );
    return hasDailyB || hasOrdersB || hasBotPnlB;
  }, [portfolio.dailyHistory, portfolio.orders, portfolio.bots]);

  return (
    <div className="space-y-5">
      {/* Global Trading Control Header */}
      <section className="bg-slate-900 border border-slate-800 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-100">
              Dashboard Harian & Kontrol Trading
            </h2>
            <span
              className={`px-2 py-0.5 text-[11px] font-mono font-medium rounded border ${
                isPaused
                  ? 'bg-amber-950/60 text-amber-300 border-amber-800/70'
                  : 'bg-emerald-950/60 text-emerald-300 border-emerald-800/70'
              }`}
            >
              {isPaused
                ? 'TRADING DIJEDA (PAUSED)'
                : `LIVE TRADE AKTIF (${runningBots}/${portfolio.bots.length} BOT)`}
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Pantau realisasi PnL per hari, rincian entry di hari terpilih, serta aktifkan atau jeda eksekusi bot otomatis secara langsung.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-md">
            <button
              type="button"
              disabled={busyAction !== null || portfolio.executionMode === 'paper'}
              onClick={() => onTradingControl(isPaused ? 'pause' : 'live', 'paper')}
              className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap transition-colors ${
                portfolio.executionMode === 'paper'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Paper Mode
            </button>
            <button
              type="button"
              disabled={busyAction !== null || !apiStatus.hasCredentials}
              title={
                apiStatus.hasCredentials
                  ? 'Gunakan Kalshi Live API'
                  : 'Konfigurasi KALSHI_API_KEY_ID & KALSHI_PRIVATE_KEY di server untuk Live API'
              }
              onClick={() => onTradingControl(isPaused ? 'pause' : 'live', 'live')}
              className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap transition-colors disabled:opacity-45 ${
                portfolio.executionMode === 'live'
                  ? 'bg-emerald-900/70 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Kalshi Live API
            </button>
          </div>

          <button
            type="button"
            disabled={busyAction !== null || !isPaused}
            onClick={() => onTradingControl('live')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md whitespace-nowrap shrink-0 transition-colors ${
              !isPaused
                ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/70 cursor-default'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            } disabled:opacity-65`}
          >
            <Play className="w-3.5 h-3.5" />
            <span>{!isPaused ? 'Live Trade Berjalan' : 'Live Trade'}</span>
          </button>

          <button
            type="button"
            disabled={busyAction !== null || isPaused}
            onClick={() => onTradingControl('pause')}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md border whitespace-nowrap shrink-0 transition-colors ${
              isPaused
                ? 'bg-amber-950/70 text-amber-300 border-amber-700/70 cursor-default'
                : 'bg-slate-950 text-amber-300 border-amber-800/70 hover:bg-amber-950/50'
            } disabled:opacity-65`}
          >
            <Pause className="w-3.5 h-3.5" />
            <span>{isPaused ? 'Trade Dijeda' : 'Pause Trade'}</span>
          </button>
        </div>
      </section>

      {/* Calendar Daily PnL Overview */}
      <section className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-emerald-400" />
              <span>Kalender PnL Per Hari (WIB)</span>
            </h3>
            <p className="text-xs text-slate-400">
              Pilih tanggal pada kalender untuk melihat rincian entry pada hari tersebut
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between md:justify-end gap-3">
            <div className="text-left md:text-right font-mono tabular-nums text-xs">
              <span className="text-slate-400">Bulan ini: </span>
              <span
                className={`font-semibold ${
                  calendarGrid.monthPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {calendarGrid.monthPnlUsd >= 0 ? '+' : '-'}${Math.abs(calendarGrid.monthPnlUsd).toFixed(2)}
              </span>
              <span className="text-slate-500">
                {' '}
                · {calendarGrid.monthEntries}E · Total{' '}
                {totalHistoricalPnl >= 0 ? '+' : '-'}${Math.abs(totalHistoricalPnl).toFixed(2)} (
                {totalHistoricalEntries}E)
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Bulan sebelumnya"
                onClick={() => shiftMonth(-1)}
                className="p-1.5 rounded-md bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="min-w-[132px] text-center text-xs font-semibold text-slate-100 px-2">
                {calendarGrid.monthLabel}
              </div>
              <button
                type="button"
                aria-label="Bulan berikutnya"
                onClick={() => shiftMonth(1)}
                className="p-1.5 rounded-md bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => handleSelectCalendarDate(todayKey)}
                className="ml-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-slate-950 border border-slate-800 text-emerald-300 hover:bg-emerald-950/60 hover:border-emerald-800 transition-colors"
              >
                Hari Ini
              </button>
            </div>
          </div>
        </div>

        {/* Weekday Headers */}
        <div className="grid grid-cols-7 border-b border-slate-800 bg-slate-950/70">
          {WEEKDAY_HEADERS.map((dayName) => (
            <div
              key={dayName}
              className="py-2 px-2 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            >
              {dayName}
            </div>
          ))}
        </div>

        {/* Monthly Grid */}
        <div className="grid grid-cols-7 bg-slate-800 gap-px">
          {calendarGrid.cells.map((cell) => {
            const rec = cell.record;
            const hasActivity = Boolean(
              rec && (rec.entriesCount > 0 || rec.exitsCount > 0 || rec.realizedPnlUsd !== 0)
            );
            const selected = cell.dateKey === selectedDate;
            const closed = rec ? rec.wins + rec.losses : 0;
            const wr = closed > 0 && rec ? Math.round((rec.wins / closed) * 100) : 0;
            const pnlPositive = rec ? rec.realizedPnlUsd >= 0 : true;

            return (
              <button
                key={cell.dateKey}
                type="button"
                aria-pressed={selected}
                aria-label={
                  hasActivity && rec
                    ? `Tanggal ${cell.dateKey}, PnL ${pnlPositive ? '+' : '-'}$${Math.abs(rec.realizedPnlUsd).toFixed(2)}, ${rec.entriesCount} entry`
                    : `Tanggal ${cell.dateKey}, belum ada trade`
                }
                onClick={() => handleSelectCalendarDate(cell.dateKey)}
                className={`min-h-[68px] sm:min-h-[86px] p-1 sm:p-2.5 flex flex-col justify-between text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  selected
                    ? 'bg-emerald-950/45 ring-2 ring-inset ring-emerald-500'
                    : cell.inCurrentMonth
                      ? hasActivity
                        ? 'bg-slate-900 hover:bg-slate-800/80'
                        : 'bg-slate-950/70 hover:bg-slate-900/80'
                      : 'bg-slate-950/40 text-slate-600 hover:bg-slate-900/50'
                }`}
              >
                <div className="flex items-center justify-between gap-1 w-full">
                  <span
                    className={`text-[11px] sm:text-xs font-mono tabular-nums font-semibold ${
                      selected
                        ? 'text-emerald-300'
                        : cell.isToday
                          ? 'text-emerald-400'
                          : cell.inCurrentMonth
                            ? 'text-slate-200'
                            : 'text-slate-600'
                    }`}
                  >
                    {cell.dayNumber}
                  </span>
                  {cell.isToday && (
                    <span className="hidden sm:inline text-[10px] font-mono font-medium text-emerald-400">
                      Hari Ini
                    </span>
                  )}
                </div>

                {hasActivity && rec ? (
                  <div className="space-y-0.5 w-full mt-1">
                    <div
                      className={`text-[10px] sm:text-sm font-mono tabular-nums tracking-tight sm:tracking-normal font-semibold truncate ${
                        pnlPositive ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {pnlPositive ? '+' : '-'}${Math.abs(rec.realizedPnlUsd).toFixed(2)}
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-slate-400 truncate">
                      <span className="sm:hidden">{rec.entriesCount}E</span>
                      <span className="hidden sm:inline">
                        {rec.entriesCount}E{closed > 0 ? ` · ${wr}%` : ''}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] font-mono text-slate-600 mt-1">—</div>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Wide Entries Table Below Calendar */}
      <section className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">
              Rincian Entry Tanggal {activeDay.date}
            </h3>
            <p className="text-xs text-slate-400">
              {formatWibDateLabel(activeDay.date)} · Low 7–13m &amp; Highest Price terus dipantau s/d kontrak berakhir walau sudah exit
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasActiveColumnFilter && (
              <button
                type="button"
                onClick={resetColumnFilters}
                className="px-2.5 py-1 text-xs font-medium text-amber-300 bg-amber-950/50 border border-amber-800/70 rounded-md hover:bg-amber-900/50 transition-colors"
              >
                Reset Filter ({filteredEntries.length}/{activeDay.entries.length})
              </button>
            )}

            <div className="flex items-center gap-1 p-0.5 bg-slate-950 border border-slate-800 rounded-md">
              {(
                [
                  ['ALL', 'Semua'],
                  ['buy', 'Entry'],
                  ['sell', 'Exit'],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setActionFilter(val)}
                  className={`px-2 py-1 text-xs font-medium rounded whitespace-nowrap transition-colors ${
                    actionFilter === val
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Selected Day Summary Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-800 border-b border-slate-800 bg-slate-950/50">
          <div className="px-4 py-2.5">
            <div className="text-[11px] text-slate-400">PnL Hari Terpilih</div>
            <div
              className={`text-sm font-mono tabular-nums font-semibold ${
                activeDay.realizedPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {activeDay.realizedPnlUsd >= 0 ? '+' : '-'}${Math.abs(activeDay.realizedPnlUsd).toFixed(2)}
            </div>
          </div>
          <div className="px-4 py-2.5">
            <div className="text-[11px] text-slate-400">Total Entry / Exit</div>
            <div className="text-sm font-mono tabular-nums font-semibold text-slate-100">
              {activeDay.entriesCount} / {activeDay.exitsCount}
            </div>
          </div>
          <div className="px-4 py-2.5">
            <div className="text-[11px] text-slate-400">Win Rate (Exit)</div>
            <div className="text-sm font-mono tabular-nums font-semibold text-slate-100">
              {dayClosedCount > 0 ? `${dayWinRatePct.toFixed(0)}% (${activeDay.wins}W/${activeDay.losses}L)` : '—'}
            </div>
          </div>
          <div className="px-4 py-2.5">
            <div className="text-[11px] text-slate-400">Fix Settle (15m)</div>
            <div className="text-sm font-mono tabular-nums font-semibold text-slate-100">
              {fixSettleStats.settled > 0
                ? `${Math.round((fixSettleStats.wins / fixSettleStats.settled) * 100)}% (${fixSettleStats.wins}W/${fixSettleStats.losses}L)`
                : fixSettleStats.pending > 0
                  ? `${fixSettleStats.pending} Pending`
                  : '—'}
            </div>
          </div>
          <div className="px-4 py-2.5 col-span-2 sm:col-span-1">
            <div className="text-[11px] text-slate-400">Total Fee</div>
            <div className="text-sm font-mono tabular-nums font-semibold text-slate-200">
              ${activeDay.feesUsd.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Varian A vs Varian B Day Comparison */}
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-800 border-b border-slate-800 bg-slate-900/80 text-xs">
          <div className="px-4 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-mono font-semibold text-emerald-400">Varian A</span>
              <span className="text-slate-400"> · Entry 85–91¢ Naik Ketat (Anti Pisau Jatuh) · TP 99¢ (atau Settle) · No SL</span>
            </div>
            <div className="font-mono tabular-nums text-right shrink-0">
              <span className="text-slate-300">
                {variantDayStats.A.entries}E/{variantDayStats.A.exits}X
                {variantDayStats.A.exits > 0
                  ? ` · ${variantDayStats.A.wins}W/${variantDayStats.A.losses}L`
                  : ''}
              </span>{' '}
              <span
                className={`font-semibold ${
                  variantDayStats.A.pnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {variantDayStats.A.pnlUsd >= 0 ? '+' : '-'}${Math.abs(variantDayStats.A.pnlUsd).toFixed(2)}
              </span>
            </div>
          </div>
          <div className="px-4 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-mono font-semibold text-sky-400">Varian B</span>
              <span className="text-slate-400"> · Pre-Open Max 65¢ No SL HC 6m</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="font-mono tabular-nums text-right">
                <span className="text-slate-300">
                  {variantDayStats.B.entries}E/{variantDayStats.B.exits}X
                  {variantDayStats.B.exits > 0
                    ? ` · ${variantDayStats.B.wins}W/${variantDayStats.B.losses}L`
                    : ''}
                </span>{' '}
                <span
                  className={`font-semibold ${
                    variantDayStats.B.pnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {variantDayStats.B.pnlUsd >= 0 ? '+' : '-'}${Math.abs(variantDayStats.B.pnlUsd).toFixed(2)}
                </span>
              </div>
              {onClearVariantHistory && hasVariantBHistory && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onClearVariantHistory('B')}
                  title="Hapus semua riwayat transaksi dan PnL Varian B"
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-red-300 bg-red-950/50 border border-red-800/70 rounded hover:bg-red-900/50 disabled:opacity-50 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Hapus History B</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {activeDay.entries.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            Belum ada catatan entry/exit pada tanggal {activeDay.date}.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-slate-950 border-b border-slate-800">
                <tr className="text-[11px] font-medium text-slate-400 whitespace-nowrap">
                  <th className="pt-2.5 pb-1.5 pl-4 pr-2">Waktu</th>
                  <th className="pt-2.5 pb-1.5 px-2">Pair &amp; Bot</th>
                  <th className="pt-2.5 pb-1.5 px-2">Aksi</th>
                  <th className="pt-2.5 pb-1.5 px-2 text-right">Harga</th>
                  <th
                    className="pt-2.5 pb-1.5 px-2 text-right"
                    title="Harga bid terendah pada jendela menit 07:00–13:00 beserta menit tercapainya"
                  >
                    Low (7–13m)
                  </th>
                  <th
                    className="pt-2.5 pb-1.5 px-2 text-right"
                    title="Harga bid tertinggi pasca entry beserta menit tercapainya"
                  >
                    Highest Price
                  </th>
                  <th className="pt-2.5 pb-1.5 px-2 text-right">Net PnL</th>
                  <th className="pt-2.5 pb-1.5 px-2">Fix Settle</th>
                  <th className="pt-2.5 pb-1.5 pl-2 pr-4">Catatan</th>
                </tr>
                <tr className="bg-slate-950/95 border-t border-slate-800/70">
                  <th className="pb-2 pt-1 pl-4 pr-2 font-normal">
                    <input
                      type="text"
                      aria-label="Filter kolom waktu"
                      value={timeFilter}
                      onChange={(e) => setTimeFilter(e.target.value)}
                      placeholder="Jam"
                      className="w-[62px] px-1.5 py-1 text-[11px] font-mono bg-slate-900 text-slate-200 placeholder:text-slate-500 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    />
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal">
                    <select
                      aria-label="Filter kolom pair"
                      value={pairFilter}
                      onChange={(e) => setPairFilter(e.target.value)}
                      className="w-full max-w-[110px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="VARIAN_A">Varian A</option>
                      <option value="VARIAN_B">Varian B</option>
                      {uniquePairsForDay.map((pair) => (
                        <option key={pair} value={pair}>
                          {pair}
                        </option>
                      ))}
                      <option value="MANUAL">Manual</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal">
                    <select
                      aria-label="Filter kolom aksi"
                      value={actionFilter}
                      onChange={(e) => setActionFilter(e.target.value)}
                      className="w-full max-w-[92px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="buy">ENTRY</option>
                      <option value="sell">EXIT</option>
                      <option value="buy_yes">ENTRY YES</option>
                      <option value="buy_no">ENTRY NO</option>
                      <option value="sell_yes">EXIT YES</option>
                      <option value="sell_no">EXIT NO</option>
                      <option value="yes">Sisi YES</option>
                      <option value="no">Sisi NO</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal text-right">
                    <select
                      aria-label="Filter kolom harga"
                      value={priceFilter}
                      onChange={(e) => setPriceFilter(e.target.value)}
                      className="w-full max-w-[78px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="le_65">&lt;= 65¢</option>
                      <option value="66_78">66–78¢</option>
                      <option value="79_80">79–80¢</option>
                      <option value="81_99">81–99¢</option>
                      <option value="100">100¢</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal text-right">
                    <select
                      aria-label="Filter kolom low 7-13m"
                      value={lowFilter}
                      onChange={(e) => setLowFilter(e.target.value)}
                      className="w-full max-w-[80px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="le_10">&lt;= 10¢</option>
                      <option value="le_50">&lt;= 50¢</option>
                      <option value="le_65">&lt;= 65¢</option>
                      <option value="le_70">&lt;= 70¢</option>
                      <option value="le_75">&lt;= 75¢</option>
                      <option value="ge_76">&gt;= 76¢</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal text-right">
                    <select
                      aria-label="Filter kolom highest price"
                      value={highFilter}
                      onChange={(e) => setHighFilter(e.target.value)}
                      className="w-full max-w-[82px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="ge_99">&gt;= 99¢</option>
                      <option value="95_98">95–98¢</option>
                      <option value="90_94">90–94¢</option>
                      <option value="le_89">&lt;= 89¢</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal text-right">
                    <select
                      aria-label="Filter kolom net pnl"
                      value={pnlFilter}
                      onChange={(e) => setPnlFilter(e.target.value)}
                      className="w-full max-w-[78px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="profit">Profit (+)</option>
                      <option value="loss">Minus (-)</option>
                      <option value="zero">BEP ($0)</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 px-2 font-normal">
                    <select
                      aria-label="Filter kolom fix settle"
                      value={settleFilter}
                      onChange={(e) => setSettleFilter(e.target.value)}
                      className="w-full max-w-[88px] px-1.5 py-1 text-[11px] bg-slate-900 text-slate-200 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    >
                      <option value="ALL">Semua</option>
                      <option value="win">WIN</option>
                      <option value="lose">LOSE</option>
                      <option value="pending">Pending</option>
                      <option value="settle_yes">Settle YES</option>
                      <option value="settle_no">Settle NO</option>
                    </select>
                  </th>
                  <th className="pb-2 pt-1 pl-2 pr-4 font-normal">
                    <input
                      type="text"
                      aria-label="Filter kolom catatan"
                      value={noteFilter}
                      onChange={(e) => setNoteFilter(e.target.value)}
                      placeholder="Cari catatan..."
                      className="w-full min-w-[140px] px-2 py-1 text-[11px] bg-slate-900 text-slate-200 placeholder:text-slate-500 border border-slate-800 rounded focus:outline-none focus:border-emerald-500"
                    />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-xs">
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 px-4 text-center text-slate-400">
                      <div>Tidak ada trade yang cocok dengan filter kolom saat ini.</div>
                      <button
                        type="button"
                        onClick={resetColumnFilters}
                        className="mt-2 px-3 py-1 text-xs font-medium text-emerald-300 bg-emerald-950/60 border border-emerald-800/70 rounded hover:bg-emerald-900/60 transition-colors"
                      >
                        Reset Semua Filter
                      </button>
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((entry) => {
                    const tradeKey = `${entry.botId ?? entry.botName}::${entry.ticker}::${entry.side}`;
                    const buyRef = entry.action === 'buy' ? entry : buyRefByTradeKey.get(tradeKey);
                    const baseEntryPrice = buyRef?.priceCents ?? (entry.action === 'buy' ? entry.priceCents : null);
                    const contractRefIso = buyRef?.createdAt ?? null;

                    const lowCents =
                      typeof entry.lowestBidCents === 'number' ? entry.lowestBidCents : null;
                    const lowDelta =
                      lowCents !== null && baseEntryPrice !== null ? lowCents - baseEntryPrice : null;
                    const lowMinLabel = formatContractElapsedMinute(entry.lowestBidAt, contractRefIso);
                    const lowWibClock = formatWibClock(entry.lowestBidAt);

                    const highCents =
                      typeof entry.highestBidCents === 'number' ? entry.highestBidCents : null;
                    const highDelta =
                      highCents !== null && baseEntryPrice !== null ? highCents - baseEntryPrice : null;
                    const highMinLabel = formatContractElapsedMinute(entry.highestBidAt, contractRefIso);
                    const highWibClock = formatWibClock(entry.highestBidAt);

                    return (
                      <tr key={`${entry.id}-${entry.createdAt}`} className="hover:bg-slate-800/40">
                        <td className="py-2 pl-4 pr-2 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                          {new Date(entry.createdAt).toLocaleTimeString('id-ID', {
                            hour12: false,
                            timeZone: 'Asia/Jakarta',
                          })}
                        </td>
                        <td className="py-2 px-2">
                          <div className="font-mono font-semibold text-slate-100 whitespace-nowrap">
                            {formatPairLabel(entry.ticker)}
                          </div>
                          <div
                            className={`text-[11px] truncate max-w-[160px] ${
                              resolveEntryVariant(entry) === 'B'
                                ? 'text-sky-400'
                                : resolveEntryVariant(entry) === 'A'
                                  ? 'text-emerald-400/90'
                                  : 'text-slate-400'
                            }`}
                          >
                            {resolveEntryVariant(entry) === 'MANUAL'
                              ? 'Manual Ticket'
                              : `Varian ${resolveEntryVariant(entry)} · ${formatPairLabel(entry.ticker)}`}
                          </div>
                        </td>
                        <td className="py-2 px-2 font-mono whitespace-nowrap">
                          <span
                            className={
                              entry.action === 'buy'
                                ? 'text-emerald-400 font-semibold'
                                : 'text-amber-300 font-semibold'
                            }
                          >
                            {entry.action === 'buy' ? 'ENTRY' : 'EXIT'} {entry.side.toUpperCase()}
                          </span>
                          <div className="text-[10px] text-slate-500">{entry.contracts}x</div>
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                          <div>{entry.priceCents}¢</div>
                          <div className="text-[10px] text-slate-500">Fee ${entry.feeUsd.toFixed(2)}</div>
                        </td>
                        <td
                          className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap"
                          title={
                            lowCents !== null && lowMinLabel
                              ? `Low (7–13m): ${lowCents}¢ pada ${lowMinLabel}${lowWibClock ? ` (${lowWibClock} WIB)` : ''}`
                              : undefined
                          }
                        >
                          {lowCents !== null ? (
                            <>
                              <div
                                className={
                                  lowCents <= 68
                                    ? 'text-red-400 font-semibold'
                                    : lowCents <= 75
                                      ? 'text-amber-300 font-medium'
                                      : 'text-slate-200'
                                }
                              >
                                {lowCents}¢
                                {lowDelta !== null && (
                                  <span className="text-[10px] text-slate-500 ml-1">
                                    ({lowDelta > 0 ? `+${lowDelta}` : lowDelta}¢)
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {lowMinLabel ?? '—'}
                              </div>
                            </>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td
                          className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap"
                          title={
                            highCents !== null && highMinLabel
                              ? `Highest Price: ${highCents}¢ pada ${highMinLabel}${highWibClock ? ` (${highWibClock} WIB)` : ''}`
                              : undefined
                          }
                        >
                          {highCents !== null ? (
                            <>
                              <div
                                className={
                                  highCents >= 98
                                    ? 'text-emerald-400 font-semibold'
                                    : highCents >= 93
                                      ? 'text-sky-300 font-medium'
                                      : 'text-slate-200'
                                }
                              >
                                {highCents}¢
                                {highDelta !== null && (
                                  <span className="text-[10px] text-slate-500 ml-1">
                                    ({highDelta > 0 ? `+${highDelta}` : highDelta}¢)
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {highMinLabel ?? '—'}
                              </div>
                            </>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td
                          className={`py-2 px-2 text-right font-mono tabular-nums font-medium whitespace-nowrap ${
                            entry.netPnlUsd === null
                              ? 'text-slate-500'
                              : entry.netPnlUsd >= 0
                                ? 'text-emerald-400'
                                : 'text-red-400'
                          }`}
                        >
                          {entry.netPnlUsd === null
                            ? '—'
                            : `${entry.netPnlUsd >= 0 ? '+' : '-'}$${Math.abs(entry.netPnlUsd).toFixed(2)}`}
                        </td>
                        <td className="py-2 px-2 font-mono whitespace-nowrap">
                          {entry.settleOutcome === 'win' ? (
                            <>
                              <div className="text-emerald-400 font-semibold">WIN</div>
                              <div className="text-[10px] text-slate-400">
                                Settle {(entry.settleResultSide ?? entry.side).toUpperCase()}
                              </div>
                            </>
                          ) : entry.settleOutcome === 'lose' ? (
                            <>
                              <div className="text-red-400 font-semibold">LOSE</div>
                              <div className="text-[10px] text-slate-400">
                                Settle {(entry.settleResultSide ?? (entry.side === 'yes' ? 'no' : 'yes')).toUpperCase()}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-slate-400">Pending</div>
                              <div className="text-[10px] text-slate-500">Tunggu settle</div>
                            </>
                          )}
                        </td>
                        <td
                          className="py-2 pl-2 pr-4 text-[11px] text-slate-400 max-w-[340px] truncate"
                          title={entry.reason}
                        >
                          {entry.reason}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
