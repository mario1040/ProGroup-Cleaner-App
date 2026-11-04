import React, { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle, AlertTriangle, RefreshCw, Database } from "lucide-react";

type HealthState = {
  live: "unknown" | "ok" | "error";
  ready: "unknown" | "ready" | "not_ready" | "error";
  missing: string[];
  message?: string;
  checkedAt?: string;
};

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export default function FirebaseDiagnosticTool() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<HealthState>({
    live: "unknown", ready: "unknown", missing: [],
  });

  const checkHealth = useCallback(async () => {
    setLoading(true);
    try {
      const [liveResponse, readyResponse] = await Promise.all([
        fetch(API_BASE_URL + "/health/live", { credentials: "include" }),
        fetch(API_BASE_URL + "/health/ready", { credentials: "include" }),
      ]);
      const readyPayload = await readyResponse.json().catch(() => ({}));
      setHealth({
        live: liveResponse.ok ? "ok" : "error",
        ready: readyResponse.ok ? "ready" : readyResponse.status === 503 ? "not_ready" : "error",
        missing: Array.isArray(readyPayload?.missing) ? readyPayload.missing : [],
        message: readyPayload?.error,
        checkedAt: new Date().toLocaleString("ar-EG"),
      });
    } catch (error) {
      setHealth({
        live: "error", ready: "error", missing: [],
        message: error instanceof Error ? error.message : "تعذر الاتصال بالـ API",
        checkedAt: new Date().toLocaleString("ar-EG"),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void checkHealth(); }, [checkHealth]);

  return (
    <div className="fixed bottom-4 left-4 z-[100] font-sans" dir="rtl">
      {open && (
        <div className="mb-3 w-80 rounded-2xl border border-slate-200 bg-white p-4 text-slate-800 shadow-2xl">
          <div className="mb-3 flex items-center gap-2 font-black">
            <Database className="h-5 w-5 text-indigo-600" />
            فحص PostgreSQL API
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span>API process</span>
              <span className={health.live === "ok" ? "text-emerald-600" : "text-rose-600"}>
                {health.live === "ok" ? "يعمل" : health.live === "unknown" ? "غير مفحوص" : "خطأ"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Database schema</span>
              <span className={health.ready === "ready" ? "text-emerald-600" : "text-amber-600"}>
                {health.ready === "ready" ? "جاهز" : health.ready === "not_ready" ? "غير مكتمل" : "غير متاح"}
              </span>
            </div>
            {health.missing.length > 0 && <p className="text-amber-700">الجداول الناقصة: {health.missing.join(", ")}</p>}
            {health.message && <p className="text-rose-600">{health.message}</p>}
            {health.checkedAt && <p className="text-slate-400">آخر فحص: {health.checkedAt}</p>}
          </div>
          <button onClick={() => void checkHealth()} disabled={loading}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            إعادة الفحص
          </button>
        </div>
      )}
      <button onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-full bg-slate-900 px-4 py-3 text-xs font-bold text-white shadow-xl">
        {health.ready === "ready" ? <CheckCircle className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 text-amber-400" />}
        <Activity className="h-4 w-4" />
        حالة النظام
      </button>
    </div>
  );
}
