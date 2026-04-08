import { detectActiveTarget } from "./session-capture.js";

const STORAGE_KEY = "genericSessionCaptureSettings";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4318";
const DEFAULT_STATUS = {
  isError: false,
  key: "idle",
  detail: ""
};

const captureButton = document.getElementById("start-capture");
const sendButton = document.getElementById("send-to-bridge");
const copyButton = document.getElementById("copy-to-clipboard");
const bridgeUrlInput = document.getElementById("bridge-url");
const statusPanel = document.getElementById("status-panel");
const statusKeyNode = document.getElementById("status-key");
const statusDetailNode = document.getElementById("status-detail");
const activeOriginNode = document.getElementById("active-origin");
const state = {
  activeTarget: null,
  bridgeUrl: "",
  capturedPackage: null,
  isBusy: false,
  status: DEFAULT_STATUS
};

captureButton.addEventListener("click", () => {
  void startCapture();
});

sendButton.addEventListener("click", () => {
  void sendToBridge();
});

copyButton.addEventListener("click", () => {
  void copyToClipboard();
});

bridgeUrlInput.addEventListener("input", () => {
  state.bridgeUrl = bridgeUrlInput.value.trim();
  void saveBridgeUrl(state.bridgeUrl);
});

void init();

async function init() {
  state.bridgeUrl = await loadBridgeUrl();
  bridgeUrlInput.value = state.bridgeUrl;
  await refreshViewState();
  render();
  setInterval(() => {
    void refreshViewState();
  }, 1000);
}

async function startCapture() {
  await withBusy(async () => {
    const target = await requireActiveTarget();
    const granted = await requestOriginPermission(target.origin);
    if (!granted) {
      throw new Error(`Access was not granted for ${target.origin}.`);
    }

    const response = await chrome.runtime.sendMessage({
      type: "start-capture-session",
      tabId: target.tab.id,
      tabUrl: target.tab.url,
      origin: target.origin,
      title: target.title
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to start the session capture.");
    }

    applyCaptureSessionState(response.result);
  }, "Failed to start the session capture.");
}

async function sendToBridge() {
  await withBusy(async () => {
    if (!state.capturedPackage) {
      throw new Error("Capture a session package first.");
    }

    const bridgeUrl = getResolvedBridgeUrl(state.bridgeUrl);

    const providerId = deriveProviderId(state.capturedPackage.origin);
    const response = await fetch(
      `${bridgeUrl}/v1/providers/${encodeURIComponent(providerId)}/session-package`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(state.capturedPackage)
      }
    );

    if (!response.ok) {
      throw new Error(await readBridgeError(response));
    }

    await persistCaptureStatus({
      phase: "installed",
      isError: false,
      message: "Session package installed."
    });
  }, "Failed to install the session package.");
}

async function copyToClipboard() {
  await withBusy(async () => {
    if (!state.capturedPackage) {
      throw new Error("Capture a session package first.");
    }

    await navigator.clipboard.writeText(`${JSON.stringify(state.capturedPackage, null, 2)}\n`);
    await persistCaptureStatus({
      phase: "copied to clipboard",
      isError: false,
      message: "Session package copied."
    });
  }, "Failed to copy the session package.");
}

async function refreshActiveTarget() {
  state.activeTarget = await detectActiveTarget(chrome).catch(() => null);
}

async function refreshViewState() {
  await refreshActiveTarget();
  const captureState = await getCaptureSessionState();
  applyCaptureSessionState(captureState);
  render();
}

async function requireActiveTarget() {
  await refreshActiveTarget();
  if (!state.activeTarget) {
    throw new Error("Open an authenticated http(s) app tab first.");
  }

  return state.activeTarget;
}

async function withBusy(work, fallbackDetail) {
  state.isBusy = true;
  render();

  try {
    await work();
  } catch (error) {
    await persistFailureStatus(error instanceof Error ? error.message : fallbackDetail);
  } finally {
    state.isBusy = false;
    render();
  }
}

function render() {
  captureButton.disabled = state.isBusy || !state.activeTarget;
  sendButton.disabled = state.isBusy || !state.capturedPackage;
  copyButton.disabled = state.isBusy || !state.capturedPackage;
  bridgeUrlInput.disabled = state.isBusy;

  activeOriginNode.textContent = state.activeTarget?.origin || "No active http(s) tab";
  statusKeyNode.textContent = state.status.key;
  statusDetailNode.textContent = state.status.detail || "";
  statusPanel.classList.toggle("error", Boolean(state.status.isError));
}

async function loadBridgeUrl() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return typeof stored?.[STORAGE_KEY]?.bridgeUrl === "string" ? stored[STORAGE_KEY].bridgeUrl : "";
}

async function saveBridgeUrl(bridgeUrl) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      bridgeUrl
    }
  });
}

async function readBridgeError(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || `Bridge request failed with status ${response.status}.`;
  } catch {
    return `Bridge request failed with status ${response.status}.`;
  }
}

async function requestOriginPermission(origin) {
  if (!origin) {
    return false;
  }

  const permissions = {
    origins: [`${origin}/*`]
  };
  const existing = await chrome.permissions.contains(permissions);
  if (existing) {
    return true;
  }

  return chrome.permissions.request(permissions);
}

async function getCaptureSessionState() {
  const response = await chrome.runtime.sendMessage({
    type: "get-capture-session-state"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to read the capture state.");
  }

  return response.result;
}

async function persistCaptureStatus(partial) {
  const response = await chrome.runtime.sendMessage({
    type: "update-capture-session-state",
    ...partial
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to update the capture state.");
  }

  applyCaptureSessionState(response.result);
}

async function persistFailureStatus(message) {
  try {
    await persistCaptureStatus({
      phase: "failed",
      isError: true,
      message
    });
  } catch {
    state.status = {
      isError: true,
      key: "failed",
      detail: message
    };
  }
}

function applyCaptureSessionState(captureState) {
  state.capturedPackage = captureState?.capturedPackage || null;
  state.status = captureStateToStatus(captureState);
}

function normalizeBridgeUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    return url.origin;
  } catch {
    return "";
  }
}

function getResolvedBridgeUrl(value) {
  const normalized = normalizeBridgeUrl(value);
  if (normalized) {
    return normalized;
  }

  if (!value.trim()) {
    return DEFAULT_BRIDGE_URL;
  }

  throw new Error("Enter a valid Bridge URL first.");
}

function deriveProviderId(origin) {
  const hostname = safeHostname(origin).toLowerCase();
  const normalized = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "captured-site";
}

function safeHostname(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

function captureStateToStatus(captureState) {
  if (!captureState || typeof captureState !== "object") {
    return DEFAULT_STATUS;
  }

  return {
    isError: captureState.isError === true,
    key: typeof captureState.phase === "string" ? captureState.phase : DEFAULT_STATUS.key,
    detail: typeof captureState.message === "string" ? captureState.message : DEFAULT_STATUS.detail
  };
}
