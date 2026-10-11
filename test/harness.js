// Runs the action in-process against a fake GitHub, a fake LLM endpoint and a
// fake flostep CLI, and records every call. A request with no route fails
// loudly, so a handler that starts making an extra call can't pass unnoticed.

import { run } from "../src/main.js";

export const REPO = "acme/shop";
export const HEAD = "abc1234def5678";

export const BASE_ENV = {
  GITHUB_REPOSITORY: REPO,
  GITHUB_API_URL: "https://api.github.test",
  "INPUT_FLOSTEP-TOKEN": "fls_test",
  "INPUT_GITHUB-TOKEN": "ghs_test",
  INPUT_COMMAND: "/flostep",
  INPUT_FOLDER: "PR diagrams",
  "INPUT_FILES-FOLDER": "Diagrams",
  INPUT_MODE: "auto",
  INPUT_AUTO: "none",
  INPUT_SHARE: "true",
  "INPUT_MAX-FILES": "10"
};

export const ANTHROPIC_ENV = {
  "INPUT_LLM-PROVIDER": "anthropic",
  "INPUT_LLM-MODEL": "claude-opus-5-5",
  "INPUT_LLM-API-KEY": "sk-test"
};

export function json(status, body) { return { status, body }; }

// `github` and `llm` are maps of "METHOD url-path?query" → answer, where an
// answer is a value (200), json(status, body), or a function of the parsed
// request body. `flostep` maps a CLI subcommand ("upsert", "folder", "list",
// "syntax", "delete") to { stdout, stderr, code } or a function of
// (args, stdin) returning one; a plain object is sent as --json output.
export async function act({ eventName, event, env = {}, github = {}, llm = {}, flostep = {}, files = {} }) {
  const calls = [];
  const logs = [];

  const fetch = async (url, init = {}) => {
    const { origin, pathname, search } = new URL(url);
    const key = `${init.method ?? "GET"} ${pathname}${search}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const routes = origin === "https://api.github.test" ? github : llm;
    calls.push({ kind: origin === "https://api.github.test" ? "github" : "llm", key, body, headers: init.headers, url });

    if (!Object.hasOwn(routes, key)) {
      return new Response(JSON.stringify({ message: `unrouted ${key}` }), { status: 599 });
    }
    let answer = routes[key];
    if (typeof answer === "function") answer = answer(body);
    const { status, body: out } = answer && Object.hasOwn(answer, "status") && Object.hasOwn(answer, "body") ? answer : { status: 200, body: answer };
    const text = typeof out === "string" ? out : out === undefined ? "" : JSON.stringify(out);
    return new Response(status === 204 ? null : text, { status });
  };

  const run_ = async (command, args, { env: childEnv, stdin }) => {
    const cliArgs = args.slice(2); // drop "-y", "flostep@x"
    calls.push({ kind: "flostep", args: cliArgs, stdin, env: childEnv, command, pin: args[1] });
    const handler = flostep[cliArgs[0]];
    if (handler === undefined) return { code: 1, stdout: "", stderr: `unrouted flostep ${cliArgs[0]}` };
    let result = typeof handler === "function" ? handler(cliArgs, stdin) : handler;
    if (!Object.hasOwn(result, "code")) result = { code: 0, stdout: JSON.stringify(result), stderr: "" };
    return { stdout: "", stderr: "", ...result };
  };

  const log = {
    info: (m) => logs.push(["info", m]),
    notice: (m) => logs.push(["notice", m]),
    warning: (m) => logs.push(["warning", m]),
    error: (m) => logs.push(["error", m])
  };

  const code = await run(
    { ...BASE_ENV, GITHUB_EVENT_NAME: eventName, ...env },
    { event, fetch, run: run_, log, readFileText: async (path) => files[path] }
  );

  return {
    code,
    calls,
    logs,
    github: calls.filter((c) => c.kind === "github").map((c) => c.key),
    flostep: calls.filter((c) => c.kind === "flostep"),
    llm: calls.filter((c) => c.kind === "llm"),
    unrouted: calls.filter((c) => c.kind !== "flostep" && !Object.hasOwn(c.kind === "github" ? github : llm, c.key)).map((c) => c.key),
    body: (key) => calls.find((c) => c.key === key)?.body
  };
}

// --- fixtures -------------------------------------------------------------

export const PR = { number: 44, state: "open", draft: false, title: "Cache sessions in Redis", body: "Reads go to Redis first.", head: { sha: HEAD }, merged: false };

export const FILES = [
  { filename: "app/services/session.rb", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@\n-db.read\n+redis.read || db.read" },
  { filename: "Gemfile.lock", status: "modified", additions: 3, deletions: 0, patch: "@@ +redis (5.0)" }
];

export function commentEvent({ body = "/flostep", login = "maintainer", id = 900 } = {}) {
  return { action: "created", issue: { number: 44, pull_request: { url: "x" } }, comment: { id, body, user: { login } } };
}

export const STEPS = "Browser -> API: GET /me\nAPI -> Redis: read session\nRedis -> API: session";

export function saved(overrides = {}) {
  return { id: "Xk3p9QvA2wE", title: "PR #44: Cache sessions in Redis", version: 1, url: "https://flostep.test/diagrams/Xk3p9QvA2wE", share_url: "https://flostep.test/s/tok", image_url: "https://flostep.test/s/tok.svg", external_ref: `github:${REPO}#44`, created: true, ...overrides };
}

export function anthropicReply(text, extra = {}) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", ...extra };
}

export function permission(role) {
  return { permission: role === "maintain" ? "write" : role === "triage" ? "read" : role, role_name: role };
}

// The routes nearly every /flostep test needs.
export function prRoutes({ role = "write", comments = [], files = FILES } = {}) {
  return {
    "GET /repos/acme/shop/collaborators/maintainer/permission": permission(role),
    "POST /repos/acme/shop/issues/comments/900/reactions": json(201, {}),
    "GET /repos/acme/shop/pulls/44": PR,
    "GET /repos/acme/shop/pulls/44/files?per_page=100&page=1": files,
    "GET /repos/acme/shop/issues/44/comments?per_page=100&page=1": comments,
    "POST /repos/acme/shop/issues/44/comments": json(201, { id: 1 })
  };
}
