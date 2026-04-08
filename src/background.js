import {
  buildBridgeInstallBundle,
  buildSessionBundle,
  captureCookiesForPage,
  capturePageDataFromTab,
  hasUsableSessionMaterial
} from "./session-capture.js";
import {
  decodeRequestBody,
  inferCandidate,
  isInstallReadyCandidate,
  isSameSiteRequest,
  normalizeHeaders,
  pickBestCandidate
} from "./capture-heuristics.js";
import { redactSensitiveText } from "./redaction.js";

const DEFAULT_CAPTURE_TIMEOUT_MS = 20000;
const RESOLVE_SCORE_THRESHOLD = 10;
const RECENT_REQUEST_TTL_MS = 2 * 60 * 1000;
const CAPTURE_STATE_STORAGE_KEY = "genericSessionCaptureState";
const CAPTURE_MAX_AGE_MS = 5 * 60 * 1000;
const captureJobs = new Map();
const recentRequestsByTab = new Map();
let captureState;
const captureLocks = new Set();

installRequestListeners();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "capture-request-trace") {
    void captureRequestTrace(message)
      .then((result) => {
        sendResponse({
          ok: true,
          result
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: sanitizeErrorMessage(error)
        });
      });

    return true;
  }

  if (message?.type === "start-capture-session") {
    void startCaptureSession(message)
      .then((result) => {
        sendResponse({
          ok: true,
          result
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: sanitizeErrorMessage(error)
        });
      });

    return true;
  }

  if (message?.type === "get-capture-session-state") {
    void getCaptureSessionState()
      .then((result) => {
        sendResponse({
          ok: true,
          result
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: sanitizeErrorMessage(error)
        });
      });

    return true;
  }

  if (message?.type === "update-capture-session-state") {
    void updateCaptureSessionState(message)
      .then((result) => {
        sendResponse({
          ok: true,
          result
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: sanitizeErrorMessage(error)
        });
      });

    return true;
  }

  return false;
});

async function captureRequestTrace(request) {
  const tabId = Number(request?.tabId);
  const tabUrl = typeof request?.tabUrl === "string" ? request.tabUrl : "";
  const timeoutMs =
    Number(request?.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_CAPTURE_TIMEOUT_MS;

  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("Active tab was not available.");
  }

  if (!tabUrl) {
    throw new Error("Active tab URL was not available.");
  }

  const existing = captureJobs.get(tabId);
  if (existing) {
    throw new Error("A capture is already running for this tab.");
  }

  const recentTrace = buildRecentTrace(tabId, tabUrl);
  if (recentTrace.selectedRequest && recentTrace.selectedRequest.inferred?.score >= RESOLVE_SCORE_THRESHOLD) {
    return {
      ...recentTrace,
      source: "recent-cache"
    };
  }

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finishCapture(tabId, resolve);
    }, timeoutMs);

    captureJobs.set(tabId, {
      tabId,
      tabUrl,
      startedAt: Date.now(),
      requestMap: new Map(),
      resolve,
      reject,
      timeoutId
    });

    if (request?.reloadTab === true) {
      chrome.tabs.reload(tabId, () => {
        if (chrome.runtime.lastError) {
          cleanupCapture(tabId);
          reject(new Error(chrome.runtime.lastError.message));
        }
      });
    }
  });
}

