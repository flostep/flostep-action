// Anthropic Messages API (Claude).

import { LlmError } from "./errors.js";

const DEFAULT_BASE = "https://api.anthropic.com";

// Models that accept the server-side refusal fallback. When a safety
// classifier declines the request, the API re-runs it on the model Anthropic
// recommends for that category instead of returning the refusal. Other models
// reject the parameter, so it's sent only to these.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export async function complete({ apiKey, model, baseUrl, system, messages, fetch }) {
  const fallback = FALLBACK_MODELS.has(model);
  const response = await fetch(`${baseUrl || DEFAULT_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {})
    },
    body: JSON.stringify({
      model,
      // Steps are short; this is headroom so a long diff's answer is never cut
      // mid-line, not a target.
      max_tokens: 16000,
      system,
      messages,
      ...(fallback ? { fallbacks: "default" } : {})
    }),
    signal: AbortSignal.timeout(300_000)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new LlmError(`Anthropic returned ${response.status}: ${payload?.error?.message ?? "no message"}`);
  }

  // Checked before reading content: a refusal is a 200 with no usable text.
  if (payload.stop_reason === "refusal") {
    const category = payload.stop_details?.category;
    throw new LlmError(`The model declined this request${category ? ` (${category})` : ""}.`);
  }
  if (payload.stop_reason === "max_tokens") {
    throw new LlmError("The model's answer was cut off before it finished.");
  }

  return (payload.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}
