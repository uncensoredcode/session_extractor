# Generic Session Capture

Minimal Chrome/Edge MV3 extension for capturing an authenticated browser session from the active tab and packaging the next relevant app request for reuse.

## What It Does

- Watches network traffic from the active `http(s)` tab.
- Detects the next request that looks like a real chat or assistant request.
- Captures cookies, storage, request headers, and request metadata.
- Produces a compact session package you can copy or send to a Bridge service.

## Why It Is Minimal

- No third-party runtime dependencies.
- No bundler or framework.
- Plain JavaScript modules only. Local browser-module imports intentionally keep explicit `.js` specifiers.
- Tests run with the built-in Node test runner.

## Project Layout

- `src/` extension source files.
- `tests/` unit tests for request heuristics and bundle shaping.
- `dist/` generated unpacked-extension output from `npm run build`.

## Build And Test

```bash
npm test
npm run build
```

## Load The Extension

1. Build the extension with `npm run build`.
2. Open the browser extensions page.
3. Enable Developer Mode.
4. Choose "Load unpacked".
5. Select the generated `dist/` directory.

## Usage

1. Open a signed-in `http(s)` app tab.
2. Open the extension popup.
3. Click `Start Capture`.
4. If the app has not made a usable request yet, send one real message in the tab.
5. Return to the popup once the status changes to `captured`.
6. Click `Copy To Clipboard` or `Send to Bridge`.

## Bridge Install

The popup accepts an optional Bridge base URL. If left blank, it defaults to `http://127.0.0.1:4318`.

When sending, the extension issues:

```text
PUT /v1/providers/:providerId/session-package
```

The provider id is derived from the captured origin hostname.

## Captured Data

- Matching cookies for the target site.
- `localStorage` and `sessionStorage`.
- Selected non-cookie request headers.
- Request metadata used to identify the target request.
- Basic tab and browser metadata.

## How To Build The Bridge Session Schema

The Bridge payload is not built from one request. It is built from a short capture window that combines:

- page context from the active tab
- cookies for the site
- the best same-site request candidate
- a compact history of bootstrap requests that may help Bridge install the provider session

The implementation does this in two stages:

1. Capture a full session bundle with `buildSessionBundle(...)`.
2. Compact it into the Bridge install payload with `buildBridgeInstallBundle(...)`.

### 1. Listen To These Network Events

The extension listens to all `http://*/*` and `https://*/*` requests through `chrome.webRequest` and keeps a rolling per-tab request map.

Listen to these events and merge them by `requestId`:

- `onBeforeRequest`
  Extract the request body. Decode `formData` directly. Decode raw bytes as text. If the raw body is JSON, parse it. If plain JSON parsing fails, try decoding it as a Connect/gRPC-style envelope and parse the inner JSON payload.
- `onBeforeSendHeaders`
  Extract request headers. Normalize them into an object and drop `Cookie`.
- `onHeadersReceived`
  Extract response headers and response `statusCode`.
- `onCompleted`
  Mark the candidate as completed and record `completedAt`.
- `onErrorOccurred`
  Mark the candidate as completed and record the error.

Each candidate should keep at least:

- `requestId`
- `url`
- `method`
- `type`
- `startedAt`
- `requestHeaders`
- `responseHeaders`
- `requestBodyText`
- `requestBodyJson`
- `requestBodyKeys`
- `statusCode`
- `completed`
- `completedAt`
- `error`

The extension prunes requests older than 2 minutes, so the trace stays focused on the current interaction.

### 2. Only Consider Same-Site Requests

Before scoring, requests are filtered to the current site:

- exact same origin is accepted
- subdomains are accepted
- parent-site domains are accepted

For example, if the page is on `https://chat.example.com`, requests for `chat.example.com`, `api.chat.example.com`, and `example.com` are considered part of the same session surface.

### 3. Score And Select The Real App Request

Every same-site request is enriched with inferred traits. The important signals are:

