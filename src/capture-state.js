function getCurrentTimestamp() {
  return new Date().toISOString();
}

export function normalizeCaptureSessionState(value, now = getCurrentTimestamp) {
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
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now(),
    message: typeof value.message === "string" ? value.message : "",
    capturedPackage: isPlainObject(value.capturedPackage) ? value.capturedPackage : null
  };
}

export function hydrateCaptureSessionStateFromStorage(value, now = getCurrentTimestamp) {
  const state = normalizeCaptureSessionState(value, now);
  if (!state) {
    return null;
  }

  if (!shouldResetStoredCaptureStatus(state)) {
    return state;
  }

  return {
    ...state,
    phase: "idle",
    isError: false,
    tabId: -1,
    tabUrl: "",
    origin: "",
    title: "",
    updatedAt: now(),
    message: ""
  };
}

function shouldResetStoredCaptureStatus(state) {
  return (
    state.phase !== "idle" ||
    state.isError ||
    Boolean(state.message) ||
    state.tabId !== -1 ||
    Boolean(state.tabUrl) ||
    Boolean(state.origin) ||
    Boolean(state.title)
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