function installRequestListeners() {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const candidate = upsertRecentCandidate(details);
      const requestBody = decodeRequestBody(details.requestBody);
      candidate.requestBodyText = requestBody.text;
      candidate.requestBodyJson = requestBody.json;
      candidate.requestBodyKeys = requestBody.keys;
      mirrorCandidateToJob(details.tabId, details, candidate);
      void maybeCompletePendingCapture(details.tabId);
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["requestBody"]
  );

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const candidate = upsertRecentCandidate(details);
      candidate.requestHeaders = normalizeHeaders(details.requestHeaders);
      mirrorCandidateToJob(details.tabId, details, candidate);
      void maybeCompletePendingCapture(details.tabId);
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["requestHeaders", "extraHeaders"]
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const candidate = upsertRecentCandidate(details);
      candidate.responseHeaders = normalizeHeaders(details.responseHeaders);
      candidate.statusCode = details.statusCode;
      mirrorCandidateToJob(details.tabId, details, candidate);
      void maybeCompletePendingCapture(details.tabId);
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders", "extraHeaders"]
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const candidate = upsertRecentCandidate(details);
      candidate.completed = true;
      candidate.completedAt = Date.now();
      candidate.statusCode = details.statusCode;
      mirrorCandidateToJob(details.tabId, details, candidate);
      void maybeCompletePendingCapture(details.tabId);
    },
    { urls: ["http://*/*", "https://*/*"] }
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const candidate = upsertRecentCandidate(details);
      candidate.completed = true;
      candidate.error = details.error;
      mirrorCandidateToJob(details.tabId, details, candidate);
      void maybeCompletePendingCapture(details.tabId);
    },
    { urls: ["http://*/*", "https://*/*"] }
  );
}

function getOrCreateCandidate(requestMap, details) {
  const existing = requestMap.get(details.requestId);
  if (existing) {
    return existing;
  }

  const candidate = {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    type: details.type,
    startedAt: Date.now(),
    requestHeaders: {},
    responseHeaders: {},
    requestBodyText: "",
    requestBodyJson: null,
    requestBodyKeys: [],
    statusCode: 0,
    completed: false,
    error: ""
  };
  requestMap.set(details.requestId, candidate);
  return candidate;
}

function upsertRecentCandidate(details) {
  pruneRecentRequests();
  const requestMap = getRecentRequestMap(details.tabId);
  return getOrCreateCandidate(requestMap, details);
}

function mirrorCandidateToJob(tabId, details, sourceCandidate) {
  const job = captureJobs.get(tabId);
  if (!job || !shouldCapture(job, details.url)) {
    return;
  }

  const candidate = getOrCreateCandidate(job.requestMap, details);
  Object.assign(candidate, structuredClone(sourceCandidate));
  maybeResolve(job);
}

function shouldCapture(job, requestUrl) {
  return isSameSiteRequest(job.tabUrl, requestUrl);
}

function maybeResolve(job) {
  const best = pickBestCandidate([...job.requestMap.values()]);
  if (!best || best.inferred.score < RESOLVE_SCORE_THRESHOLD) {
    return;
  }

  if (!isInstallReadyRequest(best) && !best.inferred.usesSse) {
    return;
  }

  finishCapture(job.tabId, job.resolve);
}

function finishCapture(tabId, resolve) {
  const job = captureJobs.get(tabId);
  if (!job) {
    return;
  }

  const liveTrace = buildTraceFromCandidates(job.tabUrl, [...job.requestMap.values()]);
  const recentTrace = buildRecentTrace(tabId, job.tabUrl);
  const selectedRequest = choosePreferredRequest(liveTrace.selectedRequest, recentTrace.selectedRequest);
  const requests = mergeRequests(liveTrace.requests, recentTrace.requests);

  cleanupCapture(tabId);
  resolve({
    capturedAt: new Date().toISOString(),
    tabUrl: job.tabUrl,
    source: liveTrace.selectedRequest ? "live-capture" : "recent-cache",
    selectedRequest,
    requests
  });
}

function cleanupCapture(tabId) {
  const job = captureJobs.get(tabId);
  if (!job) {
    return;
  }

  clearTimeout(job.timeoutId);
  captureJobs.delete(tabId);
}

function sanitizeErrorMessage(error) {
  if (error instanceof Error) {
    return redactSensitiveText(error.message || "Failed to capture request trace.");
  }

  return "Failed to capture request trace.";
}

function getRecentRequestMap(tabId) {
  const key = Number.isInteger(tabId) ? tabId : -1;
  const existing = recentRequestsByTab.get(key);
  if (existing) {
    return existing;
  }

  const created = new Map();
  recentRequestsByTab.set(key, created);
  return created;
}

