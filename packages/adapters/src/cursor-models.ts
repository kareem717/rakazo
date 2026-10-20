import { redactSecrets } from "@rakazo/core";
import { sanitizeSensitiveText } from "./runtime-errors.js";
/** Cursor's SDK uses user API keys billed to the user's existing Cursor plan. */
export const CURSOR_MODEL_PROVIDER = "cursor";
export const CURSOR_DEFAULT_MODEL = "composer-2.5";
export const CURSOR_MANAGED_LIMITS_MESSAGE = "Cursor manages its own token and context limits.";

export async function probeCursorModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  apiKey = apiKey.trim();
  if (!apiKey) throw new Error("A Cursor user API key is required.");
  // Keep the optional SDK out of catalog reads and non-Cursor deployments.
  const { Cursor } = await import("@cursor/sdk");
  const models = await Cursor.models.list({ apiKey }).catch((error: unknown) => {
    throw new Error(
      redactSecrets(sanitizeSensitiveText(error instanceof Error ? error.message : String(error)), [
        apiKey,
      ]),
    );
  });
  signal?.throwIfAborted();
  return [...new Set(models.map((model) => model.id))];
}
