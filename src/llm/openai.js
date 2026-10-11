// OpenAI-compatible Chat Completions — OpenAI itself, and through llm-base-url
// Azure OpenAI, Gemini, Groq, Mistral, OpenRouter, Ollama, vLLM and the rest.

import { LlmError } from "./errors.js";

const DEFAULT_BASE = "https://api.openai.com/v1";

export async function complete({ apiKey, model, baseUrl, system, messages, fetch }) {
  const base = baseUrl || DEFAULT_BASE;
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  // Azure OpenAI takes key auth in its own header.
  if (/\.azure\.com$/i.test(new URL(base).hostname)) headers["api-key"] = apiKey;

  // No max_tokens: providers disagree on its name (max_tokens vs
  // max_completion_tokens) and on which models accept which, and steps are
  // short enough that the provider's default ceiling is plenty.
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages] }),
    signal: AbortSignal.timeout(300_000)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? (Array.isArray(payload) ? payload[0]?.error?.message : null);
    throw new LlmError(`${new URL(base).hostname} returned ${response.status}: ${message ?? "no message"}`);
  }

  const choice = payload?.choices?.[0];
  if (choice?.finish_reason === "content_filter") throw new LlmError("The model declined this request.");
  if (choice?.finish_reason === "length") throw new LlmError("The model's answer was cut off before it finished.");

  const content = choice?.message?.content;
  // Some providers return content as an array of parts.
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return content ?? "";
}