function pruneRecentRequests() {
  const cutoff = Date.now() - RECENT_REQUEST_TTL_MS;

  for (const [tabId, requestMap] of recentRequestsByTab.entries()) {
    for (const [requestId, candidate] of requestMap.entries()) {
      if ((candidate.completedAt || candidate.startedAt || 0) < cutoff) {
        requestMap.delete(requestId);
      }
    }

    if (requestMap.size === 0) {
      recentRequestsByTab.delete(tabId);
    }
  }
}

function buildRecentTrace(tabId, tabUrl) {
  pruneRecentRequests();
  const requestMap = recentRequestsByTab.get(tabId);
  return buildTraceFromCandidates(tabUrl, requestMap ? [...requestMap.values()] : []);
}

function buildTraceFromCandidates(tabUrl, candidates) {
  const requests = candidates
    .filter((candidate) => isSameSiteRequest(tabUrl, candidate.url))
    .map((candidate) => ({
      ...candidate,
      inferred: inferCandidate(candidate)
    }))
    .sort((left, right) => left.startedAt - right.startedAt);

  const best = pickBestCandidate(requests);

  return {
    requests,
    selectedRequest: best && best.inferred.score >= RESOLVE_SCORE_THRESHOLD ? best : null
  };
}

function choosePreferredRequest(primary, fallback) {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  return primary.inferred?.score >= fallback.inferred?.score ? primary : fallback;
}

function mergeRequests(primary, secondary) {
  const deduped = new Map();

  for (const request of [...primary, ...secondary]) {
    if (!request?.requestId) {
      continue;
    }

    const existing = deduped.get(request.requestId);
    if (!existing || (request.inferred?.score ?? 0) >= (existing.inferred?.score ?? 0)) {
      deduped.set(request.requestId, request);
    }
  }

  return [...deduped.values()].sort((left, right) => left.startedAt - right.startedAt);
}

async function startCaptureSession(request) {
  const tabId = Number(request?.tabId);
  const tabUrl = typeof request?.tabUrl === "string" ? request.tabUrl : "";
  const origin = typeof request?.origin === "string" ? request.origin : "";
  const title = typeof request?.title === "string" ? request.title : "";

  if (!Number.isInteger(tabId) || tabId < 0 || !tabUrl || !origin) {
    throw new Error("Active tab context was not available.");
  }

  await setCaptureSessionState({
    phase: "capturing",
    isError: false,
    tabId,
    tabUrl,
    origin,
    title,
    updatedAt: new Date().toISOString(),
    message: "Waiting for the next real chat request.",
    capturedPackage: null
  });

  const recentTrace = buildRecentTrace(tabId, tabUrl);
  if (isInstallReadyRequest(recentTrace.selectedRequest)) {
    await completePendingCapture({
      phase: "capturing",
      isError: false,
      tabId,
      tabUrl,
      origin,
      title
    }, recentTrace);
  }

  return await getCaptureSessionState();
}

async function maybeCompletePendingCapture(tabId) {
  const state = await getCaptureSessionState();
  if (!state || state.phase !== "capturing" || state.tabId !== tabId) {
    return;
  }

  const updatedAt = Date.parse(state.updatedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > CAPTURE_MAX_AGE_MS) {
    await setCaptureSessionState({
      ...state,
      phase: "failed",
      isError: true,
      updatedAt: new Date().toISOString(),
      message: "Capture timed out. Start capture again, then send one real chat message."
    });
    return;
  }

  const requestTrace = buildRecentTrace(state.tabId, state.tabUrl);
  if (!isInstallReadyRequest(requestTrace.selectedRequest)) {
    return;
  }

  await completePendingCapture(state, requestTrace);
}

