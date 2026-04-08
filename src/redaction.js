const REDACTED = "[REDACTED]";

const REDACTION_RULES = [
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: `$1${REDACTED}`
  },
  {
    pattern:
      /((?:authorization|cookie|set-cookie|token|cookies|headers)\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi,
    replace: `$1${REDACTED}`
  },
  {
    pattern:
      /("?(?:authorization|cookie|set-cookie|token|cookies|headers)"?\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|\{[^}]*\}|[^,\n}]+)/gi,
    replace: `$1"${REDACTED}"`
  }
];

export function redactSensitiveText(value) {
  let text = typeof value === "string" ? value : "";
  for (const rule of REDACTION_RULES) {
    text = text.replace(rule.pattern, rule.replace);
  }

  return text;
}
