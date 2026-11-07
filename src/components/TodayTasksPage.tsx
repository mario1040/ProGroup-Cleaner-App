import React, { useState, useEffect, useRef } from "react";
import { 
  CheckCircle2, 
  Clock, 
  Camera, 
  MapPin, 
  Play, 
  Check, 
  AlertTriangle, 
  ChevronLeft, 
  BookOpen, 
  Wrench, 
  FileText, 
  Send,
  Loader2,
  Calendar,
  Sparkles,
  X
} from "lucide-react";
import { Profile, TaskInstance, Zone, TaskTemplate } from "../types";
import { getTasks, listenTodayTasks, updateTask, getLocalDateString, deletePhoto } from "../lib/api-postgres";
import { isOnline } from "../lib/offlineManager";
import { isUsableImageUrl } from "../lib/cloudinary";
import PhotoCapture from "./PhotoCapture";
import ProfessorLogo from "./ProfessorLogo";
import { getTaskStatusLabel } from "../lib/task-status";

const TaskTimer = ({ task }: { task: TaskInstance & { zone?: Zone; template?: TaskTemplate } }) => {
  const [elapsed, setElapsed] = useState<number>(0);

  useEffect(() => {
    if (!task.started_at) return;
    
    if (task.status === "in_progress") {
      const start = new Date(task.started_at).getTime();
      const tick = () => {
        setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
      };
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    } else if (task.status === "completed" && task.completed_at) {
      const start = new Date(task.started_at).getTime();
      const end = new Date(task.completed_at).getTime();
      setElapsed(Math.max(0, Math.floor((end - start) / 1000)));
    } else if (task.started_at) {
      const start = new Date(task.started_at).getTime();
      const end = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
      setElapsed(Math.max(0, Math.floor((end - start) / 1000)));
      if (!task.completed_at) {
        const interval = setInterval(() => {
          setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
        }, 1000);
        return () => clearInterval(interval);
      }
    }
  }, [task.status, task.started_at, task.completed_at]);

  if (!task.started_at) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  if (task.status === "completed") {
    return (
      <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 py-0.5 px-2 rounded-full flex items-center gap-1 border border-emerald-100">
        <Clock className="w-3 h-3" /> تم الإنجاز في {timeString} دقيقة
      </span>
    );
  }

  return (
    <span className="text-[10px] font-bold text-amber-600 bg-amber-50 py-0.5 px-2 rounded-full flex items-center gap-1 border border-amber-200 animate-pulse">
      <Clock className="w-3 h-3" /> جاري التنفيذ: {timeString}
    </span>
  );
};

