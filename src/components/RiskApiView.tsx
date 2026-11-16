import React, { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ApiConnectionStatus, ExecutionMode, RiskLimits } from '../engine/types';

interface RiskApiViewProps {
  riskLimits: RiskLimits;
  executionMode: ExecutionMode;
  apiStatus: ApiConnectionStatus;
  onSaveRisk: (patch: Partial<RiskLimits> & { executionMode?: ExecutionMode }) => Promise<string | null>;
  onResetPortfolio: () => Promise<void>;
}

export const RiskApiView: React.FC<RiskApiViewProps> = ({
  riskLimits,
  executionMode,
  apiStatus,
  onSaveRisk,
  onResetPortfolio,
}) => {
  const [maxDailyLoss, setMaxDailyLoss] = useState(String(riskLimits.maxDailyLossUsd));
  const [maxExposure, setMaxExposure] = useState(String(riskLimits.maxExposurePerMarketUsd));
  const [maxOpenOrders, setMaxOpenOrders] = useState(String(riskLimits.maxOpenOrders));
  const [selectedMode, setSelectedMode] = useState<ExecutionMode>(executionMode);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setMaxDailyLoss(String(riskLimits.maxDailyLossUsd));
    setMaxExposure(String(riskLimits.maxExposurePerMarketUsd));
    setMaxOpenOrders(String(riskLimits.maxOpenOrders));
    setSelectedMode(executionMode);
  }, [riskLimits.maxDailyLossUsd, riskLimits.maxExposurePerMarketUsd, riskLimits.maxOpenOrders, executionMode]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const err = await onSaveRisk({
      maxDailyLossUsd: Number(maxDailyLoss),
      maxExposurePerMarketUsd: Number(maxExposure),
      maxOpenOrders: Number(maxOpenOrders),
      executionMode: selectedMode,
    });
    if (err) {
      setFeedback({ type: 'err', text: err });
    } else {
      setFeedback({ type: 'ok', text: 'Batas risiko & mode eksekusi berhasil disimpan.' });
    }
  };

  const handleKillSwitch = async () => {
    setFeedback(null);
    const nextState = !riskLimits.killSwitchActive;
    const err = await onSaveRisk({ killSwitchActive: nextState });
    if (err) {
      setFeedback({ type: 'err', text: err });
    } else {
      setFeedback({
        type: nextState ? 'err' : 'ok',
        text: nextState
          ? 'Kill Switch diaktifkan. Semua bot aktif telah dihentikan.'
          : 'Kill Switch dinonaktifkan. Anda dapat mengaktifkan bot kembali.',
      });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      <form
        onSubmit={handleSave}
        className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Risk Guardrails & Kill Switch</h2>
            <p className="text-xs text-slate-400">
              Setiap sinyal bot divalidasi oleh batas risiko ini sebelum order dikirim.
            </p>
          </div>
          <button
            type="button"
            onClick={handleKillSwitch}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md border whitespace-nowrap shrink-0 transition-colors ${
              riskLimits.killSwitchActive
                ? 'bg-red-600 text-white border-red-600 hover:bg-red-500'
                : 'bg-red-950/60 text-red-300 border-red-900/70 hover:bg-red-900/60'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            <span>{riskLimits.killSwitchActive ? 'Nonaktifkan Kill Switch' : 'Aktifkan Kill Switch'}</span>
          </button>
        </div>

        {feedback && (
          <div
            role="status"
            className={`p-3 text-xs rounded-md border ${
              feedback.type === 'ok'
                ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/70'
                : 'bg-red-950/60 text-red-300 border-red-900/70'
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="risk-daily" className="block text-xs font-medium text-slate-300 mb-1">
              Maks Rugi Harian ($)
            </label>
            <input
              id="risk-daily"
              type="number"
              min={10}
              value={maxDailyLoss}
              onChange={(e) => setMaxDailyLoss(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="risk-exp" className="block text-xs font-medium text-slate-300 mb-1">
              Maks Eksposur / Market ($)
            </label>
            <input
              id="risk-exp"
              type="number"
              min={10}
              value={maxExposure}
              onChange={(e) => setMaxExposure(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label htmlFor="risk-orders" className="block text-xs font-medium text-slate-300 mb-1">
              Maks Posisi Terbuka
            </label>
            <input
              id="risk-orders"
              type="number"
              min={1}
              value={maxOpenOrders}
              onChange={(e) => setMaxOpenOrders(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>

        <div>
          <label htmlFor="risk-mode" className="block text-xs font-medium text-slate-300 mb-1">
            Mode Eksekusi Global
          </label>
          <select
            id="risk-mode"
            value={selectedMode}
            onChange={(e) => setSelectedMode(e.target.value as ExecutionMode)}
            className="w-full px-3 py-2 text-sm bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="paper">Paper Trading (Simulasi Lokal + Feed Pasar Kalshi)</option>
            <option value="live" disabled={!apiStatus.hasCredentials}>
              Live Kalshi API v2 {!apiStatus.hasCredentials ? '(Butuh Env Server)' : '(Terkonfigurasi)'}
            </option>
          </select>
        </div>

        <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onResetPortfolio}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-950 border border-slate-700 rounded-md hover:bg-slate-800"
          >
            Reset Paper Portfolio ($20)
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-500"
          >
            Simpan Konfigurasi Risiko
          </button>
        </div>
      </form>

      <section className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-lg p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Integrasi Server Kalshi Trade API v2</h2>
          <p className="text-xs text-slate-400">
            Penandatanganan RSA-PSS SHA-256 berjalan aman di sisi server tanpa mengekspos kunci di browser.
          </p>
        </div>

        <dl className="divide-y divide-slate-800 text-xs">
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="text-slate-400">Environment Target</dt>
            <dd className="font-mono font-medium text-slate-100">{apiStatus.kalshiEnv.toUpperCase()}</dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="text-slate-400">Endpoint API</dt>
            <dd className="font-mono text-slate-300 truncate">{apiStatus.baseUrl}</dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="text-slate-400">Feed Pasar Publik</dt>
            <dd className={`font-medium ${apiStatus.publicFeedOnline ? 'text-emerald-400' : 'text-amber-400'}`}>
              {apiStatus.publicFeedOnline ? 'Terhubung ke Kalshi v2' : 'Mode Simulasi Lokal'}
            </dd>
          </div>
          <div className="py-2.5 flex justify-between gap-4">
            <dt className="text-slate-400">Kredensial RSA-PSS Server</dt>
            <dd className={`font-medium ${apiStatus.hasCredentials ? 'text-emerald-400' : 'text-slate-400'}`}>
              {apiStatus.hasCredentials ? 'Terkonfigurasi' : 'Belum disetel (Paper Mode)'}
            </dd>
          </div>
        </dl>

        <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-md text-xs text-slate-400 space-y-1.5">
          <div className="font-medium text-slate-200">Aktifkan Live / Demo Execution:</div>
          <p>
            Setel variabel environment <code className="font-mono text-slate-200">KALSHI_ENV</code>,{' '}
            <code className="font-mono text-slate-200">KALSHI_API_KEY_ID</code>, dan{' '}
            <code className="font-mono text-slate-200">KALSHI_PRIVATE_KEY</code> pada konfigurasi runtime server.
          </p>
        </div>
      </section>
    </div>
  );
};
