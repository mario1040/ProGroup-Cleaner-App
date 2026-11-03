import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle,
  Info,
  LayoutDashboard,
  Loader2,
  Lock,
  Sparkles,
  User,
} from "lucide-react";
import {
  getCurrentUserProfile,
  loginUser,
  logoutUser,
} from "./lib/api";
import type { Profile } from "./types";
import TodayTasksPage from "./components/TodayTasksPage";
import MyKpiPage from "./components/MyKpiPage";
import AdminDashboard from "./components/AdminDashboard";
import ProfessorLogo from "./components/ProfessorLogo";
import FirebaseDiagnosticTool from "./components/FirebaseDiagnosticTool";
import SwitchLabelsGuide from "./components/SwitchLabelsGuide";
import SystemDocumentationGuide from "./components/SystemDocumentationGuide";
import FirestoreQuotaBanner from "./components/FirestoreQuotaBanner";

type SessionSummary = {
  id: string;
  username: string;
  role: Profile["role"];
};

const SESSION_KEY = "naris_ops_session";
const LEGACY_SESSION_KEY = "naris_ops_user";
const DEFAULT_DOMAIN = "narisops.com";

function makeProfileEmail(username: string): string {
  const clean = username.trim().toLowerCase();
  return clean.includes("@") ? clean : `${clean}@${DEFAULT_DOMAIN}`;
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.username === "string" &&
    (v.role === "admin" || v.role === "cleaner" || v.role === "supervisor")
  );
}

function toSessionSummary(profile: Profile): SessionSummary {
  return {
    id: profile.id,
    username: profile.username,
    role: profile.role,
  };
}

