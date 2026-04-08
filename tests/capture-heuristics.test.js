import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeRequestBody,
  getSiteHostnames,
  inferCandidate,
  isInstallReadyCandidate,
  isSameSiteRequest,
  pickBestCandidate
} from "../src/capture-heuristics.js";

test("same-site matching accepts api subdomains", () => {
  assert.equal(
    isSameSiteRequest("https://chat.example.com/app", "https://api.chat.example.com/v1/chat/completions"),
    true
  );
  assert.equal(
    isSameSiteRequest("https://chat.example.com/app", "https://analytics.other.net/pixel"),
    false
  );
});

test("site hostname expansion includes parent suffixes", () => {
  assert.deepEqual(getSiteHostnames("https://chat.example.com/app"), [
    "chat.example.com",
    "example.com"
  ]);
});

test("request body decoder parses JSON raw bodies", () => {
  const body = JSON.stringify({
    model: "alpha",
    messages: [{ role: "user", content: "hello" }]
  });

  const decoded = decodeRequestBody({
    raw: [
      {
        bytes: Uint8Array.from(Buffer.from(body)).buffer
      }
    ]
  });

  assert.equal(decoded.text, body);
  assert.deepEqual(decoded.json, {
    model: "alpha",
    messages: [{ role: "user", content: "hello" }]
  });
});

test("candidate inference identifies chat-like SSE requests", () => {
  const inferred = inferCandidate({
    url: "https://api.example.com/v1/chat/completions",
    method: "POST",
    type: "xmlhttprequest",
    requestHeaders: {
      Authorization: "Bearer token",
      Accept: "text/event-stream"
    },
    responseHeaders: {
      "Content-Type": "text/event-stream"
    },
    requestBodyText: '{"model":"alpha","messages":[{"role":"user","content":"hi"}]}',
    requestBodyJson: {
      model: "alpha",
      messages: [{ role: "user", content: "hi" }]
    },
    requestBodyKeys: ["messages", "model"],
    completed: true
  });

  assert.equal(inferred.usesSse, true);
  assert.equal(inferred.looksChatLike, true);
  assert.deepEqual(inferred.modelHints, ["alpha"]);
  assert.ok(inferred.score >= 10);
});

test("best candidate selection prefers chat requests over background traffic", () => {
  const best = pickBestCandidate([
    {
      url: "https://chat.example.com/metrics",
      method: "POST",
      type: "ping",
      requestHeaders: {},
      responseHeaders: {},
      requestBodyText: "{}",
      requestBodyJson: {},
      requestBodyKeys: [],
      completed: true,
      startedAt: 1
    },
    {
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      type: "xmlhttprequest",
      requestHeaders: {
        Authorization: "Bearer token"
      },
      responseHeaders: {
        "Content-Type": "text/event-stream"
      },
      requestBodyText: '{"model":"alpha","messages":[{"role":"user","content":"hi"}]}',
      requestBodyJson: {
        model: "alpha",
        messages: [{ role: "user", content: "hi" }]
      },
      requestBodyKeys: ["messages", "model"],
      completed: true,
      startedAt: 2
    }
  ]);

  assert.equal(best?.url, "https://api.example.com/v1/chat/completions");
  assert.equal(best?.inferred.modelHints[0], "alpha");
});

test("status probes on chat hostnames do not look like usable chat requests", () => {
  const inferred = inferCandidate({
    url: "https://chat.example.com/api/v2/users/status",
    method: "POST",
    type: "xmlhttprequest",
    requestHeaders: {
      Authorization: "Bearer token"
    },
    responseHeaders: {
      "Content-Type": "application/json"
    },
    requestBodyText: "{}",
    requestBodyJson: {},
    requestBodyKeys: [],
    completed: true
  });

  assert.equal(inferred.looksChatLike, false);
  assert.equal(inferred.looksLikeStatusProbe, true);
  assert.ok(inferred.score < 10);
});

test("bootstrap chat creation requests are not install-ready", () => {
  const candidate = {
    url: "https://chat.example.com/api/v2/chats/new",
    method: "POST",
    type: "xmlhttprequest",
    requestHeaders: {
      "X-Request-Id": "req-1"
    },
    responseHeaders: {
      "Content-Type": "application/json"
    },
    requestBodyText: '{"title":"New Chat","models":["alpha"],"chat_mode":"normal","project_id":""}',
    requestBodyJson: {
      title: "New Chat",
      models: ["alpha"],
      chat_mode: "normal",
      project_id: ""
    },
    requestBodyKeys: ["chat_mode", "models", "project_id", "title"],
    completed: true
  };

  const inferred = inferCandidate(candidate);

  assert.equal(inferred.looksLikeBootstrapRequest, true);
  assert.equal(isInstallReadyCandidate({ ...candidate, inferred }), false);
});

