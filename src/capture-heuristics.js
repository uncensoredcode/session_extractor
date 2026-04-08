export function isCapturablePageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getSiteHostnames(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.hostname.split(".").filter(Boolean);
  const candidates = new Set([url.hostname]);

  for (let index = 0; index < parts.length - 1; index += 1) {
    const suffix = parts.slice(index).join(".");
    if (suffix.includes(".")) {
      candidates.add(suffix);
    }
  }

  return [...candidates];
}

export function isSameSiteRequest(pageUrl, requestUrl) {
  try {
    const page = new URL(pageUrl);
    const request = new URL(requestUrl);
    const pageHosts = getSiteHostnames(pageUrl);

    if (request.origin === page.origin) {
      return true;
    }

    return pageHosts.some(
      (host) => request.hostname === host || request.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

export function decodeRequestBody(requestBody) {
  if (!requestBody || typeof requestBody !== "object") {
    return {
      text: "",
      json: null,
      keys: []
    };
  }

  if (requestBody.formData && typeof requestBody.formData === "object") {
    const normalized = normalizeFormData(requestBody.formData);
    return {
      text: JSON.stringify(normalized),
      json: normalized,
      keys: Object.keys(normalized).sort()
    };
  }

  if (!Array.isArray(requestBody.raw) || requestBody.raw.length === 0) {
    return {
      text: "",
      json: null,
      keys: []
    };
  }

  const decoder = new TextDecoder();
  let text = "";
  const rawChunks = [];

  for (const part of requestBody.raw) {
    if (part?.bytes instanceof ArrayBuffer) {
      const chunk = new Uint8Array(part.bytes);
      rawChunks.push(chunk);
      text += decoder.decode(chunk, { stream: true });
    }
  }

  text += decoder.decode();
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      text: "",
      json: null,
      keys: []
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      text: trimmed,
      json: parsed,
      keys: Object.keys(isPlainObject(parsed) ? parsed : {}).sort()
    };
  } catch {
    const connectJson = decodeConnectEnvelopeBytes(rawChunks);
    if (connectJson) {
      return {
        text: trimmed,
        json: connectJson,
        keys: Object.keys(isPlainObject(connectJson) ? connectJson : {}).sort()
      };
    }

    return {
      text: trimmed,
      json: null,
      keys: []
    };
  }
}

export function normalizeHeaders(headers) {
  const result = {};
  for (const header of headers || []) {
    if (!header?.name || typeof header.value !== "string") {
      continue;
    }

    const name = header.name.trim();
    const value = header.value.trim();
    if (!name || !value) {
      continue;
    }

    if (name.toLowerCase() === "cookie") {
      continue;
    }

    result[name] = value;
  }

  return result;
}

export function inferCandidate(candidate) {
  const url = safeParseUrl(candidate.url);
  const path = url?.pathname.toLowerCase() ?? "";
  const search = url?.search.toLowerCase() ?? "";
  const requestBodyText = typeof candidate.requestBodyText === "string" ? candidate.requestBodyText : "";
  const requestContext = `${candidate.method || ""} ${candidate.type || ""} ${path} ${search} ${requestBodyText}`.toLowerCase();
  const headerNames = Object.keys(candidate.requestHeaders || {}).map((key) => key.toLowerCase());
  const responseHeaders = candidate.responseHeaders || {};
  const responseContentType =
    findHeaderValue(responseHeaders, "content-type") || "";
  const requestJson = isPlainObject(candidate.requestBodyJson) ? candidate.requestBodyJson : null;

  const models = collectModelHints(requestJson, candidate.requestBodyText);
  const authHeaderNames = headerNames.filter(
    (name) => name === "authorization" || name.startsWith("x-")
  );

  const traits = {
    usesJsonBody: Boolean(requestJson),
    usesSse: /text\/event-stream/i.test(responseContentType) || /event-stream/i.test(requestContext),
    looksChatLike: /(chat|completion|conversation|assistant|message|prompt|generate)/i.test(
      `${path} ${search} ${candidate.requestBodyKeys?.join(" ") || ""}`
    ),
    hasMessagesField: hasMessagePayload({
      requestJson,
      requestBodyText: candidate.requestBodyText,
      requestBodyKeys: candidate.requestBodyKeys
    }),
    hasModelField: models.length > 0,
    hasConversationField: /(conversation|session|thread|parent|chat_id)/i.test(
      `${candidate.requestBodyText || ""} ${candidate.requestBodyKeys?.join(" ") || ""}`
    ),
    authHeaderNames,
    modelHints: models,
    responseContentType,
    looksLikeBootstrapRequest:
      /(\/|^)(new|create)(\/|$)/i.test(path) ||
      (/\/chats\//i.test(path) && /(^|\/)new(\/|$)/i.test(path)) ||
      (/(title|project_id)/i.test(candidate.requestBodyKeys?.join(" ") || "") &&
        !/(messages|prompt|input)/i.test(`${candidate.requestBodyText || ""} ${candidate.requestBodyKeys?.join(" ") || ""}`)),
    looksLikeStatusProbe: /(\/|^)(status|health|metrics|telemetry|analytics|csrf|config|settings|profile|account|me)(\/|$)/i.test(path)
  };

  return {
    ...traits,
    score: scoreCandidate(candidate, traits)
  };
}

export function scoreCandidate(candidate, inferred = inferCandidate(candidate)) {
  let score = 0;

  if (String(candidate.method || "").toUpperCase() === "POST") {
    score += 3;
  }

  if (inferred.looksChatLike) {
    score += 4;
  }

  if (inferred.hasMessagesField) {
    score += 4;
  }

  if (inferred.hasModelField) {
    score += 4;
  }

  if (inferred.hasConversationField) {
    score += 2;
  }

  if (inferred.usesSse) {
    score += 3;
  }

  if (inferred.authHeaderNames.length > 0) {
    score += 2;
  }

  if ((candidate.requestBodyText || "").length > 0) {
    score += 1;
  }

  if (candidate.completed) {
    score += 1;
  }

  if (inferred.looksLikeBootstrapRequest) {
    score -= 5;
  }

  if (inferred.looksLikeStatusProbe) {
    score -= 6;
  }

  return score;
}

export function pickBestCandidate(candidates) {
  const enriched = candidates
    .map((candidate) => {
      const inferred = inferCandidate(candidate);
      return {
        ...candidate,
        inferred
      };
    })
    .sort((left, right) => {
      if (right.inferred.score !== left.inferred.score) {
        return right.inferred.score - left.inferred.score;
      }

      return (left.startedAt || 0) - (right.startedAt || 0);
    });

  return enriched[0] ?? null;
}

export function isInstallReadyCandidate(candidate) {
  if (!candidate?.inferred) {
    return false;
  }

  if (candidate.inferred.looksLikeStatusProbe || candidate.inferred.looksLikeBootstrapRequest) {
    return false;
  }

  if (!hasCapturedRequestDetails(candidate)) {
    return false;
  }

  if ((candidate.inferred.score ?? 0) < 12) {
    return false;
  }

  return Boolean(
    candidate.inferred.usesSse ||
    candidate.inferred.hasMessagesField ||
    (candidate.inferred.hasConversationField && candidate.inferred.hasModelField)
  );
}

function hasCapturedRequestDetails(candidate) {
  const hasHeaders = Object.keys(candidate?.requestHeaders || {}).length > 0;
  const hasBody =
    (typeof candidate?.requestBodyText === "string" && candidate.requestBodyText.trim().length > 0) ||
    isPlainObject(candidate?.requestBodyJson);

  return hasHeaders && hasBody;
}

function collectModelHints(requestJson, requestBodyText) {
  const models = new Set();

  if (requestJson) {
    scanForModels(requestJson, "", models, 0);
  }

  const text = typeof requestBodyText === "string" ? requestBodyText : "";
  const matches = text.match(/"(?:model|models|modelId|model_id)"\s*:\s*(?:\[(.*?)\]|"(.*?)")/gi) || [];
  for (const match of matches) {
    const inline = match.match(/"([^"]{2,120})"/g) || [];
    for (const value of inline) {
      const normalized = value.replace(/^"|"$/g, "").trim();
      if (normalized && !/^(model|models|modelId|model_id)$/i.test(normalized)) {
        models.add(normalized);
      }
    }
  }

  return [...models].sort((left, right) => left.localeCompare(right));
}

function scanForModels(value, keyHint, models, depth) {
  if (depth > 4 || value == null) {
    return;
  }

  if (typeof value === "string") {
    if (/(^|[\s_.-])(model|modelid|model_id|models)([\s_.-]|$)/i.test(keyHint) && value.trim()) {
      models.add(value.trim());
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      scanForModels(entry, keyHint, models, depth + 1);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      scanForModels(entry, `${keyHint} ${key}`, models, depth + 1);
    }
  }
}

function normalizeFormData(formData) {
  return Object.fromEntries(
    Object.entries(formData).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : [String(value)]
    ])
  );
}

