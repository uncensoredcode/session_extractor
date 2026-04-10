import test from "node:test";
import assert from "node:assert/strict";

import { hydrateCaptureSessionStateFromStorage, normalizeCaptureSessionState } from "../src/capture-state.js";

test("normalizeCaptureSessionState returns null for invalid values", () => {
  assert.equal(normalizeCaptureSessionState(null), null);
  assert.equal(normalizeCaptureSessionState(undefined), null);
  assert.equal(normalizeCaptureSessionState("nope"), null);
});

test("hydrateCaptureSessionStateFromStorage resets stale status to idle on reload", () => {
  const now = () => "2026-04-10T12:00:00.000Z";
  const stored = {
    phase: "captured",
    isError: false,
    tabId: 42,
    tabUrl: "https://chat.example.com/app",
    origin: "https://chat.example.com",
    title: "Chat",
    updatedAt: "2026-04-10T11:55:00.000Z",
    message: "Session package captured.",
    capturedPackage: {
      origin: "https://chat.example.com"
    }
  };

  assert.deepEqual(hydrateCaptureSessionStateFromStorage(stored, now), {
    phase: "idle",
    isError: false,
    tabId: -1,
    tabUrl: "",
    origin: "",
    title: "",
    updatedAt: "2026-04-10T12:00:00.000Z",
    message: "",
    capturedPackage: {
      origin: "https://chat.example.com"
    }
  });
});

test("hydrateCaptureSessionStateFromStorage leaves clean idle state alone", () => {
  const stored = {
    phase: "idle",
    isError: false,
    tabId: -1,
    tabUrl: "",
    origin: "",
    title: "",
    updatedAt: "2026-04-10T11:55:00.000Z",
    message: "",
    capturedPackage: null
  };

  assert.deepEqual(hydrateCaptureSessionStateFromStorage(stored), stored);
});