test("request body decoder parses framed connect+json bodies", () => {
  const payload = {
    chat_id: "chat-kimi",
    scenario: "SCENARIO_K2D5",
    message: {
      parent_id: "parent-kimi",
      role: "user",
      blocks: [
        {
          message_id: "",
          text: {
            content: "plus 2?"
          }
        }
      ]
    }
  };

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const envelope = new Uint8Array(5 + payloadBytes.length);
  envelope[0] = 0;
  envelope[1] = (payloadBytes.length >>> 24) & 0xff;
  envelope[2] = (payloadBytes.length >>> 16) & 0xff;
  envelope[3] = (payloadBytes.length >>> 8) & 0xff;
  envelope[4] = payloadBytes.length & 0xff;
  envelope.set(payloadBytes, 5);

  const decoded = decodeRequestBody({
    raw: [
      {
        bytes: envelope.buffer
      }
    ]
  });

  assert.deepEqual(decoded.json, payload);
  assert.deepEqual(decoded.keys, ["chat_id", "message", "scenario"]);
});

test("candidate inference treats framed Kimi chat requests as install-ready", () => {
  const payload = {
    chat_id: "chat-kimi",
    scenario: "SCENARIO_K2D5",
    tools: [
      {
        type: "TOOL_TYPE_SEARCH",
        search: {}
      }
    ],
    message: {
      parent_id: "parent-kimi",
      role: "user",
      blocks: [
        {
          message_id: "",
          text: {
            content: "plus 2?"
          }
        }
      ],
      scenario: "SCENARIO_K2D5"
    },
    options: {
      thinking: false
    }
  };

  const encoded = encodeConnectEnvelopeText(payload);
  const candidate = {
    url: "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
    method: "POST",
    type: "xmlhttprequest",
    requestHeaders: {
      Authorization: "Bearer token",
      "x-msh-session-id": "session-1",
      "connect-protocol-version": "1"
    },
    responseHeaders: {
      "Content-Type": "application/connect+json"
    },
    requestBodyText: encoded,
    requestBodyJson: payload,
    requestBodyKeys: Object.keys(payload).sort(),
    completed: true
  };

  const inferred = inferCandidate(candidate);

  assert.equal(inferred.hasMessagesField, true);
  assert.equal(inferred.hasConversationField, true);
  assert.ok(inferred.score >= 12);
  assert.equal(isInstallReadyCandidate({ ...candidate, inferred }), true);
});

test("install-ready connect chat requests do not need response completion once headers and body are captured", () => {
  const payload = {
    chat_id: "chat-kimi",
    message: {
      parent_id: "parent-kimi",
      role: "user",
      blocks: [
        {
          message_id: "",
          text: {
            content: "plus 10?"
          }
        }
      ]
    },
    options: {
      thinking: true
    }
  };

  const candidate = {
    url: "https://www.example.test/apiv2/chat",
    method: "POST",
    type: "xmlhttprequest",
    requestHeaders: {
      Authorization: "Bearer token",
      "connect-protocol-version": "1"
    },
    responseHeaders: {
      "Content-Type": "application/connect+json"
    },
    requestBodyText: encodeConnectEnvelopeText(payload),
    requestBodyJson: payload,
    requestBodyKeys: Object.keys(payload).sort(),
    completed: false
  };

  const inferred = inferCandidate(candidate);
  assert.equal(isInstallReadyCandidate({ ...candidate, inferred }), true);
});

function encodeConnectEnvelopeText(payload) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const envelope = new Uint8Array(5 + payloadBytes.length);
  envelope[0] = 0;
  envelope[1] = (payloadBytes.length >>> 24) & 0xff;
  envelope[2] = (payloadBytes.length >>> 16) & 0xff;
  envelope[3] = (payloadBytes.length >>> 8) & 0xff;
  envelope[4] = payloadBytes.length & 0xff;
  envelope.set(payloadBytes, 5);
  return new TextDecoder().decode(envelope);
}