function hasMessagePayload({ requestJson, requestBodyText, requestBodyKeys }) {
  const serializedKeys = Array.isArray(requestBodyKeys) ? requestBodyKeys.join(" ") : "";
  const text = typeof requestBodyText === "string" ? requestBodyText : "";

  if (/(messages|prompt|input)/i.test(`${text} ${serializedKeys}`)) {
    return true;
  }

  if (!requestJson || !isPlainObject(requestJson)) {
    return false;
  }

  const message = requestJson.message;
  if (isPlainObject(message)) {
    if (typeof message.content === "string" && message.content.trim()) {
      return true;
    }

    if (isPlainObject(message.text) && typeof message.text.content === "string" && message.text.content.trim()) {
      return true;
    }

    if (Array.isArray(message.blocks) && message.blocks.some(hasTextBlockContent)) {
      return true;
    }
  }

  if (Array.isArray(requestJson.blocks) && requestJson.blocks.some(hasTextBlockContent)) {
    return true;
  }

  return false;
}

function hasTextBlockContent(block) {
  if (!isPlainObject(block)) {
    return false;
  }

  if (typeof block.content === "string" && block.content.trim()) {
    return true;
  }

  const text = block.text;
  return isPlainObject(text) && typeof text.content === "string" && text.content.trim().length > 0;
}

function decodeConnectEnvelopeBytes(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  if (bytes.length < 5) {
    return null;
  }

  const payloadLength = ((bytes[1] ?? 0) << 24) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0);
  if (payloadLength <= 0 || bytes.length < 5 + payloadLength) {
    return null;
  }

  const payloadText = new TextDecoder().decode(bytes.slice(5, 5 + payloadLength)).trim();
  if (!payloadText) {
    return null;
  }

  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

function safeParseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function findHeaderValue(headers, target) {
  const normalizedTarget = target.toLowerCase();
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === normalizedTarget && typeof value === "string") {
      return value;
    }
  }

  return "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