async function completePendingCapture(state, requestTrace) {
  const lockKey = String(state.tabId);
  if (captureLocks.has(lockKey)) {
    return;
  }

  captureLocks.add(lockKey);

  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (!tab?.id) {
      throw new Error("The source tab is no longer available.");
    }

    const activeTarget = {
      tab,
      origin: state.origin,
      hostname: safeHostname(state.origin),
      title: tab.title || state.title || ""
    };
    const pageUrl = typeof tab.url === "string" && tab.url ? tab.url : state.tabUrl;
    const [pageData, cookies] = await Promise.all([
      capturePageDataFromTab({
        chromeApi: chrome,
        tabId: state.tabId
      }),
      captureCookiesForPage(chrome, pageUrl)
    ]);

    if (!hasUsableSessionMaterial({
      cookies,
      selectedHeaders: requestTrace?.selectedRequest?.requestHeaders
    })) {
      throw new Error(`No cookies were found for ${safeHostname(state.origin)}. Sign in first, then try again.`);
    }

    const bundle = buildSessionBundle({
      activeTarget,
      requestTrace,
      pageData,
      cookies,
      extensionVersion: chrome.runtime.getManifest().version || "0.0.0"
    });

    await setCaptureSessionState({
      ...state,
      phase: "captured",
      isError: false,
      updatedAt: new Date().toISOString(),
      message: "Session package captured.",
      capturedPackage: buildBridgeInstallBundle(bundle)
    });
  } catch (error) {
    await setCaptureSessionState({
      ...state,
      phase: "failed",
      isError: true,
      updatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Failed to capture the session package."
    });
  } finally {
    captureLocks.delete(lockKey);
  }
}

async function getCaptureSessionState() {
  if (captureState !== undefined) {
    return captureState;
  }

  const stored = await chrome.storage.local.get(CAPTURE_STATE_STORAGE_KEY);
  captureState = normalizeCaptureSessionState(stored?.[CAPTURE_STATE_STORAGE_KEY]);
  return captureState;
}

async function setCaptureSessionState(value) {
  captureState = normalizeCaptureSessionState(value);
  await chrome.storage.local.set({
    [CAPTURE_STATE_STORAGE_KEY]: captureState
  });
  await syncActionBadge(captureState);
  return captureState;
}

async function updateCaptureSessionState(partial) {
  const current = await getCaptureSessionState();
  if (!current) {
    return null;
  }

  return await setCaptureSessionState({
    ...current,
    ...(typeof partial?.phase === "string" ? { phase: partial.phase } : {}),
    ...(typeof partial?.message === "string" ? { message: partial.message } : {}),
    ...(partial?.isError === true ? { isError: true } : partial?.isError === false ? { isError: false } : {}),
    updatedAt: new Date().toISOString()
  });
}

function isInstallReadyRequest(selectedRequest) {
  return Boolean(
    selectedRequest &&
    typeof selectedRequest.url === "string" &&
    selectedRequest.url &&
    isInstallReadyCandidate(selectedRequest)
  );
}

function normalizeCaptureSessionState(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    phase: typeof value.phase === "string" ? value.phase : "idle",
    isError: value.isError === true,
    tabId: Number.isInteger(value.tabId) ? value.tabId : -1,
    tabUrl: typeof value.tabUrl === "string" ? value.tabUrl : "",
    origin: typeof value.origin === "string" ? value.origin : "",
    title: typeof value.title === "string" ? value.title : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    message: typeof value.message === "string" ? value.message : "",
    capturedPackage: isPlainObject(value.capturedPackage) ? value.capturedPackage : null
  };
}

async function syncActionBadge(state) {
  const tabId = state?.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  const badge = getBadgePresentation(state?.phase);
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: badge.text
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: badge.color
    });
    await chrome.action.setBadgeTextColor({
      tabId,
      color: "#ffffff"
    });
  } catch {
    // Ignore badge failures; they are only visual feedback.
  }
}

function getBadgePresentation(phase) {
  if (phase === "capturing") {
    return {
      text: "...",
      color: "#d87b33"
    };
  }

  if (phase === "captured" || phase === "installed" || phase === "copied to clipboard") {
    return {
      text: "OK",
      color: "#2f7d32"
    };
  }

  if (phase === "failed") {
    return {
      text: "!",
      color: "#8e2621"
    };
  }

  return {
    text: "",
    color: "#000000"
  };
}

function safeHostname(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
