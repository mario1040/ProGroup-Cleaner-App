import React, { useState, useEffect } from "react";
import { 
  ArrowRight, 
  Award, 
  CheckCircle, 
  Clock, 
  TrendingUp, 
  AlertTriangle, 
  User, 
  Sparkles,
  Calendar
} from "lucide-react";
import { Profile } from "../types";
import { getKpis, KpiSummary } from "../lib/api-postgres";
import ProfessorLogo from "./ProfessorLogo";

interface MyKpiPageProps {
  user: Profile;
  onBack: () => void;
}

export default function MyKpiPage({ user, onBack }: MyKpiPageProps) {
  const [kpi, setKpi] = useState<KpiSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadKpis = async () => {
      try {
        setLoading(true);
        const allKpis = await getKpis();
        const myKpi = allKpis.find((k) => k.profile_id === user.id);
        if (myKpi) {
          setKpi(myKpi);
        } else {
          // Fallback static computation in case of no server activity yet
          setKpi({
            profile_id: user.id,
            cleaner_name: user.full_name,
            username: user.username,
            tasks_assigned: 0,
            tasks_completed_on_time: 0,
            tasks_late: 0,
            tasks_reworked: 0,
            tasks_rejected: 0,
            compliance_rate: 0,
            avg_execution_time_minutes: 0,
            quality_score: 0,
            supervisor_rating: 0
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    loadKpis();
  }, [user.id]);

  return (
    <div className="min-h-screen bg-[#F4F6FB] pb-12 font-sans text-right">
      {/* Top Banner */}
      <div className="rounded-b-[2rem] bg-gradient-to-br from-[#101A33] via-[#172554] to-[#312E81] px-4 py-5 text-white shadow-xl shadow-indigo-950/10 sm:p-6">
        <div className="mx-auto w-full max-w-3xl">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-slate-300 hover:text-white text-xs font-bold mb-4 bg-slate-800 py-1.5 px-3 rounded-full border border-slate-700 cursor-pointer"
          >
            <ArrowRight className="w-4 h-4" /> العودة للمهام اليومية
          </button>
          
          <div className="flex items-center gap-3">
            <div className="bg-slate-800 p-1.5 rounded-xl border border-slate-700 flex items-center justify-center">
              <ProfessorLogo variant="icon" className="h-10 w-10" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <ProfessorLogo variant="logo-text" light={true} className="h-4.5" />
                <span className="text-[10px] bg-emerald-500 text-white py-0.5 px-2 rounded-full font-bold">مؤشرات الأداء</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">متابعة دقيقة لنسب الالتزام والجودة المنجزة للعمليات</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-3 flex w-full max-w-3xl flex-col gap-4 px-3 sm:px-5">
        {loading ? (
          <div className="text-center py-20 text-slate-400 font-semibold text-xs">
            جاري احتساب مؤشرات الأداء الحالية...
          </div>
        ) : kpi ? (
          <>
            {/* Best Cleaner Motivational Card */}
            {kpi.compliance_rate >= 90 && (
              <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-2xl flex items-center gap-3.5 shadow-sm">
                <div className="bg-emerald-500 text-white p-2.5 rounded-full shadow-md shrink-0">
                  <Sparkles className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-emerald-800">الأفضل هذا الأسبوع 🏆</h3>
                  <p className="text-xs text-emerald-600 mt-0.5 font-medium">
                    أحسنتِ صنعاً! مجهودك متميز ونسبة التزامك بالوقت تتخطى الـ 90%. فخورون بك!
                  </p>
                </div>
              </div>
            )}

            {/* Compliance Circular Gauge Simulated */}
            <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm text-center">
              <span className="text-xs font-bold text-slate-400 block mb-2">معدل التزامك العام بالتعليمات والوقت</span>
              
              <div className="relative w-32 h-32 mx-auto flex items-center justify-center mt-3">
                {/* SVG Circle Gauge */}
                <svg className="w-full h-full transform -rotate-90">
                  <circle
                    cx="64"
                    cy="64"
                    r="54"
                    stroke="#f1f5f9"
                    strokeWidth="10"
                    fill="transparent"
                  />
                  <circle
                    cx="64"
                    cy="64"
                    r="54"
                    stroke={(kpi.tasks_completed_on_time + kpi.tasks_late + kpi.tasks_reworked + kpi.tasks_rejected) === 0 ? "#cbd5e1" : kpi.compliance_rate >= 90 ? "#10b981" : kpi.compliance_rate >= 80 ? "#f59e0b" : "#ef4444"}
                    strokeWidth="10"
                    fill="transparent"
                    strokeDasharray={2 * Math.PI * 54}
                    strokeDashoffset={2 * Math.PI * 54 * (1 - ((kpi.tasks_completed_on_time + kpi.tasks_late + kpi.tasks_reworked + kpi.tasks_rejected) === 0 ? 0 : kpi.compliance_rate) / 100)}
                    strokeLinecap="round"
                    className="transition-all duration-1000 ease-out"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  {(kpi.tasks_completed_on_time + kpi.tasks_late + kpi.tasks_reworked + kpi.tasks_rejected) === 0 ? (
                     <span className="text-xs font-bold text-slate-500">لم يتم<br/>التقييم</span>
                  ) : (
                    <>
                      <span className="text-2xl font-extrabold text-slate-800">{kpi.compliance_rate}%</span>
                      <span className="text-[9px] text-slate-400 font-bold block">معدل الانضباط</span>
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-6 border-t border-slate-100 pt-4">
                <div className="text-right">
                  <span className="text-xs text-slate-400 block">إجمالي المهام المسندة</span>
                  <span className="text-lg font-extrabold text-slate-800">{kpi.tasks_assigned}</span>
                </div>
                <div className="text-right border-r border-slate-100 pr-3">
                  <span className="text-xs text-slate-400 block">منجزة بالوقت المحدد</span>
                  <span className="text-lg font-extrabold text-emerald-600">{kpi.tasks_completed_on_time}</span>
                </div>
              </div>
            </div>

            {/* Multi Stats Grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm flex items-start gap-3">
                <div className="bg-indigo-50 text-indigo-600 p-2 rounded-xl border border-indigo-100 shrink-0">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">سرعة العمل</span>
                  <span className="text-sm font-bold text-slate-800 block mt-0.5">
                    {(kpi.tasks_completed_on_time + kpi.tasks_late + kpi.tasks_reworked + kpi.tasks_rejected) === 0 ? "-" : `${kpi.avg_execution_time_minutes} دقيقة`}
                  </span>
                  <span className="text-[9px] text-slate-400 block">متوسط تنفيذ البند الواحد</span>
                </div>
              </div>

              <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm flex items-start gap-3">
                <div className="bg-amber-50 text-amber-600 p-2 rounded-xl border border-amber-100 shrink-0">
                  <CheckCircle className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">متوسط الجودة</span>
                  <span className="text-sm font-bold text-slate-800 block mt-0.5">
                    {(kpi.tasks_completed_on_time + kpi.tasks_late + kpi.tasks_reworked + kpi.tasks_rejected) === 0 ? "-" : `${kpi.quality_score}%`}
                  </span>
                  <span className="text-[9px] text-slate-400 block">تقييم المشرف لمهامك</span>
                </div>
              </div>

              <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm flex items-start gap-3">
                <div className="bg-rose-50 text-rose-600 p-2 rounded-xl border border-rose-100 shrink-0">
                  <AlertTriangle className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">المهام المتأخرة</span>
                  <span className="text-sm font-bold text-slate-800 block mt-0.5">{kpi.tasks_late}</span>
                  <span className="text-[9px] text-slate-400 block">تجاوزت وقت التسليم</span>
                </div>
              </div>

              <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm flex items-start gap-3">
                <div className="bg-purple-50 text-purple-600 p-2 rounded-xl border border-purple-100 shrink-0">
                  <AlertTriangle className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">إعادات التنفيذ</span>
                  <span className="text-sm font-bold text-slate-800 block mt-0.5">{kpi.tasks_reworked}</span>
                  <span className="text-[9px] text-slate-400 block">تم طلب إعادتها</span>
                </div>
              </div>
            </div>

            {/* Performance Goals Guidelines */}
            <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm">
              <h3 className="text-xs font-bold text-slate-800 mb-3 flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-blue-500" /> نصائح لرفع تقييمك الشهري:
              </h3>
              <ul className="flex flex-col gap-2 text-xs text-slate-500 leading-relaxed pr-2 list-disc">
                <li>احرصي على بدء المهام فور تكليفك بها لتجنب أي تأخيرات مفاجئة.</li>
                <li>تأكدي من تصوير حالة المكان قبل وبعد التنظيف بإضاءة جيدة وزاوية واضحة.</li>
                <li>اتباع بنود الـ SOP ومعدات التنظيف المخصصة لكل غرفة يضمن تقييم جودة (A).</li>
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
