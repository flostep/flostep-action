// Entry point. Builds the run's context and hands the event to its handler.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { readConfig, ConfigError } from "./config.js";
import { GitHub } from "./github.js";
import { Flostep } from "./flostep.js";
import { createModel } from "./llm/index.js";
import { onComment, onPullRequest, onPush } from "./events.js";

// Workflow commands need %, \r and \n escaped, or a multi-line message is cut.
const escape = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const consoleLog = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`::notice::${escape(message)}`),
  warning: (message) => console.log(`::warning::${escape(message)}`),
  error: (message) => console.log(`::error::${escape(message)}`)
};

export function buildContext(env, { fetch = globalThis.fetch, run, log = consoleLog, readFileText, event } = {}) {
  const config = readConfig(env);
  return {
    config,
    event,
    log,
    gh: new GitHub({ token: config.githubToken, apiUrl: config.githubApiUrl, repo: config.repo, fetch }),
    flostep: new Flostep({ token: config.flostepToken, url: config.flostepUrl, version: config.cliVersion, env, ...(run ? { run } : {}) }),
    model: config.llm ? createModel(config.llm, { fetch }) : null,
    readFile: readFileText ?? ((path) => readFile(path, "utf8"))
  };
}

const HANDLERS = {
  issue_comment: onComment,
  pull_request: onPullRequest,
  pull_request_target: onPullRequest,
  push: onPush
};

// Returns the exit code. Only a broken workflow configuration is a failure;
// anything about one pull request is reported and the run stays green, so a
// Flostep or model outage never blocks a merge.
export async function run(env, deps = {}) {
  const log = deps.log ?? consoleLog;
  try {
    const event = deps.event ?? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    const ctx = buildContext(env, { ...deps, log, event });
    const handler = HANDLERS[ctx.config.eventName];
    if (!handler) {
      log.notice(`Nothing to do for a ${ctx.config.eventName} event.`);
      return 0;
    }
    await handler(ctx);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(error.message);
      return 1;
    }
    log.warning(error.message);
    return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.env);
}