- `POST` request: `+3`
- chat-like path or keys such as `chat`, `completion`, `conversation`, `assistant`, `message`, `prompt`, `generate`: `+4`
- message payload detected from fields like `messages`, `prompt`, `input`, or nested `message.content`: `+4`
- model field detected: `+4`
- conversation/session/thread-like field detected: `+2`
- SSE or event-stream response detected: `+3`
- auth-bearing header such as `Authorization` or `x-*`: `+2`
- non-empty request body captured: `+1`
- request completed: `+1`
- bootstrap-style request such as `new` or `create`: `-5`
- status/config/profile/telemetry probe: `-6`

The highest scoring same-site request becomes `selectedRequest` only if its score is at least `10`.

Capture completes only when that selected request is also install-ready. In practice, that means all of the following are true:

- it is not a bootstrap request
- it is not a status/config probe
- it has captured headers
- it has a captured body
- its score is at least `12`
- and it matches one of these stronger signals:
  - it uses SSE
  - it clearly carries message content
  - it has both conversation-like fields and model-like fields

### 4. Extract The Session Material

Once an install-ready request is found, capture the reusable session material:

- Cookies from the page origin.
- Cookies from every parent hostname derived from the page hostname.
- `localStorage` from the page.
- `sessionStorage` from the page.
- Page `title`.
- Page `userAgent`.
- The selected request headers, excluding `Cookie`.

Cookie capture queries both the exact origin and parent domains so a session stored on `.example.com` is still included when the active tab is on `chat.example.com`.

The capture is only considered usable if at least one of these is true:

- there is at least one cookie
- the selected request headers contain `Authorization`
- the selected request headers contain any `x-*` header

### 5. Build The Full Session Bundle

The full bundle produced by `buildSessionBundle(...)` looks like this:

```json
{
  "schemaVersion": 1,
  "source": "browser-extension",
  "capturedAt": "2026-04-07T10:00:00.000Z",
  "origin": "https://chat.example.com",
  "cookies": [
    {
      "domain": ".example.com",
      "expirationDate": 1775550000,
      "hostOnly": false,
      "httpOnly": true,
      "name": "session",
      "path": "/",
      "sameSite": "no_restriction",
      "secure": true,
      "session": false,
      "storeId": "0",
      "value": "..."
    }
  ],
  "localStorage": {
    "token": "..."
  },
  "sessionStorage": {
    "draft": "..."
  },
  "headers": {
    "Authorization": "Bearer ..."
  },
  "integration": {
    "label": "Chat Example"
  },
  "metadata": {
    "browser": "Chrome",
    "extensionVersion": "0.1.0",
    "tabTitle": "Chat Example",
    "captureMode": "next-request",
    "selectedRequest": {
      "url": "https://chat.example.com/api/chat",
      "method": "POST",
      "type": "fetch",
      "score": 20,
      "modelHints": ["model-alpha"],
      "responseContentType": "text/event-stream",
      "usesSse": true
    },
    "requestCapture": {
      "requests": [
        {
          "requestId": "123",
          "url": "https://chat.example.com/api/chat",
          "method": "POST",
          "type": "fetch",
          "requestHeaders": {
            "Authorization": "Bearer ..."
          },
          "responseHeaders": {
            "content-type": "text/event-stream"
          },
          "requestBodyText": "{\"messages\":[...]}",
          "requestBodyJson": {
            "messages": []
          },
          "requestBodyKeys": ["messages", "model"],
          "statusCode": 200,
          "completed": true,
          "error": "",
          "inferred": {
            "score": 20,
            "usesSse": true,
            "looksChatLike": true,
            "hasMessagesField": true,
            "hasModelField": true,
            "hasConversationField": false,
            "authHeaderNames": ["authorization"],
            "modelHints": ["model-alpha"],
            "responseContentType": "text/event-stream",
            "looksLikeBootstrapRequest": false,
            "looksLikeStatusProbe": false
          }
        }
      ],
      "selectedRequest": {
        "requestId": "123",
        "url": "https://chat.example.com/api/chat",
        "method": "POST",
        "type": "fetch",
        "requestHeaders": {
          "Authorization": "Bearer ..."
        },
        "inferred": {
          "score": 20,
          "usesSse": true,
          "hasMessagesField": true,
          "hasModelField": true,
          "modelHints": ["model-alpha"],
          "responseContentType": "text/event-stream",
          "looksLikeBootstrapRequest": false,
          "looksLikeStatusProbe": false
        }
      }
    }
  }
}
```

