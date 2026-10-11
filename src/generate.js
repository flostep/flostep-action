// Making or refreshing a pull request's diagrams — what `/flostep` does, and
// what `auto: opened|push` does without being asked.

import { FlostepError } from "./flostep.js";
import { buildDiff } from "./diff.js";
import { readMarker, findBotComment, renderComment } from "./comment.js";

export const aiRef = (repo, number) => `github:${repo}#${number}`;
export const previewRef = (repo, number, path) => `github:${repo}#${number}:${path}`;
export const isFlowFile = (name) => name.endsWith(".flostep");

// `# flostep-id: X` pins a committed file to an existing diagram (keeping its
// share link); `# flostep-title: T` names it. Both are comments to the parser.
export function fileHeader(text) {
  const header = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*#\s*flostep-(id|title)\s*:\s*(.+?)\s*$/i);
    if (match) header[match[1].toLowerCase()] = match[2];
  }
  return header;
}

const titleFromPath = (path) => path.split("/").pop().replace(/\.flostep$/, "");

// Outcome: { status: "updated" | "none" | "conflict" | "closed", message? }.
// "conflict" is a hand edit the bot left alone, and the message says how to
// overwrite it.
export async function generate(ctx, { number, regenerate = false }) {
  const { config, gh, flostep, log } = ctx;
  if (!flostep.configured) return { status: "failed", message: "flostep-token is empty, so there is nothing to publish with." };

  const pr = await gh.pull(number);
  if (pr.state !== "open") return { status: "closed", message: "This pull request is closed." };

  const [files, comments] = await Promise.all([gh.pullFiles(number), gh.comments(number)]);
  const existing = findBotComment(comments);
  const previous = new Map((readMarker(existing?.body)?.diagrams ?? []).map((d) => [d.ref, d]));

  const flowFiles = files.filter((f) => isFlowFile(f.filename) && f.status !== "removed");
  const fileMode = config.mode === "files" || (config.mode === "auto" && flowFiles.length > 0);

  // Each entry's `version` is what the hand-edit check sends next time.
  const publish = async (ref, title, steps) => {
    const version = regenerate ? undefined : previous.get(ref)?.version;
    const saved = await flostep.upsert({ ref, title, steps, folder: config.folder, share: config.share, version });
    return { ref, id: saved.id, title: saved.title, version: saved.version, url: saved.url, share_url: saved.share_url ?? null, image_url: saved.image_url ?? null };
  };

  await flostep.ensureFolder(config.folder);

  const diagrams = [];
  const conflicts = [];
  const keepOnConflict = async (ref, write) => {
    try {
      diagrams.push(await write());
    } catch (error) {
      if (!(error instanceof FlostepError && error.conflict)) throw error;
      conflicts.push(ref);
      if (previous.has(ref)) diagrams.push(previous.get(ref));
    }
  };

  if (fileMode) {
    if (flowFiles.length === 0) {
      const note = "This pull request changes no `.flostep` files, and `mode` is `files`.";
      await writeComment(ctx, { number, existing, marker: { sha: pr.head.sha, diagrams: [] }, note });
      return { status: "none", message: note };
    }
    if (flowFiles.length > config.maxFiles) log.warning(`Previewing the first ${config.maxFiles} of ${flowFiles.length} .flostep files (max-files).`);

    for (const file of flowFiles.slice(0, config.maxFiles)) {
      const steps = await gh.fileAt(file.filename, pr.head.sha);
      const title = `PR #${number} preview: ${fileHeader(steps).title ?? titleFromPath(file.filename)}`;
      const ref = previewRef(config.repo, number, file.filename);
      await keepOnConflict(ref, () => publish(ref, title, steps));
    }
  } else {
    const ref = aiRef(config.repo, number);
    const title = `PR #${number}: ${pr.title}`;
    const drafted = await draftSteps(ctx, { pr, files });
    if (drafted.none) {
      await writeComment(ctx, { number, existing, marker: { sha: pr.head.sha, diagrams: [] }, note: drafted.note });
      return { status: "none", message: drafted.note };
    }
    await keepOnConflict(ref, () => publishWithRepair(ctx, { ref, title, drafted, publish }));
  }

  await writeComment(ctx, { number, existing, marker: { sha: pr.head.sha, diagrams } });

  if (conflicts.length > 0) {
    return {
      status: "conflict",
      message: `Left ${conflicts.length === 1 ? "a diagram" : `${conflicts.length} diagrams`} alone: ${conflicts.length === 1 ? "it was" : "they were"} edited in Flostep since the bot last wrote ${conflicts.length === 1 ? "it" : "them"}. Comment \`${config.command} regenerate\` to overwrite those edits.`
    };
  }
  return { status: "updated" };
}

// Steps for AI mode, from steps-file or the configured model.
async function draftSteps(ctx, { pr, files }) {
  const { config, flostep, model, readFile } = ctx;

  if (config.stepsFile) {
    const text = (await readFile(config.stepsFile)).trim();
    if (!text || /^NONE\.?$/i.test(text)) return { none: true, note: "The steps file says there is no flow to draw for this change." };
    return { steps: text, source: "file" };
  }

  if (!model) {
    throw new Error("This pull request changes no .flostep files, and AI mode isn't set up. Set llm-provider, llm-model and llm-api-key (or steps-file) in the workflow.");
  }

  const syntax = await flostep.syntax();
  const diff = buildDiff(files, { ignore: config.pathsIgnore });
  const answer = await model.draft({ syntax, pr, files, diff });
  if (answer.none) return { none: true, note: "Nothing in this change has a flow worth drawing." };
  return { steps: answer.steps, source: "model", syntax, messages: answer.messages };
}

// A model's steps get one repair turn if the parser refuses them. Steps from
// a file don't — nobody is there to fix them.
async function publishWithRepair(ctx, { ref, title, drafted, publish }) {
  try {
    return await publish(ref, title, drafted.steps);
  } catch (error) {
    if (!(drafted.source === "model" && error instanceof FlostepError && error.badSteps)) throw error;
    ctx.log.info(`The model's steps were refused (${error.message}); asking it to fix them once.`);
    const repaired = await ctx.model.repair({ syntax: drafted.syntax, messages: drafted.messages, error: error.message });
    if (repaired.none) throw new Error(`The model's steps were refused (${error.message}), and its second attempt gave up.`);
    return await publish(ref, title, repaired.steps);
  }
}

export async function writeComment(ctx, { number, existing, marker, note = null, behind = 0 }) {
  const body = renderComment({ marker, command: ctx.config.command, note, behind });
  if (existing) return ctx.gh.updateComment(existing.id, body);
  return ctx.gh.createComment(number, body);
}