function parseStoredSession(raw: string | null): SessionSummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSessionSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [user, setUser] = useState<Profile | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showPublicGuide, setShowPublicGuide] = useState(false);

  const [cleanerView, setCleanerView] = useState<"tasks" | "kpis" | "switch_guide" | "documentation">("tasks");
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleProjectChangedSignOut = () => {
      setUser(null);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("project_changed_sign_out", handleProjectChangedSignOut);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("project_changed_sign_out", handleProjectChangedSignOut);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      setAuthLoading(true);

      try {
        const raw = localStorage.getItem(SESSION_KEY) ?? localStorage.getItem(LEGACY_SESSION_KEY);
        const stored = parseStoredSession(raw);

        if (!stored) {
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(LEGACY_SESSION_KEY);
          if (!cancelled) setUser(null);
          return;
        }

        const current = await getCurrentUserProfile(makeProfileEmail(stored.username));
        if (!current || current.is_active !== true) {
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(LEGACY_SESSION_KEY);
          if (!cancelled) setUser(null);
          return;
        }

        if (!cancelled) setUser(current);
      } catch (e) {
        console.error("Failed to restore session profile", e);
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(LEGACY_SESSION_KEY);
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let checking = false;

    const clearInvalidSession = () => {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_SESSION_KEY);
      if (!cancelled) {
        setUser(null);
        setCleanerView("tasks");
        setError("تم تعطيل هذا الحساب. تم تسجيل خروجك لحماية النظام.");
      }
    };

    const revalidateActiveSession = async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const current = await getCurrentUserProfile(makeProfileEmail(user.username));
        if (!current || current.is_active !== true) {
          clearInvalidSession();
          return;
        }
        if (!cancelled) setUser(current);
      } catch (error) {
        // A transient network failure must not silently deactivate a valid user.
        console.warn("Active session revalidation failed; keeping the current session temporarily.", error);
      } finally {
        checking = false;
      }
    };

    const interval = window.setInterval(() => void revalidateActiveSession(), 60_000);
    window.addEventListener("focus", revalidateActiveSession);
    document.addEventListener("visibilitychange", revalidateActiveSession);
    void revalidateActiveSession();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidateActiveSession);
      document.removeEventListener("visibilitychange", revalidateActiveSession);
    };
  }, [user?.id, user?.username]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(null), 2500);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanUsername = username.trim();
    if (!cleanUsername) {
      setError("يرجى إدخال اسم المستخدم");
      return;
    }
    if (!password) {
      setError("يرجى إدخال كلمة المرور");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const profile = await loginUser(cleanUsername, password);
      setUser(profile);
      localStorage.setItem(SESSION_KEY, JSON.stringify(toSessionSummary(profile)));
      localStorage.removeItem(LEGACY_SESSION_KEY);
      setPassword("");
      setSuccessMessage("تم تسجيل الدخول بنجاح");
    } catch (err: any) {
      setError(err?.message || "فشل تسجيل الدخول. اسم المستخدم أو كلمة المرور غير صحيحة");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await logoutUser();
    } catch (e) {
      console.error(e);
    } finally {
      setUser(null);
      setUsername("");
      setPassword("");
      setCleanerView("tasks");
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_SESSION_KEY);
      setLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
          <span className="text-sm font-bold">جاري تحميل النظام والتحقق من الهوية...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans antialiased rtl-grid text-right flex flex-col">
      {!isOnline && (
        <div className="bg-rose-600 text-white px-4 py-2.5 text-xs md:text-sm font-bold flex items-center justify-between shadow-md border-b border-rose-700 gap-4 z-50">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-white shrink-0 animate-pulse" />
            <span>
              <strong>انقطاع الاتصال بالإنترنت:</strong> النظام يعمل بنمط السحابة المباشر (Online-Only). يرجى التحقق من اتصال شبكة الإنترنت لضمان إرسال وتحديث المهام والصور.
            </span>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="bg-slate-900 hover:bg-slate-800 text-white px-2.5 py-1 rounded-lg text-[10px] md:text-xs transition font-bold shrink-0 cursor-pointer"
          >
            إعادة المحاولة
          </button>
        </div>
      )}
      {isOnline && !user && <FirestoreQuotaBanner onRetry={() => window.location.reload()} />}
      {!user ? (
        showPublicGuide ? (
          <SystemDocumentationGuide onBack={() => setShowPublicGuide(false)} initialRole="all" />
        ) : (
          <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 px-4 py-12 relative overflow-hidden">
            <div className="absolute w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl -top-12 -right-12" />
            <div className="absolute w-96 h-96 bg-slate-800/20 rounded-full blur-3xl -bottom-12 -left-12" />

            <div className="w-full max-w-md z-10 flex flex-col gap-6">
              <div className="text-center flex flex-col items-center">
                <div className="mb-4 w-4/5 max-w-[280px]">
                  <ProfessorLogo variant="full" light={true} className="h-16" />
                </div>
                <p className="text-xs text-indigo-300 mt-1 font-semibold">
                  نظام تشغيل النظافة والجودة الرقمي الموحد (Naris Ops)
                </p>
              </div>

              <div className="bg-white rounded-2xl shadow-2xl p-6 md:p-8 border border-slate-800">
                <h2 className="text-base font-bold text-slate-800 mb-5 text-center">
                  بوابة الموظفين والمشرفين 🔐
                </h2>

                <form onSubmit={handleLogin} className="flex flex-col gap-4 text-xs font-bold text-slate-600">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-slate-500">اسم المستخدم للتشغيل (Username):</label>
                    <div className="relative">
                      <User className="w-4 h-4 text-slate-400 absolute right-3 top-3.5" />
                      <input
                        type="text"
                        autoComplete="username"
                        required
                        placeholder="أدخل اسمك التقني (مثال: afaf, rehab, admin)"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="w-full pr-10 pl-3 py-3 border border-slate-200 rounded-xl outline-none focus:border-slate-400 font-bold bg-slate-50/50 text-slate-800"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-slate-500">كلمة المرور (Password):</label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute right-3 top-3.5" />
                      <input
                        type="password"
                        autoComplete="current-password"
                        required
                        placeholder="أدخل كلمة المرور"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full pr-10 pl-3 py-3 border border-slate-200 rounded-xl outline-none focus:border-slate-400 bg-slate-50/50 text-slate-800"
                      />
                    </div>
                  </div>

                  {error && (
                    <div className="p-3 bg-red-50 text-red-800 border border-red-100 rounded-xl text-xs font-semibold flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
                      <span>{error}</span>
                    </div>
                  )}

                  {successMessage && (
                    <div className="p-3 bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-xl text-xs font-semibold flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
                      <span>{successMessage}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-700 text-white font-bold py-3.5 rounded-xl cursor-pointer shadow-md shadow-indigo-600/15 transition-all duration-200 flex items-center justify-center gap-2"
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <span>تسجيل الدخول الآمن</span>}
                  </button>
                </form>

                <div className="mt-4 pt-4 border-t border-slate-100 flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => setShowPublicGuide(true)}
                    className="w-full bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-white border border-slate-700 font-bold py-2.5 rounded-xl cursor-pointer transition flex items-center justify-center gap-2 text-xs"
                  >
                    <BookOpen className="w-4 h-4 text-indigo-400" />
                    <span>دليل وشرح المنظومة (لغير التقنيين) 📖</span>
                  </button>

                  <div className="bg-indigo-50/70 p-3 rounded-xl border border-indigo-100 text-[10px] text-indigo-800 leading-relaxed font-bold flex items-start gap-2">
                    <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                    <span>
                      يتم حفظ جلسة خفيفة بدون كلمة المرور، ويتم إعادة التحقق من الملف الشخصي من Firestore عند استعادة الجلسة.
                    </span>
                  </div>
                </div>
              </div>

              <div className="text-center text-[10px] text-slate-500 font-semibold">
                مقر النرجس الرئيسي • Naris Clean Operations Control Panel
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="min-h-screen flex flex-col">
          {user.role === "cleaner" ? (
            cleanerView === "tasks" ? (
              <TodayTasksPage
                user={user}
                onLogout={handleLogout}
                onNavigateToKpis={() => setCleanerView("kpis")}
                onNavigateToSwitchGuide={() => setCleanerView("switch_guide")}
                onNavigateToDocumentation={() => setCleanerView("documentation")}
              />
            ) : cleanerView === "kpis" ? (
              <MyKpiPage user={user} onBack={() => setCleanerView("tasks")} />
            ) : cleanerView === "switch_guide" ? (
              <div className="min-h-screen bg-slate-50 flex flex-col p-2 md:p-4">
                <SwitchLabelsGuide onBack={() => setCleanerView("tasks")} />
              </div>
            ) : (
              <SystemDocumentationGuide onBack={() => setCleanerView("tasks")} initialRole="cleaner" />
            )
          ) : (
            <AdminDashboard user={user} onLogout={handleLogout} />
          )}
        </div>
      )}
      <FirebaseDiagnosticTool />
    </div>
  );
}
