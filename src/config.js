// Reads the action's inputs and the run's environment into one object, and
// refuses configurations that can't work. GitHub passes each input as
// INPUT_<NAME>, upper-cased with hyphens kept.

export const DEFAULT_CLI_VERSION = "0.1.6"; // the first release with `upsert`

const MODES = ["auto", "files", "ai"];
const AUTO = ["none", "opened", "push"];
const PROVIDERS = ["anthropic", "openai"];

// A mistake in the workflow file, as opposed to anything about one PR. The
// only failure that turns a run red — everything else is reported and the
// run stays green, so a Flostep or model outage never blocks a merge.
export class ConfigError extends Error {}

export function readConfig(env) {
  const input = (name) => (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  const oneOf = (name, allowed, fallback) => {
    const value = input(name) || fallback;
    if (!allowed.includes(value)) throw new ConfigError(`${name} must be one of ${allowed.join(", ")} (got "${value}").`);
    return value;
  };

  const flostepToken = input("flostep-token");
  const githubToken = input("github-token");
  if (!githubToken) throw new ConfigError("github-token is empty.");

  // AI mode is all three or nothing. There is deliberately no default
  // provider or model: which LLM reads a repository's code is the owner's
  // decision, and a default would make it silently.
  const llmInputs = { provider: input("llm-provider"), model: input("llm-model"), apiKey: input("llm-api-key") };
  const given = Object.entries(llmInputs).filter(([, v]) => v).map(([k]) => k);
  let llm = null;
  if (given.length > 0) {
    if (given.length < 3) {
      throw new ConfigError("llm-provider, llm-model and llm-api-key go together — set all three, or none to skip AI mode.");
    }
    if (!PROVIDERS.includes(llmInputs.provider)) {
      throw new ConfigError(`llm-provider must be ${PROVIDERS.join(" or ")} (got "${llmInputs.provider}"). Every OpenAI-compatible API — Gemini, Azure, Groq, OpenRouter, Ollama — is "openai" with llm-base-url.`);
    }
    llm = { ...llmInputs, baseUrl: input("llm-base-url").replace(/\/+$/, "") || null };
  }

  const maxFiles = Number(input("max-files") || "10");
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new ConfigError("max-files must be a whole number, 1 or more.");

  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new ConfigError("GITHUB_REPOSITORY is not set — is this running in GitHub Actions?");

  return {
    repo,
    eventName: env.GITHUB_EVENT_NAME,
    eventPath: env.GITHUB_EVENT_PATH,
    githubToken,
    githubApiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
    flostepToken,
    flostepUrl: input("flostep-url") || null,
    cliVersion: input("cli-version") || DEFAULT_CLI_VERSION,
    llm,
    stepsFile: input("steps-file") || null,
    mode: oneOf("mode", MODES, "auto"),
    auto: oneOf("auto", AUTO, "none"),
    command: input("command") || "/flostep",
    folder: input("folder") || "PR diagrams",
    filesFolder: input("files-folder") || "Diagrams",
    share: (input("share") || "true").toLowerCase() !== "false",
    pathsIgnore: input("paths-ignore").split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    maxFiles
  };
}
