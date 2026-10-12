// Every Flostep call goes through the published CLI rather than an API client
// of the action's own, so auth, the User-Agent, error sentences and exit codes
// are the CLI's — one client to keep right, not two.

import { spawn } from "node:child_process";

export class FlostepError extends Error {
  constructor(args, code, stderr) {
    // The CLI writes a sentence and an indented hint; the sentence is enough.
    // The CLI's leading "✗" is for a terminal; on a PR it's noise.
    const message = stderr.split("\n").map((l) => l.trim()).find((l) => l && !/^npm (warn|notice)/i.test(l));
    super(message?.replace(/^[✗✓]\s*/, "") || `flostep ${args[0]} exited with ${code}.`);
    this.code = code;
    this.stderr = stderr;
  }

  // The server's 409 sentence: someone changed the diagram since the version
  // the action last wrote — a hand edit, which must not be overwritten.
  get conflict() { return /changed after you read it/i.test(this.stderr); }
  // The steps themselves were refused, so a model can be asked to fix them.
  get badSteps() { return /no steps|no valid steps|past the limit|doesn't look like a diagram/i.test(this.stderr); }
  get missingRef() { return /no diagram has the ref/i.test(this.stderr); }
}

export function spawnRun(command, args, { env, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

export class Flostep {
  constructor({ token, url, version, run = spawnRun, env = process.env }) {
    this.token = token;
    this.url = url;
    this.version = version;
    this.run = run;
    this.env = env;
  }

  get configured() { return Boolean(this.token); }

  async exec(args, stdin) {
    const env = { ...this.env, FLOSTEP_TOKEN: this.token, NO_COLOR: "1" };
    if (this.url) env.FLOSTEP_API_URL = this.url;
    const result = await this.run("npx", ["-y", `flostep@${this.version}`, ...args], { env, stdin });
    if (result.code !== 0) throw new FlostepError(args, result.code, result.stderr);
    return result.stdout;
  }

  async json(args, stdin) {
    return JSON.parse(await this.exec([...args, "--json"], stdin));
  }

  async syntax() { return (await this.exec(["syntax"])).trim(); }

  // Idempotent on the server: an existing name comes back as that folder.
  ensureFolder(name) { return this.json(["folder", "create", name]); }

  upsert({ ref, title, folder, steps, version, adopt, share }) {
    const args = ["upsert", "--ref", ref];
    if (title) args.push("--title", title);
    if (folder) args.push("--folder", folder);
    if (share) args.push("--share");
    if (version !== undefined && version !== null) args.push("--if-version", String(version));
    if (adopt) args.push("--adopt", adopt);
    return this.json(args, steps);
  }

  list() { return this.json(["list"]); }

  // Already gone is the outcome being asked for, so it isn't an error.
  async deleteByRef(ref) {
    try {
      await this.exec(["delete", "--ref", ref, "--yes"]);
      return true;
    } catch (error) {
      if (error instanceof FlostepError && error.missingRef) return false;
      throw error;
    }
  }
}
