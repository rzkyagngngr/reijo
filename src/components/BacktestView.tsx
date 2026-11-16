import React, { useEffect, useState } from 'react';
import { formatPairLabel } from '../engine/kalshiMath';
import type { BacktestResult, KalshiMarket, StrategyType } from '../engine/types';
import { ProbabilityChart } from './ProbabilityChart';

interface BacktestViewProps {
  markets: KalshiMarket[];
}

export const BacktestView: React.FC<BacktestViewProps> = ({ markets }) => {
  const [ticker, setTicker] = useState(markets[0]?.ticker || 'KXBTC15M');

  useEffect(() => {
    if (markets.length > 0 && !markets.some((m) => m.ticker === ticker)) {
      setTicker(markets[0].ticker);
    }
  }, [markets, ticker]);
  const [strategy, setStrategy] = useState<StrategyType>('trailing_momentum');
  const [fairValueCents, setFairValueCents] = useState(String(markets[0]?.lastPrice ?? 85));
  const [entryEdgeCents, setEntryEdgeCents] = useState('4');
  const [takeProfitCents, setTakeProfitCents] = useState('15');
  const [stopLossCents, setStopLossCents] = useState('0');
  const [noStopLoss, setNoStopLoss] = useState(true);
  const [holdToSettle, setHoldToSettle] = useState(false);
  const [useTrailingStop, setUseTrailingStop] = useState(false);
  const [entryTriggerCents, setEntryTriggerCents] = useState('85');
  const [trailingActivationCents, setTrailingActivationCents] = useState('88');
  const [trailingDistanceCents, setTrailingDistanceCents] = useState('2');
  const [takeProfitTargetCents, setTakeProfitTargetCents] = useState('99');
  const [maxEntryPriceCents, setMaxEntryPriceCents] = useState('91');
  const [trailingActivationDeltaCents, setTrailingActivationDeltaCents] = useState('3');
  const [trailingMinProfitCents, setTrailingMinProfitCents] = useState('3');
  const [hardCloseMinute, setHardCloseMinute] = useState('6');
  const [minCandleConfidence, setMinCandleConfidence] = useState('60');
  const [contractsPerTrade, setContractsPerTrade] = useState('1');
  const [initialCapitalUsd, setInitialCapitalUsd] = useState('20');
  const [ticks, setTicks] = useState('48');

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleRunBacktest = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker,
          strategy,
          fairValueCents: Number(fairValueCents),
          entryEdgeCents: Number(entryEdgeCents),
          takeProfitCents: Number(takeProfitCents),
          noStopLoss,
          stopLossCents: noStopLoss ? 0 : Number(stopLossCents),
          entryTriggerCents: Number(entryTriggerCents),
          trailingActivationCents: Number(trailingActivationCents),
          trailingDistanceCents: Number(trailingDistanceCents),
          takeProfitTargetCents: holdToSettle ? 0 : Number(takeProfitTargetCents),
          maxEntryPriceCents: Number(maxEntryPriceCents),
          trailingActivationDeltaCents: Number(trailingActivationDeltaCents),
          trailingMinProfitCents: Number(trailingMinProfitCents),
          hardCloseMinute: Number(hardCloseMinute),
          holdToSettle:
            strategy === 'candle_prediction' || (strategy === 'trailing_momentum' && holdToSettle),
          useTrailingStop,
          minCandleConfidence: Number(minCandleConfidence),
          contractsPerTrade: Number(contractsPerTrade),
          initialCapitalUsd: Number(initialCapitalUsd),
          ticks: Number(ticks),
        }),
      });
      const data = (await res.json()) as { result?: BacktestResult; error?: string };
      if (!res.ok || !data.result) {
        setErrorMsg(data.error || 'Gagal menjalankan backtest.');
      } else {
        setResult(data.result);
      }
    } catch {
      setErrorMsg('Koneksi ke server backtester gagal.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
      <form
        onSubmit={handleRunBacktest}
        className="xl:col-span-4 bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4"
      >
        <div>
          <h2 className="text-base font-semibold text-slate-100">Backtest Data Trade Live Kalshi</h2>
          <p className="text-xs text-slate-400">
            Uji performa parameter bot menggunakan riwayat transaksi live Kalshi & biaya taker asli sebelum diaktifkan.
          </p>
        </div>

        {errorMsg && (
          <div role="alert" className="p-2.5 text-xs text-red-300 bg-red-950/60 border border-red-900/70 rounded-md">
            {errorMsg}
          </div>
        )}

        <div>
          <label htmlFor="bt-ticker" className="block text-xs font-medium text-slate-300 mb-1">
            Market Referensi
          </label>
          <select
            id="bt-ticker"
            value={ticker}
            onChange={(e) => {
              setTicker(e.target.value);
              const m = markets.find((x) => x.ticker === e.target.value);
              if (m) setFairValueCents(String(m.lastPrice));
            }}
            className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {markets.map((m) => (
              <option key={m.ticker} value={m.ticker}>
                {formatPairLabel(m.ticker)} · {m.category} ({m.lastPrice}¢)
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="bt-strategy" className="block text-xs font-medium text-slate-300 mb-1">
            Algoritma Strategi
          </label>
          <select
            id="bt-strategy"
            value={strategy}
            onChange={(e) => {
              const next = e.target.value as StrategyType;
              setStrategy(next);
              if (next === 'preopen_spike') {
                setMaxEntryPriceCents('65');
                setTakeProfitCents('16');
                setNoStopLoss(true);
                setStopLossCents('0');
                setTrailingActivationDeltaCents('10');
                setTrailingDistanceCents('2');
                setHardCloseMinute('6');
                setMinCandleConfidence('58');
              } else if (next === 'trailing_momentum') {
                setEntryTriggerCents('85');
                setMaxEntryPriceCents('91');
                setTrailingActivationCents('88');
                setTakeProfitTargetCents('99');
                setTakeProfitCents('15');
                setHoldToSettle(false);
                setUseTrailingStop(false);
                setNoStopLoss(true);
                setStopLossCents('0');
                setTrailingActivationDeltaCents('3');
                setTrailingMinProfitCents('3');
                setTrailingDistanceCents('2');
                setMinCandleConfidence('60');
              } else {
                setHoldToSettle(next === 'candle_prediction');
                setNoStopLoss(false);
                setStopLossCents('10');
              }
            }}
            className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="trailing_momentum">Varian A · Entry 85–91¢ Naik Ketat + TP 99¢</option>
            <option value="preopen_spike">Varian B · Pre-Open Spike (Max 65¢, No SL, HC 6m)</option>
            <option value="candle_prediction">Varian A · Baca Candle &amp; Prediksi Arah</option>
            <option value="mean_reversion">Mean Reversion</option>
            <option value="orderbook_imbalance">Orderbook Imbalance</option>
            <option value="market_maker">Spread Market Maker</option>
            <option value="momentum_breakout">Momentum Breakout</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {strategy === 'preopen_spike' ? (
            <>
              <div>
                <label htmlFor="bt-max-entry" className="block text-xs font-medium text-slate-300 mb-1">
                  Max Entry (¢)
                </label>
                <input
                  id="bt-max-entry"
                  type="number"
                  min={40}
                  max={80}
                  value={maxEntryPriceCents}
                  onChange={(e) => setMaxEntryPriceCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-tp" className="block text-xs font-medium text-slate-300 mb-1">
                  Target TP (+¢)
                </label>
                <input
                  id="bt-tp"
                  type="number"
                  min={5}
                  max={45}
                  value={takeProfitCents}
                  onChange={(e) => setTakeProfitCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-trail-delta" className="block text-xs font-medium text-slate-300 mb-1">
                  Trail Aktif (+¢)
                </label>
                <input
                  id="bt-trail-delta"
                  type="number"
                  min={3}
                  max={30}
                  value={trailingActivationDeltaCents}
                  onChange={(e) => setTrailingActivationDeltaCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-trail-dist" className="block text-xs font-medium text-slate-300 mb-1">
                  Jarak Trail (-¢)
                </label>
                <input
                  id="bt-trail-dist"
                  type="number"
                  min={1}
                  max={15}
                  value={trailingDistanceCents}
                  onChange={(e) => setTrailingDistanceCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-hard-close" className="block text-xs font-medium text-slate-300 mb-1">
                  Hard Close (Menit)
                </label>
                <input
                  id="bt-hard-close"
                  type="number"
                  min={1}
                  max={14}
                  value={hardCloseMinute}
                  onChange={(e) => setHardCloseMinute(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-min-conf" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Conf (%)
                </label>
                <input
                  id="bt-min-conf"
                  type="number"
                  min={50}
                  max={95}
                  value={minCandleConfidence}
                  onChange={(e) => setMinCandleConfidence(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </>
          ) : strategy === 'trailing_momentum' ? (
            <>
              <div>
                <label htmlFor="bt-trigger" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Entry (¢)
                </label>
                <input
                  id="bt-trigger"
                  type="number"
                  min={50}
                  max={94}
                  value={entryTriggerCents}
                  onChange={(e) => setEntryTriggerCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-max-entry-a" className="block text-xs font-medium text-slate-300 mb-1">
                  Max Entry (¢)
                </label>
                <input
                  id="bt-max-entry-a"
                  type="number"
                  min={50}
                  max={94}
                  value={maxEntryPriceCents}
                  onChange={(e) => setMaxEntryPriceCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-min-conf" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Confidence (%)
                </label>
                <input
                  id="bt-min-conf"
                  type="number"
                  min={50}
                  max={95}
                  value={minCandleConfidence}
                  onChange={(e) => setMinCandleConfidence(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              {!holdToSettle && (
                <>
                  <div>
                    <label htmlFor="bt-tp-target" className="block text-xs font-medium text-slate-300 mb-1">
                      Target Harga TP (¢)
                    </label>
                    <input
                      id="bt-tp-target"
                      type="number"
                      min={50}
                      max={99}
                      value={takeProfitTargetCents}
                      onChange={(e) => setTakeProfitTargetCents(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                  {useTrailingStop && (
                    <>
                      <div>
                        <label htmlFor="bt-trail-act-a" className="block text-xs font-medium text-slate-300 mb-1">
                          Trail Aktif (+¢)
                        </label>
                        <input
                          id="bt-trail-act-a"
                          type="number"
                          min={1}
                          max={30}
                          value={trailingActivationDeltaCents}
                          onChange={(e) => setTrailingActivationDeltaCents(e.target.value)}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label htmlFor="bt-trail-min-a" className="block text-xs font-medium text-slate-300 mb-1">
                          Min Jual Trail (+¢)
                        </label>
                        <input
                          id="bt-trail-min-a"
                          type="number"
                          min={1}
                          max={30}
                          value={trailingMinProfitCents}
                          onChange={(e) => setTrailingMinProfitCents(e.target.value)}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label htmlFor="bt-trail-dist-a" className="block text-xs font-medium text-slate-300 mb-1">
                          Jarak Trail (-¢)
                        </label>
                        <input
                          id="bt-trail-dist-a"
                          type="number"
                          min={1}
                          max={15}
                          value={trailingDistanceCents}
                          onChange={(e) => setTrailingDistanceCents(e.target.value)}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </div>
                    </>
                  )}
                  <label className="col-span-2 flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useTrailingStop}
                      onChange={(e) => setUseTrailingStop(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500"
                    />
                    <span>Aktifkan Trailing Stop (+{trailingActivationDeltaCents || 3}¢/-{trailingDistanceCents || 2}¢)</span>
                  </label>
                </>
              )}
              <label className="col-span-2 flex items-center gap-2 px-3 py-2 bg-slate-950 border border-slate-800 rounded-md text-xs text-slate-300 cursor-pointer">
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
                <span>Tanpa TP · Biarkan sampai Settle</span>
              </label>
            </>
          ) : strategy === 'candle_prediction' ? (
            <>
              <div>
                <label htmlFor="bt-min-conf" className="block text-xs font-medium text-slate-300 mb-1">
                  Min Confidence (%)
                </label>
                <input
                  id="bt-min-conf"
                  type="number"
                  min={50}
                  max={95}
                  value={minCandleConfidence}
                  onChange={(e) => setMinCandleConfidence(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-tp" className="block text-xs font-medium text-slate-300 mb-1">
                  Take Profit (¢)
                </label>
                <input
                  id="bt-tp"
                  type="number"
                  min={1}
                  max={90}
                  value={takeProfitCents}
                  onChange={(e) => setTakeProfitCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="bt-fair" className="block text-xs font-medium text-slate-300 mb-1">
                  Fair Value (¢)
                </label>
                <input
                  id="bt-fair"
                  type="number"
                  min={1}
                  max={99}
                  value={fairValueCents}
                  onChange={(e) => setFairValueCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-edge" className="block text-xs font-medium text-slate-300 mb-1">
                  Entry Edge (¢)
                </label>
                <input
                  id="bt-edge"
                  type="number"
                  min={1}
                  max={40}
                  value={entryEdgeCents}
                  onChange={(e) => setEntryEdgeCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="bt-tp" className="block text-xs font-medium text-slate-300 mb-1">
                  Take Profit (¢)
                </label>
                <input
                  id="bt-tp"
                  type="number"
                  min={1}
                  max={90}
                  value={takeProfitCents}
                  onChange={(e) => setTakeProfitCents(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </>
          )}

          {strategy === 'trailing_momentum' || strategy === 'preopen_spike' ? (
            <div className="col-span-2 flex items-center justify-between gap-2 px-3 py-2 bg-slate-950 border border-slate-800 rounded-md">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={noStopLoss}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setNoStopLoss(checked);
                    setStopLossCents(checked ? '0' : '20');
                  }}
                  className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                />
                <span>Tanpa Stop Loss (No SL)</span>
              </label>
              {!noStopLoss && (
                <input
                  id="bt-sl"
                  aria-label="Stop Loss (¢)"
                  type="number"
                  min={1}
                  max={90}
                  value={stopLossCents}
                  onChange={(e) => setStopLossCents(e.target.value)}
                  className="w-20 px-2 py-1 text-xs font-mono tabular-nums bg-slate-900 text-slate-100 border border-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              )}
            </div>
          ) : (
            <div>
              <label htmlFor="bt-sl" className="block text-xs font-medium text-slate-300 mb-1">
                Stop Loss (¢)
              </label>
              <input
                id="bt-sl"
                type="number"
                min={1}
                max={90}
                value={stopLossCents}
                onChange={(e) => setStopLossCents(e.target.value)}
                className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          )}
          <div>
            <label htmlFor="bt-qty" className="block text-xs font-medium text-slate-300 mb-1">
              Kontrak / Trade
            </label>
            <input
              id="bt-qty"
              type="number"
              min={1}
              value={contractsPerTrade}
              onChange={(e) => setContractsPerTrade(e.target.value)}
              className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="bt-ticks" className="block text-xs font-medium text-slate-300 mb-1">
              Jumlah Tick
            </label>
            <input
              id="bt-ticks"
              type="number"
              min={10}
              max={200}
              value={ticks}
              onChange={(e) => setTicks(e.target.value)}
              className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="bt-cap" className="block text-xs font-medium text-slate-300 mb-1">
              Modal Awal ($)
            </label>
            <input
              id="bt-cap"
              type="number"
              min={1}
              value={initialCapitalUsd}
              onChange={(e) => setInitialCapitalUsd(e.target.value)}
              className="w-full px-3 py-1.5 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2 px-4 text-sm font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Mengambil Data Trade...' : 'Jalankan Backtest'}
        </button>
      </form>

      <div className="xl:col-span-8 bg-slate-900 border border-slate-800 rounded-lg divide-y divide-slate-800">
        {!result ? (
          <div className="p-12 text-center">
            <h3 className="text-sm font-semibold text-slate-100">Belum Ada Hasil Backtest</h3>
            <p className="mt-1 text-xs text-slate-400">
              Atur parameter strategi di panel kiri lalu klik "Jalankan Backtest" untuk menguji pada data trade live Kalshi.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-800">
              <div className="p-4">
                <div className="text-xs text-slate-400">Ekuitas Akhir</div>
                <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                  ${result.finalEquityUsd.toFixed(2)}
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-slate-400">Total Return</div>
                <div
                  className={`mt-1 text-lg font-semibold font-mono tabular-nums ${
                    result.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {result.totalReturnPct >= 0 ? '+' : ''}
                  {result.totalReturnPct.toFixed(2)}%
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-slate-400">Win Rate · Trades</div>
                <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                  {result.winRatePct.toFixed(1)}% ({result.totalTrades})
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-slate-400">Max Drawdown · Fees</div>
                <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-100">
                  -{result.maxDrawdownPct.toFixed(2)}% · ${result.totalFeesUsd.toFixed(2)}
                </div>
              </div>
            </div>

            <div className="p-5">
              <ProbabilityChart
                values={result.equityCurve}
                unit="usd"
                height={200}
                accentColor={result.totalReturnPct >= 0 ? '#10B981' : '#EF4444'}
                label="Kurva Ekuitas Simulasi ($)"
              />
            </div>

            <div className="overflow-x-auto max-h-72">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/60 text-[11px] font-medium text-slate-400">
                    <th className="py-2 px-4">Tick</th>
                    <th className="py-2 px-3">Aksi</th>
                    <th className="py-2 px-3 text-right">Harga</th>
                    <th className="py-2 px-3 text-right">Fee</th>
                    <th className="py-2 px-3 text-right">PnL</th>
                    <th className="py-2 px-4">Catatan Sinyal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-xs">
                  {result.trades.map((tr, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/40">
                      <td className="py-2 px-4 font-mono tabular-nums text-slate-400">#{tr.tickIndex + 1}</td>
                      <td className="py-2 px-3 font-mono font-semibold">
                        <span className={tr.side === 'yes' ? 'text-emerald-400' : 'text-red-400'}>
                          {tr.action.toUpperCase()} {tr.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-200">{tr.priceCents}¢</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-300">${tr.feeUsd.toFixed(2)}</td>
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums font-medium ${
                          tr.action === 'buy'
                            ? 'text-slate-500'
                            : tr.pnlUsd >= 0
                              ? 'text-emerald-400'
                              : 'text-red-400'
                        }`}
                      >
                        {tr.action === 'buy' ? '—' : `${tr.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(tr.pnlUsd).toFixed(2)}`}
                      </td>
                      <td className="py-2 px-4 text-slate-300">{tr.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
