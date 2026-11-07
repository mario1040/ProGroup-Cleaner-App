import React, { useState, useRef, useEffect } from "react";
import { Camera, RefreshCw, Upload, CheckCircle, Loader2, AlertCircle, Trash2, ShieldCheck } from "lucide-react";
import { uploadToCloudinary } from "../lib/cloudinary";
import { deletePhoto } from "../lib/api-postgres";
import { compressImage } from "../lib/api-postgres";

interface PhotoCaptureProps {
  label: string;
  onPhotoUploaded: (metadata: { url: string; publicId: string; size: number; mimeType: string; takenAt: string }) => void;
  required?: boolean;
  storagePath: string;
  disabled?: boolean;
}

export default function PhotoCapture({ label, onPhotoUploaded, required = true, storagePath, disabled = false }: PhotoCaptureProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawBase64, setRawBase64] = useState<string | null>(null);
  const [compressedBase64, setCompressedBase64] = useState<string | null>(null);
  
  const [uploading, setUploading] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [uploadedPublicId, setUploadedPublicId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const isUploadingRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);

  const [originalSize, setOriginalSize] = useState<number>(0);
  const [compressedSize, setCompressedSize] = useState<number>(0);
  const [mimeType, setMimeType] = useState<string>("image/jpeg");
  const [takenAt, setTakenAt] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const triggerCamera = () => {
    if (disabled || uploading || isCompressing) return;
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploadedUrl(null);
    setProgress(0);
    
    const maxSize = 15 * 1024 * 1024;
    if (file.size > maxSize) {
      setError("حجم الصورة كبير جداً. الحد الأقصى المسموح به هو 15 ميجابايت.");
      return;
    }
    
    const validTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    if (file.type && !validTypes.includes(file.type.toLowerCase())) {
      setError("نوع الملف غير مدعوم. يرجى اختيار صورة بصيغة JPG، PNG، أو WEBP.");
      return;
    }

    const size = file.size;
    const timeStr = new Date().toISOString();

    setOriginalSize(size);
    setMimeType("image/jpeg");
    setTakenAt(timeStr);

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    const localUrl = URL.createObjectURL(file);
    previewUrlRef.current = localUrl;
    setPreviewUrl(localUrl);
    setIsCompressing(true);

    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64Str = reader.result as string;
      setRawBase64(base64Str);
      
      try {
        const compressed = await compressImage(base64Str, 1600, 1600, 0.75);
        setCompressedBase64(compressed);
        
        const base64Data = compressed.split(",")[1] || "";
        const compSize = Math.round((base64Data.length * 3) / 4);
        setCompressedSize(compSize);
      } catch (err) {
        console.warn("[PhotoCapture] Client-side compression warning, using original:", err);
        setCompressedBase64(base64Str);
        setCompressedSize(size);
      } finally {
        setIsCompressing(false);
      }
    };
    reader.onerror = () => {
      setError("حدث خطأ أثناء قراءة ملف الصورة من الكاميرا.");
      setIsCompressing(false);
    };
    reader.readAsDataURL(file);
  };

  const handleConfirmUpload = async () => {
    if (isUploadingRef.current || uploading || disabled) {
      console.warn("[PhotoCapture] Upload already in progress, ignoring duplicate call.");
      return;
    }

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("لا يوجد اتصال بالإنترنت حالياً. يتطلب التطبيق اتصالاً نشطاً لرفع الصور وحفظها.");
      return;
    }

    const payload = compressedBase64 || rawBase64;
    if (!payload) {
      setError("لم يتم اختيار صورة بعد. يرجى فتح الكاميرا والتقاط صورة أولاً.");
      return;
    }

    // Derive folder from storagePath (e.g. task-photos/{zoneId}/{taskId}/after.jpg)
    const folder = storagePath.split("/").slice(0, -1).join("/") || "task_photos";

    isUploadingRef.current = true;
    setUploading(true);
    setProgress(0);
    setError(null);

    console.log("[PhotoCapture] 🚀 Starting upload to Cloudinary:", {
      folder,
      originalSize,
      compressedSize,
      mimeType: "image/jpeg"
    });

    let progressInterval: ReturnType<typeof setInterval> | undefined;
    try {
      // Cloudinary unsigned uploads don't support real progress — simulate it.
      progressInterval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 90) return prev;
          return prev + Math.floor(Math.random() * 15) + 5;
        });
      }, 300);

      const pathParts = storagePath.split("/");
      if (pathParts.length < 4 || pathParts[0] !== "task-photos") {
        throw new Error("مسار صورة المهمة غير صالح. أعد فتح المهمة وحاول مرة أخرى.");
      }
      const taskId = pathParts[2];
      const side = pathParts[pathParts.length - 1].toLowerCase().startsWith("before") ? "before" : "after";
      const result = await uploadToCloudinary(payload, folder, { taskId, side });
      const publicId = result.public_id;
      if (!publicId || !result.secure_url) throw new Error("Cloudinary لم يُرجع معرف الصورة ورابطها الآمن.");
      const uploadedMetadata = {
        url: result.secure_url,
        publicId,
        size: result.bytes || compressedSize || originalSize || 0,
        mimeType: "image/jpeg",
        takenAt: takenAt || new Date().toISOString(),
      };
      console.log("[PhotoCapture] Photo uploaded successfully to Cloudinary:", uploadedMetadata);

      if (progressInterval) clearInterval(progressInterval);
      setProgress(100);
      setUploadedUrl(uploadedMetadata.url);
      setUploadedPublicId(publicId);
      onPhotoUploaded(uploadedMetadata);
    } catch (err: any) {
      console.error("[PhotoCapture] Photo persistence failed:", err);
      setError(err?.message || "تعذر حفظ الصورة. يرجى المحاولة مرة أخرى.");
    } finally {
      if (progressInterval) clearInterval(progressInterval);
      isUploadingRef.current = false;
      setUploading(false);
    }
  };

  const resetPhoto = () => {
    if (uploading) return;
    if (uploadedPublicId && uploadedUrl) {
      const parts = storagePath.split("/");
      const taskId = parts.length >= 3 ? parts[2] : "";
      if (taskId) void deletePhoto(uploadedPublicId, taskId).catch((err) => {
        console.error("[PhotoCapture] Cloudinary cleanup failed; asset may need manual cleanup.", err);
      });
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
    setRawBase64(null);
    setCompressedBase64(null);
    setUploadedUrl(null);
    setUploadedPublicId(null);
    setProgress(0);
    setError(null);
    setOriginalSize(0);
    setCompressedSize(0);
    setTakenAt("");
    isUploadingRef.current = false;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="border border-slate-200 rounded-2xl p-6 bg-white shadow-sm flex flex-col items-center justify-center text-center transition duration-200 hover:border-slate-300">
      <span className="text-sm font-bold text-slate-800 mb-4 flex items-center gap-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </span>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        disabled={disabled || uploading || isCompressing}
        className="hidden"
      />

      {!previewUrl && (
        <button
          type="button"
          onClick={disabled || uploading ? undefined : triggerCamera}
          disabled={disabled || uploading}
          className="flex flex-col items-center gap-3 py-8 px-10 bg-slate-50 border-2 border-dashed border-slate-300 hover:border-blue-500 hover:bg-blue-50/30 text-slate-600 rounded-2xl transition duration-200 cursor-pointer w-full max-w-sm group disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="p-4 bg-white rounded-full shadow-sm group-hover:scale-110 transition duration-200 border border-slate-100">
            <Camera className="w-8 h-8 text-blue-500" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-bold text-slate-700 group-hover:text-blue-600">افتح الكاميرا أو اختر صورة</span>
            <span className="text-xs text-slate-400">تصوير حي فوري ومباشر إلى السحابة</span>
          </div>
        </button>
      )}

      {previewUrl && (
        <div className="w-full max-w-sm flex flex-col gap-4">
          <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-slate-200 bg-slate-900 shadow-inner group">
            <img src={previewUrl} alt="معاينة الصورة" className="w-full h-full object-contain" />
            
            {isCompressing && (
              <div className="absolute inset-0 bg-slate-900/80 flex flex-col items-center justify-center text-white p-6 backdrop-blur-xs">
                <Loader2 className="w-8 h-8 text-blue-400 mb-2 animate-spin" />
                <span className="text-xs font-bold">جاري تجهيز وضغط الصورة...</span>
              </div>
            )}

            {uploading && (
              <div className="absolute inset-0 bg-slate-900/85 flex flex-col items-center justify-center text-white p-6 backdrop-blur-xs">
                <Loader2 className="w-8 h-8 text-blue-400 mb-2 animate-spin" />
                <span className="text-sm font-bold">
                  جاري رفع الصورة إلى Cloudinary... {progress}%
                </span>
                <div className="w-full bg-slate-800 h-2.5 rounded-full mt-3 overflow-hidden border border-slate-700 max-w-xs">
                  <div 
                    className="h-full transition-all duration-200 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)] bg-blue-500"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
              </div>
            )}

            {uploadedUrl && !uploading && (
              <div className="absolute inset-0 bg-emerald-950/40 backdrop-blur-2xs flex items-center justify-center text-white">
                <div className="bg-emerald-500 text-white rounded-full p-2.5 shadow-lg scale-110 animate-fade-in">
                  <CheckCircle className="w-8 h-8" />
                </div>
              </div>
            )}
          </div>

          <div className="bg-slate-50 rounded-xl p-3 text-right text-xs text-slate-600 border border-slate-100 flex flex-col gap-1.5 font-mono">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-slate-500">حجم الملف الأصلي:</span>
              <span className="text-slate-800 font-bold">{formatSize(originalSize)}</span>
            </div>
            {compressedSize > 0 && (
              <div className="flex justify-between items-center border-t border-slate-200/60 pt-1.5">
                <span className="font-semibold text-slate-500">الحجم المحسن للرفع:</span>
                <span className="text-emerald-600 font-bold flex items-center gap-1">
                  {formatSize(compressedSize)} {originalSize > 0 ? `(وفر ${Math.max(0, Math.round((1 - compressedSize / originalSize) * 100))}%)` : ""}
                </span>
              </div>
            )}
            <div className="flex justify-between items-center border-t border-slate-200/60 pt-1.5">
              <span className="font-semibold text-slate-500">صيغة الملف:</span>
              <span className="text-slate-800 font-bold">{mimeType}</span>
            </div>
            {takenAt && (
              <div className="flex justify-between items-center border-t border-slate-200/60 pt-1.5">
                <span className="font-semibold text-slate-500">وقت الالتقاط:</span>
                <span className="text-slate-800">{new Date(takenAt).toLocaleTimeString("ar-EG")}</span>
              </div>
            )}
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-xs flex flex-col gap-2 text-right">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
                <span className="font-semibold">{error}</span>
              </div>
              <button
                type="button"
                onClick={handleConfirmUpload}
                disabled={uploading || isCompressing || disabled}
                className="self-end px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold text-[11px] flex items-center gap-1.5 cursor-pointer transition shadow-xs disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" /> إعادة المحاولة
              </button>
            </div>
          )}

          <div className="flex gap-2 w-full">
            {uploadedUrl ? (
              <div className="w-full flex flex-col gap-2">
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-xs font-bold flex items-center justify-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0" />
                  <span>تم الرفع والتثبيت بنجاح في Cloudinary</span>
                </div>
                <button
                  type="button"
                  onClick={resetPhoto}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" /> إعادة التقاط صورة أخرى
                </button>
              </div>
            ) : (
              !uploading && (
                <>
                  <button
                    type="button"
                    onClick={disabled || isCompressing ? undefined : resetPhoto}
                    disabled={disabled || isCompressing}
                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 border border-slate-200 hover:border-slate-300 text-slate-700 rounded-xl text-xs font-bold cursor-pointer transition duration-150 flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> إلغاء وإعادة التقاط
                  </button>
                  <button
                    type="button"
                    onClick={disabled || isCompressing ? undefined : handleConfirmUpload}
                    disabled={disabled || isCompressing || (!compressedBase64 && !rawBase64)}
                    className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold cursor-pointer transition duration-150 flex items-center justify-center gap-1.5 shadow-sm shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Upload className="w-3.5 h-3.5" /> تأكيد ورفع سحابي
                  </button>
                </>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}