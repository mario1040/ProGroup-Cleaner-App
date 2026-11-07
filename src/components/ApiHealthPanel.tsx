import React, { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle, AlertTriangle, RefreshCw, Database } from "lucide-react";
import { API_BASE_URL } from "../lib/api-config";

type HealthState = {
  live: "unknown" | "ok" | "error";
  database: "unknown" | "connected" | "error";
  ready: "unknown" | "ready" | "not_ready" | "error";
  missing: string[];
  message?: string;
  checkedAt?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEALTH_REQUEST_OPTIONS: RequestInit = {
  cache: "no-store",
  credentials: "omit",
  headers: { Accept: "application/json" },
};

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("الخادم لم يُرجع JSON؛ تحقق من عنوان API وNginx/Preview.");
  }
  return response.json();
}

export default function ApiHealthPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<HealthState>({
    live: "unknown", database: "unknown", ready: "unknown", missing: [],
  });

  const checkHealth = useCallback(async () => {
    setLoading(true);
    const errors: string[] = [];

    try {
      const [liveResult, dbResult, readyResult] = await Promise.allSettled([
        fetch(API_BASE_URL + "/health/live", HEALTH_REQUEST_OPTIONS),
        fetch(API_BASE_URL + "/health/db", HEALTH_REQUEST_OPTIONS),
        fetch(API_BASE_URL + "/health/ready", HEALTH_REQUEST_OPTIONS),
      ]);

      let live: HealthState["live"] = "error";
      let database: HealthState["database"] = "error";
      let ready: HealthState["ready"] = "error";
      let missing: string[] = [];

      if (liveResult.status === "fulfilled") {
        const response = liveResult.value;
        const payload = await readJson(response).catch(() => null);
        live = response.ok && isRecord(payload) && payload.ok === true && payload.status === "ok"
          ? "ok" : "error";
        if (live === "error") errors.push("فحص API process لم يُرجع عقد الاستجابة الصحيح.");
      } else {
        errors.push("تعذر الوصول إلى API: " + String(liveResult.reason));
      }

      if (dbResult.status === "fulfilled") {
        const response = dbResult.value;
        const payload = await readJson(response).catch(() => null);
        database = response.ok && isRecord(payload) && payload.ok === true && payload.database === "connected"
          ? "connected" : "error";
        if (database === "error") errors.push("فشل فحص اتصال PostgreSQL.");
      } else {
        errors.push("تعذر فحص اتصال PostgreSQL: " + String(dbResult.reason));
      }

      if (readyResult.status === "fulfilled") {
        const response = readyResult.value;
        const payload = await readJson(response).catch(() => null);
        if (isRecord(payload) && Array.isArray(payload.missingTables)) {
          missing = payload.missingTables.filter((item): item is string => typeof item === "string");
        }

        const checks = isRecord(payload) && isRecord(payload.checks) ? payload.checks : {};
        if (response.ok && isRecord(payload) && payload.ok === true &&
          payload.status === "ready" && payload.database === "connected" &&
          checks.connection === true && checks.query === true && checks.requiredTables === true) {
          ready = "ready";
        } else if (response.status === 503 && isRecord(payload) && payload.status === "not_ready") {
          ready = "not_ready";
          errors.push(missing.length
            ? "جداول PostgreSQL المطلوبة غير موجودة: " + missing.join(", ")
            : "قاعدة البيانات أو الـ schema غير جاهزين.");
        } else {
          ready = "error";
          errors.push(isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "فحص Database schema أعاد استجابة غير متوافقة مع العقد المتوقع.");
        }
      } else {
        errors.push("تعذر فحص Database schema: " + String(readyResult.reason));
      }

      setHealth({
        live, database, ready, missing,
        message: errors.length ? errors.join(" | ") : undefined,
        checkedAt: new Date().toLocaleString("ar-EG"),
      });
    } catch (error) {
      setHealth({
        live: "error", database: "error", ready: "error", missing: [],
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
              <span>اتصال PostgreSQL</span>
              <span className={health.database === "connected" ? "text-emerald-600" : "text-rose-600"}>
                {health.database === "connected" ? "متصل" : health.database === "unknown" ? "غير مفحوص" : "فشل"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Database schema</span>
              <span className={health.ready === "ready" ? "text-emerald-600" : "text-amber-600"}>
                {health.ready === "ready" ? "جاهز" : health.ready === "not_ready" ? "غير مكتمل" : "غير متاح"}
              </span>
            </div>
            {health.missing.length > 0 && <p className="text-amber-700">الجداول الناقصة: {health.missing.join(", ")}</p>}
            {health.message && <p className="break-words text-rose-600">{health.message}</p>}
            <p className="break-all text-slate-400">API: {API_BASE_URL || "نفس نطاق الواجهة عبر Nginx"}</p>
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
