import { getSiteHostnames, isCapturablePageUrl } from "./capture-heuristics.js";

export async function detectActiveTarget(chromeApi) {
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isCapturablePageUrl(tab.url)) {
    return null;
  }

  const url = new URL(tab.url);
  return {
    tab,
    origin: url.origin,
    hostname: url.hostname,
    title: tab.title || ""
  };
}

export async function captureCookiesForPage(chromeApi, pageUrl) {
  const url = new URL(pageUrl);
  const queries = new Map();

  queries.set(`url:${url.origin}`, { url: url.origin });
  for (const hostname of getSiteHostnames(pageUrl)) {
    queries.set(`domain:${hostname}`, { domain: hostname });
  }

  const cookieLists = await Promise.all(
    [...queries.values()].map((query) => chromeApi.cookies.getAll(query))
  );
  const seen = new Set();

  return cookieLists
    .flat()
    .map((cookie) => ({
      domain: cookie.domain,
      expirationDate: cookie.expirationDate,
      hostOnly: cookie.hostOnly,
      httpOnly: cookie.httpOnly,
      name: cookie.name,
      path: cookie.path,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      session: cookie.session,
      storeId: cookie.storeId,
      value: cookie.value
    }))
    .filter((cookie) => {
      const key = [cookie.domain, cookie.path, cookie.name].join("|");
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

export async function capturePageDataFromTab({ chromeApi, tabId }) {
  const [{ result }] = await chromeApi.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: readPageDataFromPage
  });

  return normalizePageData(result);
}

export function buildSessionBundle({
  activeTarget,
  requestTrace,
  pageData,
  cookies,
  clock = () => new Date().toISOString(),
  extensionVersion = "0.0.0"
}) {
  const selectedRequest = requestTrace?.selectedRequest ?? null;
  const selectedHeaders = sanitizeSelectedHeaders(selectedRequest?.requestHeaders);

  return {
    schemaVersion: 1,
    source: "browser-extension",
    capturedAt: clock(),
    origin: activeTarget.origin,
    cookies,
    localStorage: pageData.localStorage,
    sessionStorage: pageData.sessionStorage,
    headers: selectedHeaders,
    integration: {
      label: pageData.title || activeTarget.title || activeTarget.hostname
    },
    metadata: {
      browser: detectBrowserName(pageData.userAgent),
      extensionVersion,
      tabTitle: pageData.title || activeTarget.title || "",
      captureMode: "next-request",
      selectedRequest: selectedRequest
        ? {
            url: selectedRequest.url,
            method: selectedRequest.method,
            type: selectedRequest.type,
            score: selectedRequest.inferred?.score ?? 0,
            modelHints: selectedRequest.inferred?.modelHints ?? [],
            responseContentType: selectedRequest.inferred?.responseContentType ?? "",
            usesSse: selectedRequest.inferred?.usesSse === true
          }
        : null,
      requestCapture: requestTrace
    }
  };
}

export function buildBridgeInstallBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return bundle;
  }

  const metadata = bundle.metadata && typeof bundle.metadata === "object" && !Array.isArray(bundle.metadata)
    ? bundle.metadata
    : {};
  const selectedRequest = metadata.selectedRequest && typeof metadata.selectedRequest === "object" && !Array.isArray(metadata.selectedRequest)
    ? metadata.selectedRequest
    : null;
  const requestCapture = metadata.requestCapture && typeof metadata.requestCapture === "object" && !Array.isArray(metadata.requestCapture)
    ? metadata.requestCapture
    : null;
  const requestCaptureSelectedRequest =
    requestCapture?.selectedRequest && typeof requestCapture.selectedRequest === "object" && !Array.isArray(requestCapture.selectedRequest)
      ? requestCapture.selectedRequest
      : selectedRequest;
  const compactRequests = buildCompactInstallRequests(requestCapture);

  return {
    ...bundle,
    localStorage: {},
    sessionStorage: {},
    metadata: {
      ...metadata,
      requestCapture: requestCapture
        ? {
            ...requestCapture,
            requests: compactRequests,
            selectedRequest: requestCaptureSelectedRequest
          }
        : requestCapture
    }
  };
}

function buildCompactInstallRequests(requestCapture) {
  if (!requestCapture || typeof requestCapture !== "object" || Array.isArray(requestCapture)) {
    return [];
  }

  const requests = Array.isArray(requestCapture.requests) ? requestCapture.requests : [];
  return requests.flatMap((request) => {
    const compact = compactInstallRequest(request);
    return compact ? [compact] : [];
  });
}

function compactInstallRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return null;
  }

  const inferred = request.inferred && typeof request.inferred === "object" && !Array.isArray(request.inferred)
    ? request.inferred
    : null;
  if (inferred?.looksLikeBootstrapRequest !== true) {
    return null;
  }

  const requestHeaders = sanitizeSelectedHeaders(
    request.requestHeaders && typeof request.requestHeaders === "object" && !Array.isArray(request.requestHeaders)
      ? request.requestHeaders
      : {}
  );

  return {
    ...(typeof request.url === "string" ? { url: request.url } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
    inferred: {
      looksLikeBootstrapRequest: true
    }
  };
}

function normalizePageData(value) {
  if (!value || typeof value !== "object") {
    return {
      localStorage: {},
      sessionStorage: {},
      title: "",
      userAgent: navigator.userAgent
    };
  }

  return {
    localStorage: normalizeStorageSnapshot(value.localStorage),
    sessionStorage: normalizeStorageSnapshot(value.sessionStorage),
    title: typeof value.title === "string" ? value.title : "",
    userAgent: typeof value.userAgent === "string" && value.userAgent ? value.userAgent : navigator.userAgent
  };
}

function normalizeStorageSnapshot(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => typeof key === "string" && typeof entry === "string")
  );
}

function sanitizeSelectedHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      if (typeof key !== "string" || typeof value !== "string") {
        return false;
      }

      const normalized = key.toLowerCase();
      return normalized !== "cookie" && value.trim().length > 0;
    })
  );
}

export function hasUsableSessionMaterial({ cookies, selectedHeaders }) {
  if (Array.isArray(cookies) && cookies.length > 0) {
    return true;
  }

  if (!selectedHeaders || typeof selectedHeaders !== "object" || Array.isArray(selectedHeaders)) {
    return false;
  }

  return Object.entries(selectedHeaders).some(([key, value]) => {
    if (typeof value !== "string" || !value.trim()) {
      return false;
    }

    const normalized = key.toLowerCase();
    return normalized === "authorization" || normalized.startsWith("x-");
  });
}

function detectBrowserName(userAgent) {
  if (/Edg\//.test(userAgent)) {
    return "Edge";
  }

  if (/Firefox\//.test(userAgent)) {
    return "Firefox";
  }

  if (/Chrome\//.test(userAgent)) {
    return "Chrome";
  }

  if (/Safari\//.test(userAgent)) {
    return "Safari";
  }

  return "Unknown";
}

function readPageDataFromPage() {
  function readStorageSnapshot(storage) {
    const entries = {};
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key) {
          continue;
        }

        const value = storage.getItem(key);
        if (typeof value === "string") {
          entries[key] = value;
        }
      }
    } catch {
      return {};
    }

    return entries;
  }

  return {
    localStorage: readStorageSnapshot(window.localStorage),
    sessionStorage: readStorageSnapshot(window.sessionStorage),
    title: document.title || "",
    userAgent: navigator.userAgent
  };
}
