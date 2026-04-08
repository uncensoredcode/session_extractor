import test from "node:test";
import assert from "node:assert/strict";
import { buildBridgeInstallBundle, buildSessionBundle, hasUsableSessionMaterial } from "../src/session-capture.js";

test("session bundle does not turn captured model hints into integration models", () => {
  const bundle = buildSessionBundle({
    activeTarget: {
      origin: "https://chat.example.test",
      hostname: "chat.example.test",
      title: "Chat Example"
    },
    requestTrace: {
      selectedRequest: {
        url: "https://chat.example.test/api/chat/completions",
        method: "POST",
        type: "xmlhttprequest",
        requestHeaders: {
          Authorization: "Bearer token"
        },
        inferred: {
          score: 20,
          modelHints: ["model-alpha"],
          responseContentType: "text/event-stream",
          usesSse: true
        }
      },
      requests: []
    },
    pageData: {
      localStorage: {},
      sessionStorage: {},
      title: "Chat Example",
      userAgent: "Mozilla/5.0 Chrome/146.0.0.0"
    },
    cookies: [{ name: "session", value: "cookie" }],
    clock: () => "2026-04-07T10:00:00.000Z",
    extensionVersion: "0.1.0"
  });

  assert.deepEqual(bundle.integration, {
    label: "Chat Example"
  });
  assert.deepEqual(bundle.metadata.selectedRequest.modelHints, ["model-alpha"]);
});

test("header-auth captures are considered usable without cookies", () => {
  assert.equal(
    hasUsableSessionMaterial({
      cookies: [],
      selectedHeaders: {
        Authorization: "Bearer token",
        "x-msh-session-id": "session-1"
      }
    }),
    true
  );

  assert.equal(
    hasUsableSessionMaterial({
      cookies: [],
      selectedHeaders: {
        Accept: "*/*",
        "User-Agent": "Mozilla/5.0"
      }
    }),
    false
  );
});

test("bridge install bundle strips bulky storage and request history while keeping the selected request", () => {
  const bundle = buildSessionBundle({
    activeTarget: {
      origin: "https://chatgpt.com",
      hostname: "chatgpt.com",
      title: "ChatGPT"
    },
    requestTrace: {
      selectedRequest: {
        url: "https://chatgpt.com/backend-api/f/conversation",
        method: "POST",
        type: "fetch",
        requestHeaders: {
          Authorization: "Bearer token"
        },
        requestBodyJson: {
          model: "auto"
        },
        inferred: {
          score: 20,
          modelHints: ["auto"],
          responseContentType: "text/event-stream",
          usesSse: true
        }
      },
      requests: [
        {
          requestId: "req-1",
          url: "https://chatgpt.com/backend-api/f/conversation",
          requestHeaders: {
            Authorization: "Bearer token"
          },
          inferred: {
            score: 20
          }
        },
        {
          requestId: "req-bootstrap",
          url: "https://chat.z.ai/api/v1/chats/new",
          method: "POST",
          requestHeaders: {
            Authorization: "Bearer token",
            Cookie: "session=secret-cookie",
            "x-subsquid-token": "subsquid-1"
          },
          inferred: {
            looksLikeBootstrapRequest: true
          }
        }
      ]
    },
    pageData: {
      localStorage: {
        large: "x".repeat(1000)
      },
      sessionStorage: {
        transient: "y".repeat(1000)
      },
      title: "ChatGPT",
      userAgent: "Mozilla/5.0 Chrome/146.0.0.0"
    },
    cookies: [{ name: "session", value: "cookie" }],
    clock: () => "2026-04-07T10:00:00.000Z",
    extensionVersion: "0.1.0"
  });

  const installBundle = buildBridgeInstallBundle(bundle);

  assert.deepEqual(installBundle.localStorage, {});
  assert.deepEqual(installBundle.sessionStorage, {});
  assert.deepEqual(installBundle.metadata.requestCapture.requests, [
    {
      url: "https://chat.z.ai/api/v1/chats/new",
      method: "POST",
      requestHeaders: {
        Authorization: "Bearer token",
        "x-subsquid-token": "subsquid-1"
      },
      inferred: {
        looksLikeBootstrapRequest: true
      }
    }
  ]);
  assert.equal(
    installBundle.metadata.requestCapture.selectedRequest.url,
    "https://chatgpt.com/backend-api/f/conversation"
  );
  assert.equal(installBundle.headers.Authorization, "Bearer token");
});
