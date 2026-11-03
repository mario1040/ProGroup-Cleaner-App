import React, { useState, useMemo } from "react";
import {
  BookOpen,
  Search,
  Printer,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Camera,
  ShieldCheck,
  Users,
  Grid,
  Lightbulb,
  Box,
  BarChart2,
  HelpCircle,
  Sparkles,
  ArrowRight,
  SlidersHorizontal,
  FileText,
  BadgeCheck,
  XCircle,
  Info,
  Calendar,
  Lock,
  Smartphone,
  Eye,
  Check,
  Layers,
  Zap
} from "lucide-react";
import ProfessorLogo from "./ProfessorLogo";

interface SystemDocumentationGuideProps {
  onBack?: () => void;
  initialRole?: "all" | "admin" | "supervisor" | "cleaner";
}

type SectionCategory =
  | "overview"
  | "task_lifecycle"
  | "admin_guide"
  | "supervisor_guide"
  | "cleaner_guide"
  | "photo_standards"
  | "switch_guide"
  | "inventory_guide"
  | "faq";

export default function SystemDocumentationGuide({
  onBack,
  initialRole = "all"
}: SystemDocumentationGuideProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<SectionCategory | "all">("all");
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [activeStepTab, setActiveStepTab] = useState<number>(1);

  const handlePrint = () => {
    window.print();
  };

  // Categories list for filtering
  const categories = [
    { id: "all", label: "جميع الأقسام", icon: Layers },
    { id: "overview", label: "١. فكرة ورؤية المنظومة", icon: BookOpen },
    { id: "task_lifecycle", label: "٢. دورة حياة المهمة", icon: Zap },
    { id: "admin_guide", label: "٣. دليل الإدارة العليا", icon: Grid },
    { id: "supervisor_guide", label: "٤. دليل المشرف والجودة", icon: ShieldCheck },
    { id: "cleaner_guide", label: "٥. دليل موظف الميدان", icon: Smartphone },
    { id: "photo_standards", label: "٦. معايير التصوير والتوثيق", icon: Camera },
    { id: "switch_guide", label: "٧. تشغيل الكهرباء والأجهزة", icon: Lightbulb },
    { id: "inventory_guide", label: "٨. مراقبة المخزون والمعدات", icon: Box },
    { id: "faq", label: "٩. الأسئلة الشائعة وحل الأعطال", icon: HelpCircle },
  ];

  // FAQ data
  const faqs = [
    {
      q: "ما هو اسم المستخدم وكلمة المرور الخاصة بي؟",
      a: "يقوم مدير النظام (Admin) بإنشاء حسابك وتحديد اسم المستخدم التقني الخاص بك (مثل: afaf, rehab, admin) وتعيين كلمة المرور الأولية. إذا نسيت كلمة المرور الخاصة بك، يرجى التواصل مع المشرف أو مدير العمليات لإعادة تعيينها فوراً من تبويب 'إدارة الموظفين'.",
      role: "عام"
    },
    {
      q: "ماذا أفعل إذا ظهرت رسالة 'المهمة متأخرة' أو باللون الأحمر؟",
      a: "كل مهمة في النظام لها وقت مجدول متوقع (Scheduled Time). إذا بدأ وقت التنفيذ وتجاوزت الوقت المسموح به، يضعها النظام تلقائياً في حالة 'متأخرة' لتنبيه المشرف. لا تقلق، يمكنك البدء في تنفيذها فوراً والتقاط الصور، وسيقوم المشرف باعتمادها بعد التأكد من جودة العمل.",
      role: "الميدان"
    },
    {
      q: "لماذا لا تفتح الكاميرا عند الضغط على زر التقاط صورة قبل/بعد؟",
      a: "يحتاج متصفح الهاتف أو الكمبيوتر إلى إذن الوصول للكاميرا. تأكد من الضغط على 'السماح' (Allow) عندما يطلب المتصفح إذن الكاميرا. إذا قمت بالرفض عن طريق الخطأ، افتح إعدادات المتصفح (أيقونة القفل بجوار الرابط) وقم بتفعيل خيار الكاميرا ثم أعد تحميل الصفحة.",
      role: "الميدان"
    },
    {
      q: "قمت بإنهاء المهمة، ولكنها عادت لي في حالة 'إعادة التنظيف (Rework)'.. ماذا يعني ذلك؟",
      a: "تعني أن المشرف راجع صور المهمة ووجد ملاحظة تحتاج لتصحيح (مثل: بقعة لم تُنظف، صورة غير واضحة، أو زاوية مفقودة). ستجد في تفاصيل المهمة 'ملاحظات المشرف' المكتوبة بدقة. كل ما عليك هو معالجة الملاحظة وإعادة التقاط صورة بعد جديدة وتسليمها.",
      role: "الميدان"
    },
    {
      q: "كيف يتم احتساب تقييم الجودة (A / B / C)؟",
      a: "الدرجة (A) تعني تنفيذاً ممتازاً مطابقاً لكافة معايير الـ SOP وفي الوقت المحدد وتمنح الموظف أعلى نقاط أداء. الدرجة (B) تعني تنفيذاً جيداً جداً مع ملاحظات إرشادية طفيفة. الدرجة (C) تعني تنفيذاً متواضعاً تم قبوله مع تنبيه بضرورة تداركه في الوردية القادمة.",
      role: "مشرفين"
    },
    {
      q: "هل يعمل التطبيق عند انقطاع الإنترنت أو ضعف شبكة المحمول؟",
      a: "نعم، تم تزويد التطبيق بنظام مزامنة وتخزين محلي مؤقت. يمكنك استعراض مهامك اليومية وتنفيذ خطواتك، وعند عودة الاتصال يقوم النظام تلقائياً برفع البيانات والصور لسحابة النظام وحفظ التوقيتات الدقيقة.",
      role: "عام"
    },
    {
      q: "كيف أستخرج تقريراً شهرياً لتقديمه للإدارة أو المحاسبة؟",
      a: "من لوحة تحكم الإدارة، انتقل إلى تبويب 'التقارير الشهرية والأرشيف'. اختر الموظف المطلوب (أو كل الموظفين)، وحدد نطاق التاريخ (من بداية الشهر إلى نهايته)، ثم اضغط زر 'تصدير التقرير التنفيذي PDF' لتحصل على وثيقة رسمية جاهزة للطباعة والاعتماد.",
      role: "إدارة"
    },
    {
      q: "كيف أعرف المفاتيح الكهربائية الممنوع إطفاؤها عند مغادرة المقر؟",
      a: "من خلال 'دليل مفاتيح الإضاءة 💡' المتوفر في القائمة الرئيسية. ستجد تصنيفاً لونياً دقيقاً: المفاتيح الخضراء مسموح إطفاؤها يومياً، بينما المفاتيح الحمراء (مثل خوادم السيرفر، كاميرات المراقبة، الثلاجات الحساسة) يمنع لمسها منعاً باتاً.",
      role: "تشغيل"
    }
  ];

  // Filter sections and FAQs based on search
  const isMatch = (text: string) => {
    if (!searchQuery.trim()) return true;
    return text.toLowerCase().includes(searchQuery.toLowerCase());
  };

  const filteredFaqs = useMemo(() => {
    return faqs.filter(f => isMatch(f.q) || isMatch(f.a) || isMatch(f.role));
  }, [searchQuery]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 pb-20 print:bg-white print:p-0 print:pb-0" dir="rtl">
      
      {/* Top Header & Actions (Hidden during print) */}
      <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-30 shadow-lg no-print">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 p-2 rounded-xl transition flex items-center justify-center cursor-pointer border border-slate-700"
                title="العودة للصفحة السابقة"
              >
                <ChevronLeft className="w-5 h-5 rotate-180" />
              </button>
            )}
            <div>
              <div className="flex items-center gap-2">
                <ProfessorLogo variant="icon" className="w-6 h-6" />
                <span className="text-xs font-black text-indigo-400 uppercase tracking-wider">
                  Naris Ops • المركز المعرفي
                </span>
              </div>
              <h1 className="text-lg md:text-xl font-extrabold text-white mt-0.5">
                دليل وشرح المنظومة لغير التقنيين 📖
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {/* Search Bar */}
            <div className="relative flex-1 md:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
              <input
                type="text"
                placeholder="ابحث عن أي موضوع أو سؤال..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pr-9 pl-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-400 outline-none focus:border-indigo-500 transition"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute left-2.5 top-2.5 text-slate-400 hover:text-white text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Print / Export Button */}
            <button
              onClick={handlePrint}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 px-3.5 rounded-xl transition flex items-center gap-2 shadow-md shadow-indigo-600/20 cursor-pointer shrink-0"
              title="طباعة الدليل أو حفظه بصيغة PDF"
            >
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">طباعة / تصدير PDF</span>
            </button>
          </div>
        </div>

        {/* Category Horizontal Filter Bar */}
        <div className="max-w-6xl mx-auto px-4 overflow-x-auto scrollbar-none border-t border-slate-800/80 py-2.5 flex items-center gap-2">
          {categories.map((cat) => {
            const Icon = cat.icon;
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id as SectionCategory | "all")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition cursor-pointer ${
                  isSelected
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Printable Corporate Document Header (Only visible when printed) */}
      <div className="hidden print:block p-8 border-b-2 border-slate-900 mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-black text-slate-900">
              دليل التشغيل وإجراءات الجودة الموحد (Naris Ops)
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              الوثيقة الرسمية لشرح المنظومة، ومسؤوليات الأدوار، ومعايير التدقيق الميداني
            </p>
          </div>
          <div className="text-left text-xs text-slate-500 font-mono">
            <div>مقر النرجس الرئيسي</div>
            <div>تاريخ الإصدار: {new Date().toLocaleDateString('ar-EG')}</div>
            <div>النسخة: 1.4 (غير التقنية)</div>
          </div>
        </div>
      </div>

      {/* Main Container */}
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-10">

        {/* Hero Concept Card */}
        {(selectedCategory === "all" || selectedCategory === "overview") && isMatch("فكرة ورؤية المنظومة") && (
          <section className="bg-gradient-to-br from-indigo-900 via-slate-900 to-slate-950 text-white rounded-3xl p-6 md:p-10 shadow-xl border border-slate-800 relative overflow-hidden print:border print:border-slate-300 print:bg-white print:text-slate-900 print:shadow-none">
            <div className="relative z-10 max-w-3xl">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-bold border border-indigo-400/30 mb-4 print:text-indigo-900 print:bg-indigo-50">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>الرؤية والهدف التشغيلي</span>
              </span>
              <h2 className="text-2xl md:text-3xl font-black tracking-tight text-white print:text-slate-900 mb-4 leading-tight">
                ما هو نظام Naris Ops ولماذا تم ابتكاره؟
              </h2>
              <p className="text-sm md:text-base text-slate-300 print:text-slate-700 leading-relaxed font-medium">
                هو نظام تشغيلي ورقمي متكامل صُمم خصيصاً لمقر الشركة بهدف تحويل جميع عمليات النظافة، والصيانة الوقائية، والتحكم في الطاقة والمخزون من المتابعة الورقية والشفهية العشوائية إلى <strong className="text-white print:text-slate-900">إجراءات قياسية موثقة رقمياً بالصور والتوقيت ومؤشرات الأداء</strong>.
              </p>

              {/* Three Pillars Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8 pt-6 border-t border-slate-800/80 print:border-slate-300">
                <div className="bg-slate-800/50 print:bg-slate-50 p-4 rounded-2xl border border-slate-700/60 print:border-slate-200">
                  <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-black mb-3">
                    ١
                  </div>
                  <h3 className="text-sm font-bold text-white print:text-slate-900 mb-1">
                    توثيق حقيقي وملموس
                  </h3>
                  <p className="text-xs text-slate-400 print:text-slate-600 leading-relaxed">
                    إثبات نظافة كل زاوية بمقر الشركة بصور واضحة (قبل وبعد) تضمن حق الموظف وتمنع الخلافات.
                  </p>
                </div>

                <div className="bg-slate-800/50 print:bg-slate-50 p-4 rounded-2xl border border-slate-700/60 print:border-slate-200">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-black mb-3">
                    ٢
                  </div>
                  <h3 className="text-sm font-bold text-white print:text-slate-900 mb-1">
                    عدالة تقييم الأداء (KPI)
                  </h3>
                  <p className="text-xs text-slate-400 print:text-slate-600 leading-relaxed">
                    احتساب مكافآت ونسب الالتزام تلقائياً بناءً على سرعة الإنجاز وجودة الاعتماد دون أهواء شخصية.
                  </p>
                </div>

                <div className="bg-slate-800/50 print:bg-slate-50 p-4 rounded-2xl border border-slate-700/60 print:border-slate-200">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center font-black mb-3">
                    ٣
                  </div>
                  <h3 className="text-sm font-bold text-white print:text-slate-900 mb-1">
                    حماية الأصول والموارد
                  </h3>
                  <p className="text-xs text-slate-400 print:text-slate-600 leading-relaxed">
                    منع هدر منظفات ومستهلكات المقر، وضبط مواعيد إغلاق التكييفات والإنارة بأكواد محددة وصارمة.
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 2: Task Lifecycle (Visual Flow) */}
        {(selectedCategory === "all" || selectedCategory === "task_lifecycle") && isMatch("دورة حياة المهمة") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200">
            <div className="flex items-center justify-between gap-4 mb-6">
              <div>
                <span className="text-xs font-bold text-indigo-600 uppercase">كيف تسير الأمور عملياً؟</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900 mt-0.5">
                  دورة حياة المهمة اليومية (من القالب وحتى الاعتماد) 🔄
                </h2>
              </div>
              <span className="hidden md:inline-flex text-xs font-semibold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                ٧ خطوات أساسية
              </span>
            </div>

            <p className="text-xs md:text-sm text-slate-600 mb-6 leading-relaxed">
              كل عمل يتم داخل الشركة يتبع مساراً دقيقاً ومحكماً يضمن أن كل شخص يعرف ما المطلوب منه، متى يبدأ، وكيف يُعتمد عمله:
            </p>

            {/* Step Switcher Tabs (For mobile & interactive click) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-6 no-print">
              {[
                { step: 1, title: "القالب المعياري" },
                { step: 2, title: "توليد الوردية" },
                { step: 3, title: "استلام الميدان" },
                { step: 4, title: "صورة قبل والبدء" },
                { step: 5, title: "التنفيذ وصورة بعد" },
                { step: 6, title: "تدقيق المشرف" },
                { step: 7, title: "مؤشر الأداء KPI" },
              ].map((s) => (
                <button
                  key={s.step}
                  onClick={() => setActiveStepTab(s.step)}
                  className={`py-2 px-2.5 rounded-xl text-center text-xs font-bold transition cursor-pointer border ${
                    activeStepTab === s.step
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                      : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                  }`}
                >
                  <span className="block text-[10px] opacity-75">المرحلة {s.step}</span>
                  <span className="truncate block mt-0.5">{s.title}</span>
                </button>
              ))}
            </div>

            {/* Interactive Step Detail Card */}
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 md:p-6 mb-8">
              {activeStepTab === 1 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-indigo-700 font-bold text-sm">
                    <SettingsIcon /> المرحلة الأولى: تعريف إجراء التشغيل المعياري (SOP Template)
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    تقوم إدارة العمليات بإنشاء بطاقة الإجراء المعياري لكل مكان في المبنى (مثل: مسح أرضيات الاستقبال، تعقيم حمامات الدور الثاني، تجهيز محطة القهوة). يحدد القالب: الأدوات المطلوبة، الزمن المقدر، ومواعيد التكرار (يومي/أسبوعي).
                  </p>
                </div>
              )}
              {activeStepTab === 2 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-indigo-700 font-bold text-sm">
                    <Calendar className="w-4 h-4" /> المرحلة الثانية: التوليد التلقائي لمهام الوردية
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    مع بداية كل يوم وتلقائياً دون تدخل يدوي، يقوم النظام بمطابقة جدول عمل كل موظف وحضوره، ويولد قائمة مهامه اليومية الخاصة بمنطقته وورديته بدقة.
                  </p>
                </div>
              )}
              {activeStepTab === 3 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-indigo-700 font-bold text-sm">
                    <Smartphone className="w-4 h-4" /> المرحلة الثالثة: استعراض المهام على شاشة العامل
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    يفتح الموظف هاتفه المحمول فيجد المهام مرتبة زمنياً من الصباح حتى نهاية الوردية مع تفاصيل كل مهمة وصورة الدليل الإرشادي للأماكن التي يجب التركيز عليها.
                  </p>
                </div>
              )}
              {activeStepTab === 4 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-amber-700 font-bold text-sm">
                    <Camera className="w-4 h-4" /> المرحلة الرابعة: التقاط صورة "قبل العمل" وبدء العداد
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    يصل العامل للمنطقة ويضغط زر "بدء المهمة"، فيطلب منه النظام صورة فورية للمكان قبل تنظيفه. فور التقاط الصورة، يبدأ العداد الرقمي بحساب وقت التنفيذ الفعلي لضمان عدم الاستعجال أو التراخي.
                  </p>
                </div>
              )}
              {activeStepTab === 5 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-emerald-700 font-bold text-sm">
                    <CheckCircle2 className="w-4 h-4" /> المرحلة الخامسة: إنهاء العمل والتقاط صورة "بعد العمل"
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    بعد إتمام التنظيف بالأدوات المخصصة، يضغط العامل "إنهاء المهمة"، ثم يلتقط صورة واضحة لنفس الزاوية تثبت النظافة التامة، ويكتب أي ملاحظة ثم يرسل المهمة للمشرف.
                  </p>
                </div>
              )}
              {activeStepTab === 6 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-purple-700 font-bold text-sm">
                    <ShieldCheck className="w-4 h-4" /> المرحلة السادسة: مراجعة واعتماد المشرف (Auditing)
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    يصل إشعار للمشرف في شاشة "الاعتمادات". يقوم بفتح الصورتين جنباً إلى جنب وتكبيرهما. إذا كان العمل متقناً يعتمد المهمة بدرجة (A أو B أو C). وإذا كانت هناك ملاحظة يعيد المهمة للعامل (Rework) مع توضيح السبب.
                  </p>
                </div>
              )}
              {activeStepTab === 7 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-blue-700 font-bold text-sm">
                    <BarChart2 className="w-4 h-4" /> المرحلة السابعة: الاحتساب الفوري في مؤشرات الأداء (KPI)
                  </div>
                  <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
                    بمجرد الاعتماد، تنعكس النتيجة مباشرة في بطاقة أداء الموظف: تزيد نسبة التزامه، ويُسجل وقت تنفيذه، وتظهر له في شاشة "مؤشراتي" كإنجاز يعزز مكافأته الشهرية.
                  </p>
                </div>
              )}
            </div>

            {/* Visual Process Flow Diagram (Box Drawing / ASCII Art style for clear hierarchy) */}
            <div className="bg-slate-900 text-slate-200 p-4 md:p-6 rounded-2xl overflow-x-auto font-mono text-[11px] leading-relaxed border border-slate-800">
              <div className="text-indigo-400 font-bold mb-2">
                # خريطة تدفق البيانات والقرارات في Naris Ops:
              </div>
              <pre className="whitespace-pre">
{`┌─────────────────────┐       ┌──────────────────────┐       ┌──────────────────────┐
│  قالب الـ SOP المعياري  │ ────► │  توليد وردية اليوم     │ ────► │  شاشة هاتف الموظف    │
│  (الأدوات والوقت والمنطقة)│       │  (ربط الموظف بمكانه) │       │  (الاستعراض والتنبيه)│
└─────────────────────┘       └──────────────────────┘       └──────────┬───────────┘
                                                                        │
┌─────────────────────┐       ┌──────────────────────┐                  │
│    تسليم المهمة      │ ◄──── │  صورة "بعد" + الملاحظة │ ◄────────────────┘ (بدء + صورة "قبل")
└──────────┬──────────┘       └──────────────────────┘
           │
           ▼
┌────────────────────────────────────────────────────────┐
│             فحص وتدقيق المشرف (Approvals)              │
│       مقارنة الصورتين + مراجعة وقت التنفيذ الفعلي       │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
    [ قرار: الاعتماد بنجاح ]     [ قرار: طلب إعادة العمل ⚠️ ]
     - تقييم الجودة (A / B / C)   - كتابة سبب الملاحظة بالتحديد
     - زيادة نقاط التزام العامل  - إعادة المهمة لشاشة العامل فوراً
     - أرشفة الصور في التقارير   - تنفيذ الإصلاح ورفع صورة جديدة`}
              </pre>
            </div>
          </section>
        )}

        {/* SECTION 3: Executive & Admin Guide */}
        {(selectedCategory === "all" || selectedCategory === "admin_guide") && isMatch("دليل الإدارة العليا") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                <Grid className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-indigo-600 uppercase">صناع القرار والمديرون</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  دليل الإدارة العليا ولوحة القيادة 👔
                </h2>
              </div>
            </div>

            <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
              تتيح لوحة تحكم الإدارة مراقبة النبض التشغيلي للمقر بالكامل في شاشة واحدة دون الحاجة للدخول في تفاصيل تقنية معقدة:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-2xl p-4.5 bg-slate-50/50">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-2">
                  <BarChart2 className="w-4 h-4 text-indigo-600" />
                  قراءة مؤشرات الإنجاز والجودة (Overview)
                </h3>
                <ul className="text-xs text-slate-600 space-y-2 list-disc list-inside">
                  <li><strong>نسبة الإنجاز اليومي:</strong> توضح النسبة المئوية للمهام المنتهية مقارنة بإجمالي مهام المقر.</li>
                  <li><strong>طابور الاعتماد:</strong> ينبه الإدارة فوراً إذا كان المشرفون يتأخرون في مراجعة المهام المسلمة.</li>
                  <li><strong>توزيع درجات الجودة:</strong> رسم بياني يوضح نسبة المهام الحاصلة على A مقابل B و C لمعرفة مستوى النظافة العام.</li>
                </ul>
              </div>

              <div className="border border-slate-200 rounded-2xl p-4.5 bg-slate-50/50">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-emerald-600" />
                  إدارة الموظفين وتوزيع الورديات الذكي
                </h3>
                <ul className="text-xs text-slate-600 space-y-2 list-disc list-inside">
                  <li><strong>إضافة وتعديل الموظفين:</strong> تعيين ساعات الوردية وأيام العمل الرسمية وكلمة المرور.</li>
                  <li><strong>خاصية إعادة التعيين الذكي:</strong> في حال غياب موظف أو إيقافه مؤقتاً، بضغطة زر واحدة يتم تحويل مهامه المعلقة لزميله الحاضر فوراً دون تعطيل المقر.</li>
                  <li><strong>التحكم في الصلاحيات:</strong> فصل صلاحيات المشرف عن الموظف الميداني لضمان سرية التقييمات.</li>
                </ul>
              </div>

              <div className="border border-slate-200 rounded-2xl p-4.5 bg-slate-50/50">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-2">
                  <FileText className="w-4 h-4 text-purple-600" />
                  استخراج التقارير التنفيذية الشهرية (PDF)
                </h3>
                <ul className="text-xs text-slate-600 space-y-2 list-disc list-inside">
                  <li>من تبويب <strong>التقارير والأرشيف</strong>، اختر الشهر المطلوب والموظف المطلوب.</li>
                  <li>يعطيك النظام تقريراً منسقاً يشتمل على: إجمالي ساعات العمل، عدد المهام المنفذة في الوقت، وعدد المهام المعادة، ومتوسط التقييم العام.</li>
                  <li>يتم حفظ التقرير كـ PDF رسمي لتقديمه في اجتماعات الإدارة أو لصرف مكافآت التميز الشهرية.</li>
                </ul>
              </div>

              <div className="border border-slate-200 rounded-2xl p-4.5 bg-slate-50/50">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 mb-2">
                  <Layers className="w-4 h-4 text-amber-600" />
                  ضبط أدلة الجودة وبنود الـ SOP
                </h3>
                <ul className="text-xs text-slate-600 space-y-2 list-disc list-inside">
                  <li>إمكانية إضافة مساحات جديدة تم افتتاحها بالمقر وتسميتها بدقة (Floor / Zone).</li>
                  <li>تحديد الأدوات الموصى بها (مثل نوع المطهر، لون الفوطة المخصصة للزجاج vs المكاتب).</li>
                  <li>إرفاق صورة استرشادية توضح المعيار المطلوب للشكل النهائي لتدريب الموظفين الجدد.</li>
                </ul>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 4: Supervisor & Quality Guide */}
        {(selectedCategory === "all" || selectedCategory === "supervisor_guide") && isMatch("دليل المشرف والجودة") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-emerald-600 uppercase">ضباط الجودة والمشرفون</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  دليل المشرف الميداني والاعتمادات 🛡️
                </h2>
              </div>
            </div>

            <div className="bg-emerald-50/60 border border-emerald-200 rounded-2xl p-4 text-xs text-emerald-900 leading-relaxed font-semibold">
              المشرف هو صمام أمان المنظومة. التوقيع على المهمة يعني أنك رأيت الصور وتأكدت شخصياً من مطابقتها لأعلى معايير النظافة والتشغيل.
            </div>

            <div className="space-y-4">
              <h3 className="text-base font-bold text-slate-900">
                خطوات فحص المهمة في شاشة "طابور الاعتماد والتدقيق":
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="border border-slate-200 rounded-2xl p-4 bg-white">
                  <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-800 font-bold flex items-center justify-center text-xs mb-2">
                    ١
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 mb-1">فحص الصورتين المقارنتين</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    اضغط على الصور لتكبيرها (Lightbox). تأكد أن صورة "بعد" لنفس المكان الذي ظهر في صورة "قبل"، وأن الإضاءة والزاوية تكشف التفاصيل بوضوح.
                  </p>
                </div>

                <div className="border border-slate-200 rounded-2xl p-4 bg-white">
                  <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-800 font-bold flex items-center justify-center text-xs mb-2">
                    ٢
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 mb-1">مراجعة وقت التنفيذ</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    افحص المؤقت: إذا كانت مهمة تتطلب 30 دقيقة وتم إنهاؤها في دقيقتين فقط، فهذا مؤشر على تسرع الموظف ويجب تنبيهه ومراجعة المكان على أرض الواقع.
                  </p>
                </div>

                <div className="border border-slate-200 rounded-2xl p-4 bg-white">
                  <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-800 font-bold flex items-center justify-center text-xs mb-2">
                    ٣
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 mb-1">منح التقييم أو الإعادة</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    اختر الدرجة المناسبة (A أو B أو C) ثم اضغط "اعتماد". وإذا كان العمل غير مرضٍ، اضغط "طلب إعادة العمل" واكتب السبب بالتفصيل.
                  </p>
                </div>
              </div>

              {/* Table of Grades Explanation */}
              <div className="overflow-x-auto border border-slate-200 rounded-2xl mt-4">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-4">درجة التقييم</th>
                      <th className="py-3 px-4">المعيار المطلوب</th>
                      <th className="py-3 px-4">الأثر على مؤشر الموظف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium text-slate-700">
                    <tr className="hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <span className="font-bold text-emerald-700 bg-emerald-100 py-0.5 px-2.5 rounded-full">
                          الدرجة (A) ممتاز
                        </span>
                      </td>
                      <td className="py-3 px-4">تنفيذ مثالي، صور واضحة جداً، التزام تام بالوقت والأدوات.</td>
                      <td className="py-3 px-4 text-emerald-700 font-bold">100% نقاط جودة + أولوية مكافآت</td>
                    </tr>
                    <tr className="hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <span className="font-bold text-indigo-700 bg-indigo-100 py-0.5 px-2.5 rounded-full">
                          الدرجة (B) جيد جداً
                        </span>
                      </td>
                      <td className="py-3 px-4">تنفيذ سليم ومقبول، مع ملاحظة طفيفة تم التنبيه عليها شفهياً.</td>
                      <td className="py-3 px-4 text-indigo-700 font-bold">85% نقاط جودة</td>
                    </tr>
                    <tr className="hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <span className="font-bold text-amber-700 bg-amber-100 py-0.5 px-2.5 rounded-full">
                          الدرجة (C) مقبول
                        </span>
                      </td>
                      <td className="py-3 px-4">تنفيذ بالحد الأدنى المقبول ولكن يتطلب متابعة دقيقة في الوردية التالية.</td>
                      <td className="py-3 px-4 text-amber-700 font-bold">70% نقاط جودة مع إشعار للمشرف</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 5: Cleaner & Frontline Staff Guide */}
        {(selectedCategory === "all" || selectedCategory === "cleaner_guide") && isMatch("دليل موظف الميدان") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-amber-600 uppercase">عمال النظافة وموظفو الميدان</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  دليل موظف التشغيل والميدان خطوة بخطوة 🧹
                </h2>
              </div>
            </div>

            <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
              هذا النظام صُمم ليكون صديقك اليومي في العمل؛ فهو ينظم مهامك ويثبت مجهودك وتعبك أمام الجميع بالصور دون الحاجة لجدال أو شكوك:
            </p>

            <div className="space-y-4">
              {[
                {
                  step: "١",
                  title: "تسجيل الدخول مع بداية الوردية",
                  desc: "افتح الرابط على هاتفك، اكتب اسمك التقني (المكتوب في بطاقتك أو المسلم لك من المشرف)، واكتب كلمة المرور واضغط 'تسجيل الدخول'.",
                  icon: Lock
                },
                {
                  step: "٢",
                  title: "استعراض جدول مهام اليوم",
                  desc: "ستظهر لك قائمة بكل الأماكن التي ستقوم بتنظيفها أو تشغيلها اليوم. يمكنك تصفيتها إلى: 'معلقة'، 'قيد التنفيذ'، أو 'المكتملة'.",
                  icon: Calendar
                },
                {
                  step: "٣",
                  title: "فتح تفاصيل المهمة وقراءة التعليمات",
                  desc: "اضغط على كارت المهمة: ستجد اسم المكان، والوقت الموصى به، والأدوات التي يجب أن تأخذها معك من غرفة المخزن، بالإضافة لصورة توضيحية لما يجب أن يكون عليه المكان.",
                  icon: Eye
                },
                {
                  step: "٤",
                  title: "التقاط صورة قبل وبدء المهمة",
                  desc: "عند وصولك للمكان، اضغط زر 'بدء المهمة'. ستفتح الكاميرا، قف في زاوية جيدة واضغط زر التصوير ثم 'تأكيد'. سيبدأ عداد الوقت بالعمل تلقائياً.",
                  icon: Camera
                },
                {
                  step: "٥",
                  title: "تنفيذ العمل بإتقان وأمان",
                  desc: "قم بتنفيذ التنظيف أو التعقيم بأمان مع ارتداء القفازات والأدوات الوقائية.",
                  icon: CheckCircle2
                },
                {
                  step: "٦",
                  title: "إنهاء المهمة والتقاط صورة بعد",
                  desc: "عند الانتهاء، اضغط زر 'إنهاء المهمة'، والتقط صورة واضحة لنفس الزاوية تثبت نظافة المكان وترتيبه. اكتب أي ملاحظة واضغط 'إرسال للمشرف'.",
                  icon: Sparkles
                },
                {
                  step: "٧",
                  title: "متابعة صفحة 'مؤشراتي'",
                  desc: "في أي وقت يمكنك الضغط على زر 'مؤشراتي 🏆' في أعلى الصفحة لمعرفة كم مهمة أنهيتها اليوم بنجاح ودرجة تقييمك الحالية من المشرف.",
                  icon: BarChart2
                }
              ].map((item, idx) => {
                const ItemIcon = item.icon;
                return (
                  <div key={idx} className="flex items-start gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
                    <div className="w-8 h-8 rounded-xl bg-amber-500 text-white font-black flex items-center justify-center text-xs shrink-0 mt-0.5">
                      {item.step}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <ItemIcon className="w-4 h-4 text-slate-500" />
                        <h4 className="text-sm font-bold text-slate-900">{item.title}</h4>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed font-medium">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* SECTION 6: Visual Photo Standards Guide */}
        {(selectedCategory === "all" || selectedCategory === "photo_standards") && isMatch("معايير التصوير والتوثيق") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
                <Camera className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-rose-600 uppercase">دليل الجودة البصري</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  معايير التصوير المقبول والمرفوض بالصور 📸
                </h2>
              </div>
            </div>

            <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
              الصورة هي وثيقة العمل الرسمية. صورة واحدة غير واضحة قد تجعل المشرف يعيد لك المهمة وتؤثر على درجة جودتك. التزم دائماً بهذه القواعد البسيطة:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Accepted Photo Criteria */}
              <div className="border-2 border-emerald-300 rounded-3xl p-5 bg-emerald-50/30 space-y-4">
                <div className="flex items-center gap-2 text-emerald-800 font-extrabold text-sm">
                  <BadgeCheck className="w-5 h-5 text-emerald-600" />
                  <span>الصورة المقبولة والمعتمدة (درجة A) ✅</span>
                </div>
                
                <ul className="space-y-2.5 text-xs text-slate-700">
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span><strong>إضاءة جيدة وكافية:</strong> تشغيل إنارة المكان بالكامل قبل التصوير.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span><strong>زاوية واسعة وشاملة:</strong> تُظهر الأرضية والمكاتب معاً وليس نقطة ضيقة في الأرض.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span><strong>تطابق زاوية "قبل" مع "بعد":</strong> الوقوف في نفس المكان لتسهيل المقارنة المباشرة.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span><strong>ثبات الهاتف:</strong> الإمساك بالهاتف بكلتا اليدين والانتظار ثانية حتى لا تخرج الصورة مهتزة.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span><strong>نظافة العدسة:</strong> مسح عدسة الكاميرا بفوطة نظيفة لمنع الصور الضبابية.</span>
                  </li>
                </ul>
              </div>

              {/* Rejected Photo Criteria */}
              <div className="border-2 border-rose-300 rounded-3xl p-5 bg-rose-50/30 space-y-4">
                <div className="flex items-center gap-2 text-rose-800 font-extrabold text-sm">
                  <XCircle className="w-5 h-5 text-rose-600" />
                  <span>الصورة المرفوضة (تستوجب إعادة العمل Rework) ❌</span>
                </div>
                
                <ul className="space-y-2.5 text-xs text-slate-700">
                  <li className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span><strong>الصور المظلمة:</strong> التصوير بدون تشغيل إضاءة الغرفة أو في وجود ظل حاجب.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span><strong>الصور المهتزة أو غير الحادة (Blurry):</strong> التقاط الصورة أثناء المشي السريع.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span><strong>التصوير المقرب جداً (Close-up):</strong> تصوير بلاطة واحدة أو سلة مهملات فقط دون إظهار بقية الغرفة.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span><strong>تغطية الكاميرا أو التصوير في الفراغ:</strong> تصوير السقف أو تغطية العدسة بالإصبع.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span><strong>اختلاف المكان:</strong> تصوير غرفة في "قبل" وتصوير غرفة أخرى في "بعد".</span>
                  </li>
                </ul>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 7: Switch Labels & Energy Guide */}
        {(selectedCategory === "all" || selectedCategory === "switch_guide") && isMatch("تشغيل الكهرباء والأجهزة") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-sky-50 text-sky-600 flex items-center justify-center font-bold">
                <Lightbulb className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-sky-600 uppercase">الأجهزة والمرافق</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  دليل مفاتيح التشغيل والإنارة والطاقة 💡
                </h2>
              </div>
            </div>

            <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
              للحفاظ على أمان المبنى ومنع تلف الأجهزة أو انقطاع السيرفرات، تم وضع بطاقات تعريفية (Labels) برمز ولون محدد على جميع قواطع ومفاتيح الكهرباء:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-2xl">
                <div className="flex items-center gap-2 mb-2 text-emerald-800 font-bold text-sm">
                  <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
                  المفاتيح الخضراء (تشغيل يومي)
                </div>
                <p className="text-xs text-emerald-700 leading-relaxed">
                  مفاتيح الإضاءة العادية للمكاتب والاستقبال والممرات. يتم تشغيلها عند بدء العمل وإطفاؤها عند مغادرة آخر موظف بالمقر.
                </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 p-4 rounded-2xl">
                <div className="flex items-center gap-2 mb-2 text-amber-800 font-bold text-sm">
                  <span className="w-3 h-3 rounded-full bg-amber-500"></span>
                  المفاتيح الصفراء (تكييفات وأجهزة)
                </div>
                <p className="text-xs text-amber-700 leading-relaxed">
                  قواطع التكييفات وشاشات العرض وغلايات الشاي. يتم تشغيلها في أوقات الدوام فقط وإطفاؤها تماماً قبل إغلاق المقر لتوفير الطاقة ومنع الحرائق.
                </p>
              </div>

              <div className="bg-rose-50 border border-rose-200 p-4 rounded-2xl">
                <div className="flex items-center gap-2 mb-2 text-rose-800 font-bold text-sm">
                  <span className="w-3 h-3 rounded-full bg-rose-500 animate-pulse"></span>
                  المفاتيح الحمراء (ممنوع اللمس ⛔)
                </div>
                <p className="text-xs text-rose-700 leading-relaxed">
                  تغذي خوادم السيرفر، كاميرات المراقبة، أجهزة الإنذار، وثلاجات المعامل. يمنع لمسها أو إطفاؤها إطلاقاً إلا بأمر مباشر من إدارة تكنولوجيا المعلومات.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 8: Inventory & Consumables Control */}
        {(selectedCategory === "all" || selectedCategory === "inventory_guide") && isMatch("مراقبة المخزون والمعدات") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center font-bold">
                <Box className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-purple-600 uppercase">العهدة والمستلزمات</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  دليل إدارة المخزون والمعدات والمنظفات 📦
                </h2>
              </div>
            </div>

            <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
              يقوم نظام المخزون بمراقبة رصيد مستلزمات النظافة (المنظفات، معقمات الأيدي، رولات المناديل، أكياس القمامة، وفوط المايكروفايبر) لمنع نفاذها المفاجئ:
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-2xl p-4.5 bg-slate-50/50 space-y-2">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  حد التنبيه الذكي (Minimum Stock Alert)
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  لكل صنف بالمخزن "حد أمان". عندما يقل الرصيد عن هذا الحد، يُظهر النظام شريط تنبيه أحمر في شاشة المشرف والإدارة بضرورة الشراء فوراً قبل نفاذ الصنف بـ 48 ساعة.
                </p>
              </div>

              <div className="border border-slate-200 rounded-2xl p-4.5 bg-slate-50/50 space-y-2">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <BadgeCheck className="w-4 h-4 text-indigo-500" />
                  تسجيل المنصرف والوارد بسهولة
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  عند تسليم عامل النظافة عبوة مطهر أو أدوات، يقوم المشرف بإنقاص العدد بضغطة زر وتحديد اسم المستلم، مما يمنع ضياع العهد ويحافظ على موارد الشركة.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* SECTION 9: FAQs and Troubleshooting */}
        {(selectedCategory === "all" || selectedCategory === "faq") && isMatch("الأسئلة الشائعة") && (
          <section className="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                <HelpCircle className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-bold text-indigo-600 uppercase">الدعم والمساعدة</span>
                <h2 className="text-xl md:text-2xl font-black text-slate-900">
                  الأسئلة الأكثر تكراراً واستكشاف الأخطاء (FAQ) ❓
                </h2>
              </div>
            </div>

            <p className="text-xs md:text-sm text-slate-600 leading-relaxed">
              إليك إجابات سريعة وواضحة على أكثر الأسئلة والمواقف التي قد تواجهها أثناء استخدام النظام:
            </p>

            <div className="space-y-3">
              {filteredFaqs.map((faq, index) => {
                const isOpen = expandedFaq === index;
                return (
                  <div
                    key={index}
                    className="border border-slate-200 rounded-2xl overflow-hidden transition"
                  >
                    <button
                      onClick={() => setExpandedFaq(isOpen ? null : index)}
                      className="w-full p-4 text-right flex items-center justify-between gap-4 bg-slate-50/70 hover:bg-slate-100/70 transition cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 font-bold text-xs flex items-center justify-center shrink-0">
                          ؟
                        </span>
                        <span className="text-xs md:text-sm font-bold text-slate-800">
                          {faq.q}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-slate-400 bg-white border border-slate-200 py-0.5 px-2 rounded-md">
                          {faq.role}
                        </span>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-slate-500" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-slate-500" />
                        )}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="p-4 bg-white border-t border-slate-200 text-xs md:text-sm text-slate-600 leading-relaxed">
                        {faq.a}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredFaqs.length === 0 && (
                <div className="text-center py-8 text-slate-400 text-xs font-semibold">
                  لم يتم العثور على نتائج تطابق كلمة البحث "{searchQuery}". حاول البحث بكلمة أخرى مثل "كلمة المرور"، "الصورة"، أو "التقارير".
                </div>
              )}
            </div>
          </section>
        )}

        {/* Corporate Footer Summary */}
        <div className="bg-slate-100 border border-slate-200 rounded-2xl p-6 text-center text-xs text-slate-500 space-y-2">
          <div className="flex items-center justify-center gap-2">
            <ProfessorLogo variant="icon" className="w-5 h-5" />
            <span className="font-bold text-slate-700">منظومة Naris Ops الرقمية لإدارة الجودة والتشغيل</span>
          </div>
          <p className="max-w-md mx-auto text-[11px] text-slate-500 leading-relaxed">
            تم إعداد وتطوير هذا المركز المعرفي لضمان أعلى مستويات الشفافية والانضباط التشغيلي بمقر الشركة. لأي استفسار إضافي يرجى التواصل مع إدارة العمليات.
          </p>
        </div>

      </main>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