Field meaning:

- `origin`: origin of the active tab, used later to derive the Bridge provider id.
- `cookies`: de-duplicated cookies keyed by `domain + path + name`.
- `headers`: sanitized headers from the selected request only.
- `integration.label`: page title fallback chain: page title, tab title, hostname.
- `metadata.selectedRequest`: small summary of the chosen request for quick inspection.
- `metadata.requestCapture.requests`: full same-site trace retained from the capture window.
- `metadata.requestCapture.selectedRequest`: the full winning candidate from that trace.

### 6. Compact It For Bridge Installation

The popup does not send the full bundle directly. It sends the output of `buildBridgeInstallBundle(...)`.

That compaction step keeps the important session material but removes bulky page state:

- `localStorage` becomes `{}`
- `sessionStorage` becomes `{}`
- `metadata.requestCapture.requests` is reduced to bootstrap requests only
- bootstrap request headers are sanitized again, so `Cookie` is never forwarded there
- `metadata.requestCapture.selectedRequest` is preserved
- top-level `headers`, `cookies`, `origin`, and the rest of the metadata remain intact

The resulting Bridge install payload looks like this:

```json
{
  "schemaVersion": 1,
  "source": "browser-extension",
  "capturedAt": "2026-04-07T10:00:00.000Z",
  "origin": "https://chat.example.com",
  "cookies": [],
  "localStorage": {},
  "sessionStorage": {},
  "headers": {
    "Authorization": "Bearer ..."
  },
  "integration": {
    "label": "Chat Example"
  },
  "metadata": {
    "browser": "Chrome",
    "extensionVersion": "0.1.0",
    "tabTitle": "Chat Example",
    "captureMode": "next-request",
    "selectedRequest": {
      "url": "https://chat.example.com/api/chat",
      "method": "POST",
      "type": "fetch",
      "score": 20,
      "modelHints": ["model-alpha"],
      "responseContentType": "text/event-stream",
      "usesSse": true
    },
    "requestCapture": {
      "requests": [
        {
          "url": "https://chat.example.com/api/chats/new",
          "method": "POST",
          "requestHeaders": {
            "Authorization": "Bearer ...",
            "x-session-id": "..."
          },
          "inferred": {
            "looksLikeBootstrapRequest": true
          }
        }
      ],
      "selectedRequest": {
        "url": "https://chat.example.com/api/chat",
        "method": "POST",
        "type": "fetch",
        "requestHeaders": {
          "Authorization": "Bearer ..."
        },
        "inferred": {
          "score": 20,
          "usesSse": true,
          "hasMessagesField": true,
          "hasModelField": true,
          "modelHints": ["model-alpha"],
          "responseContentType": "text/event-stream",
          "looksLikeBootstrapRequest": false,
          "looksLikeStatusProbe": false
        }
      }
    }
  }
}
```

If you are reproducing this outside the extension, the minimum practical recipe is:

1. Record the same-site request stream with body, request headers, and response headers.
2. Score those requests and pick the best install-ready candidate.
3. Extract cookies plus selected non-cookie auth headers.
4. Build the full bundle shape shown above.
5. Replace storage with empty objects and keep only bootstrap requests in `metadata.requestCapture.requests`.

## Notes

- The popup is intentionally small and stateful.
- The extension only works on `http` and `https` pages.
- The packaged Bridge payload strips bulky storage and request history down to the parts needed for installation.
