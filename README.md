# Generic Session Capture Extension

Chrome/Edge MV3 extension for capturing a generic authenticated browser session from the active tab.

## Current Flow

1. Load the unpacked extension from `dist/`.
2. Open an authenticated `http(s)` app tab.
3. Click the extension popup.
4. Click `Start Capture`.
5. If needed, send one real chat message in the tab and capture again.
6. Click `Send to Bridge` with a Bridge URL, or `Copy To Clipboard` for CLI use.

## Development

```bash
npm test
npm run build
```

Load `/Users/fsebaste/Desktop/uncensoredcode/extension/dist` as an unpacked extension after building.

## Notes

The popup is intentionally minimal. It only tracks the active origin, an optional Bridge URL, capture, send, copy, and a small status surface.
