const DEFAULT_API_BASE_URL = "https://naris-api.bezaverse.com";
const LOCAL_API_BASE_URL = "http://localhost:4000";

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function isGoogleAiStudioPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.endsWith(".run.app") ||
    host.endsWith(".googleusercontent.com") ||
    host === "aistudio.google.com" ||
    host.endsWith(".aistudio.google.com");
}

/**
 * Resolve one API origin for every frontend feature.
 * An explicitly empty VITE_API_BASE_URL is intentional: Docker/Nginx proxies
 * /api and /health on the same origin. Google AI Studio Preview is detected
 * before that fallback so its Vite dev server never receives backend probes.
 */
export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;

  if (isGoogleAiStudioPreviewHost(hostname)) {
    return typeof configured === "string" && configured.trim()
      ? normalizeApiBaseUrl(configured)
      : DEFAULT_API_BASE_URL;
  }

  if (typeof configured === "string") {
    return normalizeApiBaseUrl(configured);
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return LOCAL_API_BASE_URL;
  }

  return DEFAULT_API_BASE_URL;
}

export const API_BASE_URL = getApiBaseUrl();
