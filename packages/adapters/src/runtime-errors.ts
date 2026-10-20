export function sanitizeSensitiveText(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:auth|authorization)\s*[=:]\s*)(?!Bearer\b)[^\s"',;&]+/gi, "$1[redacted]");
}
