import React, { useState, useMemo } from "react";
import { 
  Search, 
  X, 
  Copy, 
  Check, 
  Lightbulb, 
  BookOpen, 
  Info,
  Layers,
  ChevronLeft
} from "lucide-react";
import { 
  switchLabelsData, 
  SWITCH_CATEGORIES, 
  SwitchCategory, 
  SwitchLabelItem 
} from "../constants/switchLabels";

interface SwitchLabelsGuideProps {
  onBack?: () => void;
  className?: string;
  isDarkTheme?: boolean;
}

export default function SwitchLabelsGuide({ 
  onBack, 
  className = "",
  isDarkTheme = false
}: SwitchLabelsGuideProps) {
  const [activeTab, setActiveTab] = useState<SwitchCategory>("SWREC");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Filter items based on active tab and search query
  const filteredItems = useMemo(() => {
    const items = switchLabelsData[activeTab] || [];
    const normalizedQuery = searchQuery.trim().toLowerCase();
    
    if (!normalizedQuery) return items;

    return items.filter(
      (item) =>
        item.label_code.toLowerCase().includes(normalizedQuery) ||
        item.description.toLowerCase().includes(normalizedQuery)
    );
  }, [activeTab, searchQuery]);

  // Compute counts for all tabs for dynamic badges
  const tabCounts = useMemo(() => {
    const counts: Record<SwitchCategory, number> = {
      SWREC: switchLabelsData.SWREC.length,
      SWMT: switchLabelsData.SWMT.length,
      SWBAS: switchLabelsData.SWBAS.length,
    };
    return counts;
  }, []);

  const handleCopy = (code: string, id: string) => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  // Helper to highlight matched text
  const renderHighlightedText = (text: string, highlight: string) => {
    if (!highlight.trim()) return text;
    const regex = new RegExp(`(${highlight.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return (
      <>
        {parts.map((part, i) => 
          part.toLowerCase() === highlight.toLowerCase() ? (
            <mark key={i} className="bg-amber-100 text-slate-900 rounded px-0.5 font-bold">
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const currentCategoryMeta = SWITCH_CATEGORIES.find(cat => cat.key === activeTab);

  return (
    <div className={`w-full max-w-7xl mx-auto p-4 md:p-6 text-right ${isDarkTheme ? 'text-white' : 'text-slate-800'} ${className}`} dir="rtl">
      {/* Header section with back option */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-5 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1.5 justify-start">
            <div className="p-2 bg-indigo-50 dark:bg-slate-800 rounded-xl">
              <Lightbulb className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">
              دليل مفاتيح الإضاءة والتحكم
            </h1>
          </div>
          <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400">
            الدليل الفني الموحد لتحديد مسميات ووظائف مفاتيح الكهرباء بالتفصيل لتسهيل عمليات الصيانة والتشغيل.
          </p>
        </div>

        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 self-start sm:self-center px-4 py-2 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-xl text-xs font-bold transition cursor-pointer"
          >
            <span>العودة للوحة التشغيل</span>
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Local Mode Performance Note */}
      <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/50 rounded-2xl p-4 mb-6 flex items-start gap-3">
        <div className="p-1 bg-emerald-100 dark:bg-emerald-900 rounded-lg text-emerald-800 dark:text-emerald-400 shrink-0 mt-0.5">
          <Info className="w-4 h-4" />
        </div>
        <div className="text-xs leading-relaxed text-emerald-800 dark:text-emerald-300 font-medium">
          <strong>تشغيل فائق السرعة وبدون استهلاك للبيانات:</strong> يتم تحميل دليل مفاتيح الإضاءة بالكامل محلياً من ملفات النظام الثابتة. هذا يحمي باقة الإنترنت لعمال النظافة ويضمن توفر البيانات الفورية بنسبة 100% حتى في حال عدم وجود تغطية خلوية داخل غرف التشغيل، وبدون استهلاك لأي طلبات من قاعدة البيانات.
        </div>
      </div>

      {/* Tab system */}
      <div className="flex flex-col gap-4 mb-6">
        <label className="text-xs font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5" />
          <span>اختر المنطقة أو التصنيف:</span>
        </label>
        
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 bg-slate-100/80 dark:bg-slate-800/40 p-1.5 rounded-2xl border border-slate-200/50 dark:border-slate-700/50">
          {SWITCH_CATEGORIES.map((category) => {
            const isSelected = activeTab === category.key;
            return (
              <button
                key={category.key}
                onClick={() => {
                  setActiveTab(category.key);
                  // Optional: clear search on tab change to reset list view
                }}
                className={`flex items-center justify-between px-4 py-3.5 rounded-xl text-xs font-extrabold transition-all duration-200 cursor-pointer ${
                  isSelected
                    ? "bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-sm border border-slate-200/30 dark:border-slate-800"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-white/40 dark:hover:bg-slate-800/20"
                }`}
              >
                <span>{category.label}</span>
                <span className={`text-[10px] py-0.5 px-2.5 rounded-full font-black ${
                  isSelected 
                    ? "bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300" 
                    : "bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                }`}>
                  {tabCounts[category.key]} مفتاح
                </span>
              </button>
            );
          })}
        </div>

        {/* Tab description hint */}
        {currentCategoryMeta && (
          <div className="text-xs text-slate-400 dark:text-slate-500 font-bold px-1 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            <span>نطاق المفاتيح: {currentCategoryMeta.description}</span>
          </div>
        )}
      </div>

      {/* Interactive Controls Bar: Search & Quick Reset */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="relative w-full">
          <Search className="w-4 h-4 text-slate-400 absolute right-4 top-3.5" />
          <input
            type="text"
            placeholder="ابحث برمز المفتاح أو تفاصيل الإضاءة (مثال: SWREC 003 أو ليد)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pr-11 pl-10 py-3 border border-slate-200 dark:border-slate-800 rounded-xl outline-none bg-white dark:bg-slate-900/80 focus:border-indigo-500 dark:focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-xs font-bold transition"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute left-3 top-2.5 p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition text-slate-400 hover:text-slate-600 cursor-pointer"
              title="مسح البحث"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Empty State vs Search Results */}
      {filteredItems.length === 0 ? (
        <div className="bg-white dark:bg-slate-900/50 border border-slate-200/60 dark:border-slate-800/60 rounded-2xl p-12 text-center flex flex-col items-center justify-center gap-3">
          <div className="w-12 h-12 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-400">
            <BookOpen className="w-6 h-6 text-slate-300" />
          </div>
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">لم نجد أي مفاتيح إضاءة مطابقة</h3>
          <p className="text-xs text-slate-400 max-w-sm">
            يرجى التحقق من صياغة البحث، أو حاول إدخال أرقام فقط (مثال: 005) أو كلمات عامة مثل "ليد" أو "خارجي" للحصول على نتائج أفضل.
          </p>
          <button
            onClick={() => setSearchQuery("")}
            className="mt-2 text-xs font-extrabold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
          >
            إعادة تعيين مرشح البحث
          </button>
        </div>
      ) : (
        <div>
          {/* Stats Bar */}
          <div className="flex items-center justify-between mb-4 px-1">
            <span className="text-[11px] font-bold text-slate-400">
              عرض {filteredItems.length} من {switchLabelsData[activeTab].length} مفتاح في هذا القسم
            </span>
            {searchQuery && (
              <span className="text-[11px] bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 px-2.5 py-1 rounded-md font-bold">
                نتائج مطابقة للمصطلح: "{searchQuery}"
              </span>
            )}
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredItems.map((item) => {
              const uniqueId = `${activeTab}-${item.id}-${item.label_code}`;
              const isCopied = copiedId === uniqueId;
              
              return (
                <div
                  key={uniqueId}
                  className="bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700/80 rounded-2xl p-4 transition-all duration-200 flex flex-col justify-between gap-3 shadow-xs hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Prominent Label Code */}
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-black text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 px-2.5 py-1.5 rounded-lg border border-indigo-100/20 inline-block font-mono">
                        {renderHighlightedText(item.label_code, searchQuery)}
                      </span>
                    </div>

                    {/* Copy action & Status Badge */}
                    <div className="flex items-center gap-1.5">
                      {/* Copy code button */}
                      <button
                        onClick={() => handleCopy(item.label_code, uniqueId)}
                        className={`p-1.5 rounded-lg border transition ${
                          isCopied 
                            ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-600 border-emerald-200" 
                            : "bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700/50 text-slate-400 hover:text-slate-600 border-slate-200/50 dark:border-slate-700 cursor-pointer"
                        }`}
                        title={isCopied ? "تم النسخ!" : "نسخ رمز المفتاح"}
                      >
                        {isCopied ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {/* Status indicator */}
                      <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-100/50 dark:border-emerald-900/30 rounded-lg">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span>{item.status}</span>
                      </span>
                    </div>
                  </div>

                  {/* Description container */}
                  <div className="border-t border-slate-100 dark:border-slate-800/80 pt-3">
                    <span className="text-[10px] text-slate-400 block mb-0.5 font-semibold">تفاصيل والتحكم بالإضاءة:</span>
                    <p className="text-xs font-bold text-slate-800 dark:text-slate-200 leading-relaxed min-h-[2.5rem] flex items-center">
                      {renderHighlightedText(item.description, searchQuery)}
                    </p>
                  </div>

                  {/* Card bottom hint */}
                  <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-2 flex items-center justify-between text-[9px] text-slate-400 font-semibold mt-1">
                    <span>موقع المفتاح: {activeTab === "SWREC" ? "منطقة الاستقبال والريسبشن" : activeTab === "SWMT" ? "معمل وممر الطابق الأرضي" : "مكاتب تشغيل التيم"}</span>
                    <span className="font-mono opacity-60">ID: #{item.id}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
