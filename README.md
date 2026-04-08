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

## How The Schema Is Built

The extension builds the exported session package in two steps:

1. `buildSessionBundle(...)` creates the full capture payload.
2. `buildBridgeInstallBundle(...)` compacts that payload for Bridge installation.

### Step 1: Full Session Bundle

The background worker waits for the next same-site request that looks like a real chat or assistant request. A request becomes the `selectedRequest` when the heuristics see enough evidence such as:

- A `POST` request.
- Chat-like paths or payload keys such as `chat`, `conversation`, `messages`, `prompt`, or `model`.
- Streaming or SSE-style responses.
- Auth-bearing headers such as `Authorization` or `x-*`.

Once a usable request is found, the extension captures:

- Cookies for the tab origin and parent site domains.
- `localStorage` and `sessionStorage` from the page.
- The selected request headers, excluding `Cookie`.
- Metadata describing the matched request and browser context.

That full bundle has this shape:

```json
{
  "schemaVersion": 1,
  "source": "browser-extension",
  "capturedAt": "2026-04-07T10:00:00.000Z",
  "origin": "https://chat.example.com",
  "cookies": [],
  "localStorage": {},
  "sessionStorage": {},
  "headers": {},
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
      "requests": [],
      "selectedRequest": {}
    }
  }
}
```

### Step 2: Bridge Install Bundle

Before sending to Bridge, the extension compacts the full bundle:

- `localStorage` is replaced with `{}`.
- `sessionStorage` is replaced with `{}`.
- `metadata.requestCapture.requests` is reduced to only bootstrap-style requests that may help installation.
- Bootstrap request headers are sanitized the same way as the selected request headers, so `Cookie` is excluded there too.
- `metadata.requestCapture.selectedRequest` is preserved.

This means the install payload keeps the session material and the important request identity, but drops bulky page state and most request history.

## Notes

- The popup is intentionally small and stateful.
- The extension only works on `http` and `https` pages.
- The packaged Bridge payload strips bulky storage and request history down to the parts needed for installation.