export const checkPhotoStatus = (url: string | null | undefined): {
  status: 'synced' | 'not_uploaded';
  label: string;
  color: string;
} => {
  if (!url) {
    return { status: 'not_uploaded', label: 'غير مرفوع', color: 'text-slate-400 bg-slate-100 border-slate-200' };
  }
  return { status: 'synced', label: 'مرفوع سحابياً ☁️', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
};

interface TodayTasksPageProps {
  user: Profile;
  onLogout: () => void;
  onNavigateToKpis: () => void;
  onNavigateToSwitchGuide: () => void;
  onNavigateToDocumentation?: () => void;
}

export default function TodayTasksPage({ 
  user, 
  onLogout, 
  onNavigateToKpis,
  onNavigateToSwitchGuide,
  onNavigateToDocumentation
}: TodayTasksPageProps) {
  const [tasks, setTasks] = useState<(TaskInstance & { zone?: Zone; assignee?: Profile; template?: TaskTemplate })[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [selectedTask, setSelectedTask] = useState<(TaskInstance & { zone?: Zone; assignee?: Profile; template?: TaskTemplate }) | null>(null);
  
  // Offline & Synchronization state
  const [isOnlineState, setIsOnlineState] = useState<boolean>(isOnline());
  
  // Executing state
  const [executingStep, setExecutingStep] = useState<'details' | 'before_photo' | 'after_photo' | 'notes_and_submit'>('details');
  const [photoBefore, setPhotoBefore] = useState<string | null>(null);
  const [photoAfter, setPhotoAfter] = useState<string | null>(null);
  const [photoAfterMeta, setPhotoAfterMeta] = useState<{ url: string; publicId: string; size: number; mimeType: string; takenAt: string } | null>(null);
  const [notes, setNotes] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);
  const [activeLightboxImage, setActiveLightboxImage] = useState<string | null>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'warning') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    const handleOnline = () => setIsOnlineState(true);
    const handleOffline = () => setIsOnlineState(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    const interval = setInterval(() => setIsOnlineState(isOnline()), 5000);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(interval);
    };
  }, []);



  useEffect(() => {
    setLoading(true);
    const unsubscribe = listenTodayTasks(user.id, (myTasks) => {
      setTasks(myTasks);
      setLoading(false);
      
      setSelectedTask((prevSelected) => {
        if (!prevSelected) return null;
        const updatedTask = myTasks.find(t => t.id === prevSelected.id);
        return updatedTask || null;
      });
    });

    return () => unsubscribe();
  }, [user.id]);

  const loadTodayTasks = async () => {
    setLoading(true);
    try {
      const allTasks = await getTasks(getLocalDateString());
      const myTasks = allTasks.filter((t) => t.assigned_to === user.id);
      setTasks(myTasks);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  // Filter logic

  // Filter logic
  const filteredTasks = tasks.filter((t) => {
    if (activeTab === "all") return true;
    if (activeTab === "pending") return t.status === "pending";
    if (activeTab === "in_progress") return t.status === "in_progress";
    if (activeTab === "completed") return t.status === "completed";
    if (activeTab === "rework") return t.status === "rejected" || t.task_type === "rework";
    return true;
  });

  const getStatusColor = (status: string, taskType?: string) => {
    if (taskType === "rework") return "bg-purple-100 text-purple-800 border-purple-200";
    switch (status) {
      case "pending": return "bg-gray-100 text-gray-700 border-gray-200";
      case "in_progress": return "bg-amber-100 text-amber-800 border-amber-200";
      case "completed": return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "rejected": return "bg-red-100 text-red-800 border-red-200";
      case "late": return "bg-rose-100 text-rose-800 border-rose-200";
      case "escalated": return "bg-indigo-100 text-indigo-800 border-indigo-200";
      default: return "bg-slate-100 text-slate-700 border-slate-200";
    }
  };

  const getStatusLabel = (status: string, taskType?: string) =>
    getTaskStatusLabel(status, { taskType });

  // Start executing task
  const handleStartTask = async () => {
    if (!selectedTask) return;
    
    let requiresPhotoBefore = selectedTask.requires_photo_before !== undefined
      ? selectedTask.requires_photo_before
      : true;

    // Force photo for operational tasks if it was somehow skipped
    if (selectedTask.title.includes('تشغيل') || selectedTask.title.includes('شاشات') || selectedTask.title.includes('تكييف')) {
      requiresPhotoBefore = true;
    }

    if (requiresPhotoBefore) {
      // Go to take before photo
      setExecutingStep('before_photo');
    } else {
      // Transition immediately to in_progress in API
      try {
        setIsSubmitting(true);
        const updated = await updateTask(selectedTask.id, { status: 'in_progress' });
        showToast("تم بدء المهمة بنجاح، بالتوفيق! 👍", "success");
        
        // Refresh local items
        setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...updated } : t));
        setSelectedTask(prev => prev ? { ...prev, ...updated } : null);
        setExecutingStep('details');
      } catch (err) {
        console.error(err);
        showToast("فشل في تحديث حالة المهمة", "error");
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  // Confirm photo before and transition to in_progress
  const handlePhotoBeforeSubmitted = async (meta: { url: string; publicId: string; size: number; mimeType: string; takenAt: string }) => {
    if (!selectedTask) return;
    setPhotoBefore(meta.url);
    
    try {
      setIsSubmitting(true);
      const updated = await updateTask(selectedTask.id, { 
        photo_before_url: meta.url,
        photo_before_public_id: meta.publicId,
        photo_before_taken_at: meta.takenAt,
        photo_before_uploaded_at: new Date().toISOString(),
        photo_before_size: meta.size,
        photo_before_mime_type: meta.mimeType,
        photo_capture_status: 'uploaded',
        status: 'in_progress' 
      });
      showToast("تم تسجيل صورة قبل وبدء المهمة! ⚡", "success");
      
      setTasks(prev => prev.map(t => t.id === selectedTask.id ? { ...t, ...updated } : t));
      setSelectedTask(prev => prev ? { ...prev, ...updated } : null);
      
      // Return to details showing that it is now in progress
      setExecutingStep('details');
    } catch (err) {
      console.error(err);
      showToast("حدث خطأ أثناء حفظ صورة قبل", "error");
      // Roll back the Cloudinary object if the database update failed.
      await deletePhoto(meta.publicId, selectedTask.id).catch((cleanupError) => {
        console.error("[TodayTasksPage] Before-photo cleanup failed.", cleanupError);
      });
      setPhotoBefore(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Complete task flow trigger
  const handleFinishTaskClick = () => {
    if (!selectedTask) return;
    const requiresPhotoAfter = selectedTask.requires_photo_after !== undefined
      ? selectedTask.requires_photo_after
      : true;

    if (requiresPhotoAfter) {
      setExecutingStep('after_photo');
    } else {
      goToNotesAndSubmit();
    }
  };

  const handlePhotoAfterSubmitted = (meta: { url: string; publicId: string; size: number; mimeType: string; takenAt: string }) => {
    if (!isUsableImageUrl(meta.url)) {
      showToast("رابط صورة بعد العمل غير صالح.", "error");
      return;
    }
    setPhotoAfter(meta.url);
    setPhotoAfterMeta(meta);
    goToNotesAndSubmit();
  };

  const goToNotesAndSubmit = () => {
    if (!selectedTask) return;
    setExecutingStep('notes_and_submit');
  };

  const submitTaskCompleted = async () => {
    if (!selectedTask) return;
    if (!isOnline()) {
      showToast("لا يمكن تسليم المهمة بدون اتصال نشط بالإنترنت", "error");
      return;
    }

    const requiresPhotoAfter = selectedTask.requires_photo_after !== undefined
      ? selectedTask.requires_photo_after
      : true;

    if (requiresPhotoAfter && (!photoAfter || !isUsableImageUrl(photoAfter))) {
      showToast("صورة ما بعد التنظيف مطلوبة لإتمام هذه المهمة. يرجى التقاطها وتأكيد رفعها أولاً.", "warning");
      setExecutingStep('after_photo');
      return;
    }

    setIsSubmitting(true);
    
    try {
      const updates: Partial<TaskInstance> = {
        status: 'completed',
        employee_notes: notes ? notes.trim() : undefined,
        photo_after_url: photoAfter || undefined,
        photo_after_public_id: photoAfterMeta?.publicId
      };

      if (photoAfterMeta) {
        updates.photo_after_taken_at = photoAfterMeta.takenAt;
        updates.photo_after_uploaded_at = new Date().toISOString();
        updates.photo_after_size = photoAfterMeta.size;
        updates.photo_after_mime_type = photoAfterMeta.mimeType;
        updates.photo_capture_status = 'uploaded';
      }

      const updated = await updateTask(selectedTask.id, updates);
      
      const approvalRequired = selectedTask.requires_supervisor_approval !== undefined
        ? selectedTask.requires_supervisor_approval
        : true;
      if (approvalRequired) {
        showToast("أحسنت! تم تسليم المهمة وهي بانتظار اعتماد المشرف ⏳", "success");
      } else {
        showToast("أحسنت! تم إكمال المهمة بنجاح وتقفيلها 🎉", "success");
      }

      // Reset states
      setSelectedTask(null);
      setPhotoBefore(null);
      setPhotoAfter(null);
      setPhotoAfterMeta(null);
      setNotes("");
    } catch (err) {
      console.error(err);
      showToast("فشل تسليم المهمة. يرجى المحاولة لاحقاً.", "error");
      
      // Rollback the uploaded photo after from Storage
      if (photoAfter) {
        if (photoAfterMeta?.publicId) {
          await deletePhoto(photoAfterMeta.publicId, selectedTask.id).catch((cleanupError) => {
            console.error("[TodayTasksPage] After-photo cleanup failed.", cleanupError);
          });
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F6FB] pb-28 font-sans">
      {!isOnlineState && (
        <div className="bg-rose-600 text-white py-3.5 px-4 sticky top-0 z-[60] shadow-md animate-fade-in text-right" dir="rtl">
          <div className="max-w-md mx-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-5 h-5 text-rose-100 shrink-0 animate-bounce" />
              <div>
                <p className="font-bold text-xs text-rose-50">لا يوجد اتصال بالإنترنت</p>
                <p className="text-[10px] text-rose-100 mt-0.5 leading-normal">
                  تطبيق Naris Ops يتطلب اتصالاً نشطاً بالإنترنت. تم إيقاف جميع العمليات ورفع الصور مؤقتاً لتجنب فقدان البيانات.
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setIsOnlineState(isOnline());
                if (isOnline()) {
                  showToast("تمت استعادة الاتصال بالإنترنت بنجاح! 🟢", "success");
                } else {
                  showToast("لا يزال الاتصال مقطوعاً. يرجى التحقق من الشبكة.", "error");
                }
              }}
              className="bg-white/15 hover:bg-white/25 active:bg-white/35 text-white text-[10px] font-extrabold py-1.5 px-3 rounded-lg border border-white/25 cursor-pointer shrink-0 transition"
            >
              🔄 إعادة الفحص
            </button>
          </div>
        </div>
      )}


      {/* Toast Alert */}
      {toast && (
        <div className={`fixed top-4 left-4 right-4 md:left-auto md:w-96 z-50 p-4 rounded-xl shadow-lg border transition-all duration-300 transform translate-y-0 flex items-center gap-3 ${
          toast.type === "success" ? "bg-emerald-50 text-emerald-800 border-emerald-200" :
          toast.type === "error" ? "bg-rose-50 text-rose-800 border-rose-200" :
          "bg-amber-50 text-amber-800 border-amber-200"
        }`}>
          {toast.type === "success" && <Check className="w-5 h-5 text-emerald-600 shrink-0" />}
          {toast.type === "error" && <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />}
          {toast.type === "warning" && <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />}
          <span className="text-sm font-semibold">{toast.message}</span>
        </div>
      )}

      {/* Modern Top Employee Bar */}
      <div className="relative overflow-hidden rounded-b-[2rem] bg-gradient-to-br from-[#101A33] via-[#172554] to-[#312E81] px-4 pb-5 pt-4 text-white shadow-xl shadow-indigo-950/10 sm:px-6 sm:pt-6">
        <div className="relative z-10 mx-auto w-full max-w-3xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <ProfessorLogo variant="icon" className="h-6 w-6" />
                <ProfessorLogo variant="logo-text" light={true} className="h-4.5" />
              </div>
              <h2 className="mt-1 flex items-center gap-2 text-lg font-black tracking-tight text-white sm:text-xl">
                مرحباً، {user.full_name} 👋
              </h2>
              <span className="text-xs text-slate-400 mt-1 inline-block bg-slate-800 py-0.5 px-2 rounded-md border border-slate-700">
                فترة الدوام: {user.shift_start} - {user.shift_end}
              </span>
            </div>
            
            <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:min-w-[320px] sm:grid-cols-4">
              <button
                onClick={onNavigateToSwitchGuide}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-2.5 py-2.5 text-[11px] font-bold text-white shadow-sm backdrop-blur-md transition active:scale-[0.98] hover:bg-white/15"
              >
                <BookOpen className="w-3.5 h-3.5 text-sky-200" /> دليل المفاتيح 💡
              </button>
              <button
                onClick={onNavigateToKpis}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-2.5 py-2.5 text-[11px] font-bold text-white shadow-sm backdrop-blur-md transition active:scale-[0.98] hover:bg-white/15"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-200" /> مؤشراتي 🏆
              </button>
              {onNavigateToDocumentation && (
                <button
                  onClick={onNavigateToDocumentation}
                  className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-2.5 py-2.5 text-[11px] font-bold text-white shadow-sm backdrop-blur-md transition active:scale-[0.98] hover:bg-white/15"
                >
                  <BookOpen className="w-3.5 h-3.5 text-emerald-200" /> دليل المنظومة 📖
                </button>
              )}
              <button
                onClick={onLogout}
                className="flex min-h-11 items-center justify-center rounded-xl border border-rose-300/20 bg-rose-400/10 px-3 py-2.5 text-[11px] font-bold text-rose-100 transition active:scale-[0.98] hover:bg-rose-400/20"
              >
                خروج
              </button>
            </div>
          </div>

          {/* Core Daily Stats */}
          <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.07] p-2.5 backdrop-blur-md sm:gap-3 sm:p-3">
            <div className="text-center">
              <span className="text-2xl font-extrabold text-white">{tasks.length}</span>
              <span className="text-[10px] text-slate-400 block mt-0.5">إجمالي المهام</span>
            </div>
            <div className="text-center border-x border-slate-800">
              <span className="text-2xl font-extrabold text-emerald-400">
                {tasks.filter(t => t.status === "completed").length}
              </span>
              <span className="text-[10px] text-slate-400 block mt-0.5">المكتملة</span>
            </div>
            <div className="text-center">
              <span className="text-2xl font-extrabold text-amber-400">
                {tasks.filter(t => t.status === "pending" || t.status === "in_progress").length}
              </span>
              <span className="text-[10px] text-slate-400 block mt-0.5">بانتظار العمل</span>
            </div>
          </div>

          {/* Cloud Online Status Bar */}
          <div className="mt-4 flex items-center justify-between bg-slate-800 border border-slate-700/50 py-2 px-3 rounded-xl text-xs">
            <div className="flex items-center gap-2">
              {isOnlineState ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="font-semibold text-slate-200">متصل بالسحابة (مباشر)</span>
                </>
              ) : (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
                  <span className="font-semibold text-rose-300">لا يوجد اتصال بالإنترنت ⚠️</span>
                </>
              )}
            </div>
            <span className="text-[10px] text-slate-400 font-mono">PostgreSQL API Mode</span>
          </div>
        </div>
      </div>

      {/* Main Task Feed Container */}
      <div className="mx-auto mt-3 w-full max-w-3xl px-3 sm:px-5">
        <div className="flex items-center gap-2 text-xs font-bold text-slate-500 mb-4 px-1">
          <Calendar className="w-4 h-4 text-slate-400" />
          <span>جدول مهام اليوم:</span>
          <span className="bg-slate-200 text-slate-700 py-0.5 px-2 rounded-full">
            {getLocalDateString()}
          </span>
        </div>

        {/* Categories / Filter Tabs */}
        <div className="sticky top-2 z-20 -mx-1 mb-3 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200/80 bg-white/90 p-2 shadow-sm backdrop-blur-xl scrollbar-none">
          {[
            { id: "all", label: "الكل" },
            { id: "pending", label: "بانتظار البدء" },
            { id: "in_progress", label: "قيد التنفيذ" },
            { id: "completed", label: "مكتملة" },
            { id: "rework", label: "إعادة التنظيف ⚠️" }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-10 rounded-xl border px-4 py-2.5 text-[11px] font-extrabold whitespace-nowrap transition cursor-pointer shrink-0 active:scale-[0.97] ${
                activeTab === tab.id
                  ? "bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-600/10"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tasks List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-600 mb-2" />
            <span className="text-xs font-semibold">جاري تحميل المهام...</span>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center mt-4">
            <CheckCircle2 className="w-12 h-12 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-700">لا توجد مهام في هذا التصنيف حالياً</p>
            <p className="text-xs text-slate-400 mt-1">العمليات تسير بشكل رائع وممتاز!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 mt-2">
            {filteredTasks.map((task) => (
              <div
                key={task.id}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPhotoBefore(null); setPhotoAfter(null); setNotes(""); setSelectedTask(task); setExecutingStep("details"); } }}
                onClick={() => {
                  setPhotoBefore(null);
                  setPhotoAfter(null);
                  setNotes("");
                  setSelectedTask(task);
                  setExecutingStep('details');
                }}
                className={`group w-full min-h-[116px] rounded-[1.35rem] border bg-white p-3.5 shadow-[0_5px_24px_rgba(15,23,42,0.045)] transition duration-200 cursor-pointer flex items-center justify-between gap-3 relative overflow-hidden hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.99] sm:p-4 ${
                  task.task_type === "rework" ? "border-purple-300 bg-purple-50/20" : "border-slate-200"
                }`}
              >
                {/* Rework left banner indicator */}
                {task.task_type === "rework" && (
                  <div className="absolute top-0 bottom-0 left-0 w-1.5 bg-purple-500"></div>
                )}

                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-[10px] font-bold py-0.5 px-2 rounded-full border ${getStatusColor(task.status, task.task_type)}`}>
                      {getStatusLabel(task.status, task.task_type)}
                    </span>
                    <span className="text-xs font-bold text-slate-400">
                      {task.task_code || "ONE_TIME"}
                    </span>
                    <TaskTimer task={task} />
                  </div>

                  <h3 className="mt-1 line-clamp-2 text-[13px] font-extrabold leading-6 text-slate-900 sm:text-sm">
                    {task.title}
                  </h3>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
                    <span className="text-xs flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      {task.zone?.name || "مقر الشركة"}
                    </span>
                    <span className="text-xs flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      قبل {task.due_time || "17:00"}
                    </span>
                  </div>

                  {/* Mandatories Indicators */}
                  <div className="flex gap-2 mt-2">
                    {(task.requires_photo_before ?? true) && (
                      <span className="text-[9px] font-semibold text-slate-400 bg-slate-100 py-0.5 px-1.5 rounded flex items-center gap-1">
                        <Camera className="w-3 h-3 text-slate-500" /> صورة قبل
                        {task.photo_before_url ? (
                          <span className="w-2 h-2 rounded-full bg-emerald-500 border border-emerald-300" title="مرفوعة ومضمونة سحابياً ☁️" />
                        ) : null}
                      </span>
                    )}
                    {(task.requires_photo_after ?? true) && (
                      <span className="text-[9px] font-semibold text-slate-400 bg-slate-100 py-0.5 px-1.5 rounded flex items-center gap-1">
                        <Camera className="w-3 h-3 text-slate-500" /> صورة بعد
                        {task.photo_after_url ? (
                          <span className="w-2 h-2 rounded-full bg-emerald-500 border border-emerald-300" title="مرفوعة ومضمونة سحابياً ☁️" />
                        ) : null}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  {task.reference_image_url && (
                    <img
                      src={task.reference_image_url}
                      alt="الصورة الاسترشادية للمهمة"
                      referrerPolicy="no-referrer"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveLightboxImage(task.reference_image_url || null);
                      }}
                      className="w-12 h-12 rounded-xl object-cover border border-slate-200 shadow-sm hover:scale-105 active:scale-95 transition-transform"
                    />
                  )}
                  <ChevronLeft className="w-5 h-5 text-slate-400" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Modal / Detail Drawer Sheet */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/65 p-0 backdrop-blur-sm sm:items-center sm:p-6">
          <div className="flex max-h-[min(92dvh,900px)] w-full max-w-xl flex-col overflow-y-auto rounded-t-[2rem] bg-white pb-[max(env(safe-area-inset-bottom),1.5rem)] shadow-2xl transition-transform duration-300 sm:rounded-[2rem]">
            
            {/* Drawer Header */}
            <div className="border-b border-slate-100 p-4 sticky top-0 bg-white z-10 flex justify-between items-center">
              <button
                type="button"
                onClick={() => {
                  setSelectedTask(null);
                  setPhotoBefore(null);
                  setPhotoAfter(null);
                  setNotes("");
                }}
                className="text-xs font-bold text-slate-500 hover:text-slate-800 cursor-pointer flex items-center gap-1 bg-slate-100 py-1.5 px-3 rounded-full"
              >
                إغلاق النافذة
              </button>
              <h3 className="text-sm font-bold text-slate-800">
                {selectedTask.task_type === "rework" ? "إعادة تنفيذ المهمة" : "تفاصيل المهمة"}
              </h3>
              <div className="w-16"></div> {/* Spacer for symmetry */}
            </div>

            {/* Modal Body depending on executingStep */}
            <div className="p-5 flex-1">
              
              {/* STEP 1: Details & Start */}
              {executingStep === 'details' && (
                <div className="flex flex-col gap-4">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <span className={`text-[10px] font-bold py-0.5 px-2.5 rounded-full border inline-block mb-1.5 ${getStatusColor(selectedTask.status, selectedTask.task_type)}`}>
                        {getStatusLabel(selectedTask.status, selectedTask.task_type)}
                      </span>
                      <h2 className="text-base font-bold text-slate-800 leading-snug">
                        {selectedTask.title}
                      </h2>
                      <div className="mt-2">
                        <TaskTimer task={selectedTask} />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div>
                      <span className="text-[10px] text-slate-400 block">المنطقة والموقع:</span>
                      <span className="text-xs font-semibold text-slate-700 flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3.5 h-3.5 text-slate-400" />
                        {selectedTask.zone?.name || "مقر الشركة"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block">وقت التسليم المحدد:</span>
                      <span className="text-xs font-semibold text-slate-700 flex items-center gap-1 mt-0.5">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        قبل الساعة {selectedTask.due_time || "17:00"}
                      </span>
                    </div>
                  </div>

                  {/* SOP Specific Guidelines */}
                  <div className="flex flex-col gap-3 mt-1">
                    {!!selectedTask.goal && (
                      <div className="flex items-start gap-2.5">
                        <div className="bg-emerald-50 text-emerald-600 p-1.5 rounded-lg border border-emerald-100">
                          <BookOpen className="w-4 h-4" />
                        </div>
                        <div>
                          <span className="text-xs font-bold text-slate-700 block">الهدف من البند (SOP):</span>
                          <span className="text-xs text-slate-500 leading-relaxed block mt-0.5">
                            {selectedTask.goal}
                          </span>
                        </div>
                      </div>
                    )}

                    {!!selectedTask.tools_required && (
                      <div className="flex items-start gap-2.5">
                        <div className="bg-blue-50 text-blue-600 p-1.5 rounded-lg border border-blue-100">
                          <Wrench className="w-4 h-4" />
                        </div>
                        <div>
                          <span className="text-xs font-bold text-slate-700 block">المعدات والمطهرات المطلوبة:</span>
                          <span className="text-xs text-slate-500 leading-relaxed block mt-0.5">
                            {selectedTask.tools_required}
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="flex items-start gap-2.5">
                      <div className="bg-slate-50 text-slate-600 p-1.5 rounded-lg border border-slate-200">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div>
                        <span className="text-xs font-bold text-slate-700 block">خطوات وتعليمات العمل بالتفصيل:</span>
                        <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                          {selectedTask.description || "تنظيف وتجهيز الموقع على النحو المطلوب طبقا للمعايير السليمة."}
                        </p>
                      </div>
                    </div>

                    {/* SOP Official Reference Image */}
                    {selectedTask.reference_image_url && (
                      <div className="flex flex-col gap-1.5 mt-2 border border-slate-100 rounded-xl overflow-hidden bg-slate-50/50 p-2">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="bg-blue-50 text-blue-600 p-1 rounded-lg border border-blue-100">
                            <Camera className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <span className="text-xs font-bold text-slate-700 block">
                              الصورة الاسترشادية للمهمة
                            </span>
                            <span className="text-[10px] text-slate-400 block">
                              صورة توضيحية للموقع أو البند المحدد المطلوب العمل عليه
                            </span>
                          </div>
                        </div>
                        <img
                          src={selectedTask.reference_image_url}
                          alt={selectedTask.title}
                          referrerPolicy="no-referrer"
                          onClick={() => setActiveLightboxImage(selectedTask.reference_image_url || null)}
                          className="w-full h-48 object-cover rounded-lg border border-slate-200 shadow-sm animate-fade-in cursor-pointer hover:scale-[1.02] active:scale-[0.99] transition-transform duration-300"
                        />
                      </div>
                    )}
                  </div>

                  {/* Employee Uploaded Photos with Sync Status */}
                  {(selectedTask.photo_before_url || selectedTask.photo_after_url) && (
                    <div className="flex flex-col gap-3 mt-4 border border-slate-200 rounded-2xl p-4 bg-slate-50/50">
                      <div className="flex items-center gap-2 pb-2 border-b border-slate-200 justify-between">
                        <div className="flex items-center gap-2">
                          <Camera className="w-4 h-4 text-indigo-600" />
                          <span className="text-xs font-bold text-slate-800">📸 صور إثبات العمل المرفوعة:</span>
                        </div>
                        <span className="text-[10px] text-slate-400 font-bold">تم حفظها بشكل دائم في النظام</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {selectedTask.photo_before_url && (() => {
                          const status = checkPhotoStatus(selectedTask.photo_before_url);
                          return (
                            <div className="flex flex-col gap-1.5 bg-white p-2.5 rounded-xl border border-slate-100 shadow-sm">
                              <span className="text-[10px] font-bold text-slate-500 block">صورة قبل العمل:</span>
                              <div className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
                                <img
                                  src={selectedTask.photo_before_url}
                                  alt="Before"
                                  referrerPolicy="no-referrer"
                                  onClick={() => setActiveLightboxImage(selectedTask.photo_before_url || null)}
                                  className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform"
                                />
                              </div>
                              <span className={`text-[9px] font-extrabold py-1 px-1.5 rounded-md border text-center ${status.color}`}>
                                {status.label}
                              </span>
                            </div>
                          );
                        })()}

                        {selectedTask.photo_after_url && (() => {
                          const status = checkPhotoStatus(selectedTask.photo_after_url);
                          return (
                            <div className="flex flex-col gap-1.5 bg-white p-2.5 rounded-xl border border-slate-100 shadow-sm">
                              <span className="text-[10px] font-bold text-slate-500 block">صورة بعد العمل:</span>
                              <div className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
                                <img
                                  src={selectedTask.photo_after_url}
                                  alt="After"
                                  referrerPolicy="no-referrer"
                                  onClick={() => setActiveLightboxImage(selectedTask.photo_after_url || null)}
                                  className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform"
                                />
                              </div>
                              <span className={`text-[9px] font-extrabold py-1 px-1.5 rounded-md border text-center ${status.color}`}>
                                {status.label}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {/* If rejected, show why */}
                  {selectedTask.status === "rejected" && selectedTask.supervisor_notes && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 mt-2 text-red-800 flex items-start gap-2">
                      <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      <div>
                        <span className="text-xs font-bold block">ملاحظات وسبب الرفض من المشرف:</span>
                        <p className="text-xs mt-1 font-semibold leading-relaxed">
                          {selectedTask.supervisor_notes}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Core Action Footer inside Drawer */}
                  <div className="mt-6">
                    {selectedTask.status === "pending" && executingStep === 'details' && (
                      <button
                        type="button"
                        onClick={handleStartTask}
                        disabled={isSubmitting || !isOnlineState}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-xl transition shadow-md shadow-indigo-600/15 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isSubmitting ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <>
                            <Play className="w-5 h-5" />
                            <span>ابدأ التنفيذ الآن</span>
                          </>
                        )}
                      </button>
                    )}

                    {selectedTask.status === "in_progress" && executingStep === 'details' && (
                      <button
                        type="button"
                        onClick={handleFinishTaskClick}
                        disabled={!isOnlineState}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 rounded-xl transition shadow flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <CheckCircle2 className="w-5 h-5" />
                        <span>إنهاء المهمة وتسليمها</span>
                      </button>
                    )}

                    {selectedTask.status === "completed" && (
                      <div className="bg-emerald-50 text-emerald-800 p-4 rounded-xl border border-emerald-200 text-center text-xs font-bold">
                        {selectedTask.supervisor_approved ? (
                          <p className="flex items-center justify-center gap-1.5 text-sm text-emerald-700">
                            <CheckCircle2 className="w-5 h-5" /> تم التنفيذ والاعتماد بنجاح بتقدير ({selectedTask.quality_grade})
                          </p>
                        ) : (
                          <p className="flex items-center justify-center gap-1.5">
                            <Clock className="w-4 h-4 animate-spin text-emerald-600" /> تم التسليم، بانتظار مراجعة واعتماد المشرف...
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* STEP 2: Before Photo */}
              {executingStep === 'before_photo' && (
                <div className="flex flex-col gap-4">
                  <div className="text-center mb-2">
                    <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-1.5" />
                    <h3 className="text-sm font-bold text-slate-800">صورة ما قبل البدء مطلوبة</h3>
                    <p className="text-xs text-slate-400 mt-1">يرجى تصوير حالة المكان "قبل التنظيف" كدليل إثبات للمهمة</p>
                  </div>

                  <PhotoCapture 
                    label="صورة المكان قبل التنظيف" 
                    onPhotoUploaded={handlePhotoBeforeSubmitted} 
                    required={true}
                    storagePath={`task-photos/${selectedTask.zone_id}/${selectedTask.id}/before.jpg`}
                    disabled={!isOnlineState}
                  />

                  {isSubmitting && (
                    <div className="flex justify-center items-center gap-2 text-xs text-slate-500">
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-600" /> جاري الحفظ والتسجيل...
                    </div>
                  )}
                </div>
              )}

              {/* STEP 3: After Photo */}
              {executingStep === 'after_photo' && (
                <div className="flex flex-col gap-4">
                  <div className="text-center mb-2">
                    <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-1.5 animate-bounce" />
                    <h3 className="text-sm font-bold text-slate-800">صورة إثبات التنظيف مطلوبة</h3>
                    <p className="text-xs text-slate-400 mt-1">يرجى تصوير المكان بدقة بعد إنهاء التنظيف ليرى المشرف جودة عملك</p>
                  </div>

                  <PhotoCapture 
                    label="صورة المكان بعد التنظيف" 
                    onPhotoUploaded={handlePhotoAfterSubmitted} 
                    required={true}
                    storagePath={`task-photos/${selectedTask.zone_id}/${selectedTask.id}/after.jpg`}
                    disabled={!isOnlineState}
                  />
                </div>
              )}

              {/* STEP 4: Notes & Submit */}
              {executingStep === 'notes_and_submit' && (
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">الخطوة الأخيرة: الملاحظات والتسليم</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      أضف أي ملاحظات قبل تسليم المهمة للمشرف
                    </p>
                  </div>

                  {/* Notes */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-slate-700">ملاحظات إضافية (اختياري)</label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="مثال: تم مسح الموقع بالكامل وتطهير الأسطح..."
                      rows={3}
                      className="w-full text-xs p-3 border border-slate-200 rounded-xl focus:border-slate-400 focus:ring-0 resize-none outline-none"
                    ></textarea>
                  </div>

                  <button
                    type="button"
                    onClick={() => submitTaskCompleted()}
                    disabled={isSubmitting || !isOnlineState}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:bg-slate-300 text-white font-bold py-3.5 rounded-xl transition shadow flex items-center justify-center gap-2 cursor-pointer mt-2 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        <span>تسليم المهمة النهائية ✅</span>
                      </>
                    )}
                  </button>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* Visual Connection Status Indicator Footer */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-[#10182D]/95 px-3 pb-[max(env(safe-area-inset-bottom),0.65rem)] pt-2.5 text-slate-100 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-2xl" dir="rtl">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl shrink-0 transition-colors ${isOnlineState ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
              {isOnlineState ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5 animate-pulse" />
              )}
            </div>
            <div>
              <div className="font-bold flex items-center gap-2 text-slate-100 text-xs">
                <span>حالة الاتصال بالسحابة</span>
                <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${isOnlineState ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border-rose-500/30'}`}>
                  {isOnlineState ? "نشط" : "غير متصل"}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1 leading-normal text-right">
                {isOnlineState 
                  ? "تطبيق Naris Ops متصل بواجهة PostgreSQL API." 
                  : "يرجى إعادة الاتصال بالشبكة للمتابعة وتحديث حالة المهام."}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => {
                setIsOnlineState(isOnline());
                if (isOnline()) {
                  showToast("تم التحقق واستعادة الاتصال السحابي! 🟢", "success");
                } else {
                  showToast("لا يزال غير متصل بالإنترنت. يرجى مراجعة الشبكة.", "error");
                }
              }}
              className="bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-200 font-bold py-1.5 px-3 rounded-xl cursor-pointer transition text-xs border border-slate-700/60 flex items-center gap-1.5"
            >
              🔄 فحص الاتصال
            </button>
          </div>
        </div>
      </div>

      {/* Full Screen Image Lightbox */}
      {activeLightboxImage && (
        <div 
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4 animate-fade-in"
          onClick={() => setActiveLightboxImage(null)}
        >
          <div className="absolute top-4 right-4 flex items-center gap-2">
            <span className="text-white/60 text-xs font-semibold bg-white/10 px-3 py-1.5 rounded-full backdrop-blur-sm">اضغط في أي مكان للإغلاق</span>
            <button
              onClick={() => setActiveLightboxImage(null)}
              className="bg-white/15 hover:bg-white/25 text-white p-2.5 rounded-full transition-all border border-white/10 shadow-lg cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <div 
            className="relative max-w-full max-h-[85vh] overflow-hidden rounded-2xl border border-white/10 shadow-2xl bg-slate-950/40"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={activeLightboxImage}
              alt="SOP Fullscreen Preview"
              referrerPolicy="no-referrer"
              className="max-w-full max-h-[80vh] object-contain rounded-xl select-none"
            />
          </div>
        </div>
      )}

    </div>
  );
}