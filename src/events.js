// One handler per event the workflow listens for.

import { generate, writeComment, aiRef, previewRef, isFlowFile, fileHeader } from "./generate.js";
import { readMarker, findBotComment } from "./comment.js";

// Write access to the repository, and nothing less. role_name distinguishes
// maintain from write and triage from read; author_association does not —
// MEMBER is only org membership, COLLABORATOR includes read invites.
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

export function parseCommand(body, command) {
  const first = String(body ?? "").trim().split("\n")[0].trim();
  if (first !== command && !first.startsWith(`${command} `)) return null;
  const rest = first.slice(command.length).trim();
  return { sub: rest || null };
}

// issue_comment: `/flostep`, `/flostep regenerate`, `/flostep delete`.
//
// This event runs the default branch's workflow with secrets even for pull
// requests from forks, so the permission check comes first — before any
// reaction, so a refused command can't be used to learn who has access — and
// no code from the pull request is ever checked out or run.
export async function onComment(ctx) {
  const { event, gh, config, log } = ctx;
  if (event.action !== "created" || !event.issue?.pull_request) return;

  const command = parseCommand(event.comment.body, config.command);
  if (!command) return;

  const user = event.comment.user.login;
  const role = await gh.permission(user);
  if (!WRITE_ROLES.has(role)) {
    log.info(`Ignoring ${config.command} from ${user}, who has ${role} access; it needs write.`);
    return;
  }

  const commentId = event.comment.id;
  const number = event.issue.number;
  await gh.react(commentId, "eyes");

  const reply = (text) => gh.createComment(number, `@${user} ${text}`);
  try {
    let outcome;
    if (command.sub === null) outcome = await generate(ctx, { number });
    else if (command.sub === "regenerate") outcome = await generate(ctx, { number, regenerate: true });
    else if (command.sub === "delete") outcome = await removeAll(ctx, { number, includeAi: true });
    else outcome = { status: "failed", message: `\`${config.command} ${command.sub}\` isn't a command. Use \`${config.command}\`, \`${config.command} regenerate\` or \`${config.command} delete\`.` };

    const ok = outcome.status === "updated" || outcome.status === "deleted" || outcome.status === "none";
    await gh.react(commentId, ok ? "rocket" : "confused");
    if (outcome.message && outcome.status !== "none") await reply(outcome.message);
  } catch (error) {
    await gh.react(commentId, "confused");
    await reply(`Couldn't make the diagram: ${error.message}`);
    log.warning(error.message);
  }
}

// pull_request: opened / reopened / ready_for_review / synchronize / closed.
export async function onPullRequest(ctx) {
  const { event, config } = ctx;
  const pr = event.pull_request;
  const number = pr.number;

  if (event.action === "closed") return onClosed(ctx, { number, merged: Boolean(pr.merged) });

  const asked =
    (config.auto === "push" && ["opened", "reopened", "ready_for_review", "synchronize"].includes(event.action)) ||
    (config.auto === "opened" && ["opened", "reopened", "ready_for_review"].includes(event.action));
  if (asked && !pr.draft) {
    if (!ctx.flostep.configured) return ctx.log.notice("No flostep-token on this run (a pull request from a fork?), so no diagram.");
    const outcome = await generate(ctx, { number });
    if (outcome.message) ctx.log.notice(outcome.message);
    return;
  }

  if (event.action === "synchronize") return markOutOfDate(ctx, { number, head: pr.head.sha });
}

// A push to the PR changes nothing in Flostep; the comment just says the
// diagram is behind. Needs no Flostep token and no model — only the comment.
async function markOutOfDate(ctx, { number, head }) {
  const { gh, log } = ctx;
  const existing = findBotComment(await gh.comments(number));
  const marker = readMarker(existing?.body);
  if (!marker?.sha || marker.sha === head || marker.diagrams.length === 0) return;

  const { ahead_by: behind } = await gh.compare(marker.sha, head);
  try {
    await writeComment(ctx, { number, existing, marker, behind });
  } catch (error) {
    // A fork's GITHUB_TOKEN is read-only; the note isn't worth more than this.
    log.notice(`Couldn't mark the diagram out of date: ${error.message}`);
  }
}

async function onClosed(ctx, { number, merged }) {
  if (!ctx.flostep.configured) return ctx.log.notice("No flostep-token on this run (a pull request from a fork?), so nothing was cleaned up.");
  // Previews always go: once merged, the live diagrams carry the change. The
  // AI diagram stays as the record of a merged change.
  await removeAll(ctx, { number, includeAi: !merged });
}

// Every diagram this PR made, found by ref on the Flostep side rather than
// read from the comment, so a deleted or edited comment can't orphan any.
async function removeAll(ctx, { number, includeAi }) {
  const { gh, flostep, config } = ctx;
  if (!flostep.configured) return { status: "failed", message: "flostep-token is empty." };

  const own = aiRef(config.repo, number);
  const previewPrefix = previewRef(config.repo, number, "");
  const refs = (await flostep.list())
    .map((d) => d.external_ref)
    .filter((ref) => ref && (ref.startsWith(previewPrefix) || (includeAi && ref === own)));

  for (const ref of refs) await flostep.deleteByRef(ref);

  const existing = findBotComment(await gh.comments(number));
  if (existing) {
    const marker = readMarker(existing.body);
    const kept = (marker?.diagrams ?? []).filter((d) => !refs.includes(d.ref));
    if (kept.length === 0) await gh.deleteComment(existing.id);
    else await writeComment(ctx, { number, existing, marker: { ...marker, diagrams: kept } });
  }
  return { status: "deleted", message: refs.length === 0 ? "There were no diagrams to delete." : null };
}

// push to the default branch: the live diagram of each committed .flostep
// file, keyed by its path. This is the only write to those diagrams — a PR
// only ever touches its previews.
export async function onPush(ctx) {
  const { event, gh, flostep, config, log } = ctx;
  if (!flostep.configured) return log.notice("No flostep-token, so the live diagrams weren't updated.");
  if (/^0+$/.test(event.before ?? "")) return log.notice("A new branch has nothing to compare against; skipping.");

  const { files = [] } = await gh.compare(event.before, event.after);
  const changed = files.filter((f) => isFlowFile(f.filename) && f.status !== "removed");
  if (changed.length === 0) return;

  await flostep.ensureFolder(config.filesFolder);
  for (const file of changed) {
    const steps = await gh.fileAt(file.filename, event.after);
    const header = fileHeader(steps);
    const saved = await flostep.upsert({
      ref: `github:${config.repo}:${file.filename}`,
      title: header.title ?? file.filename.split("/").pop().replace(/\.flostep$/, ""),
      folder: config.filesFolder,
      steps,
      share: config.share,
      adopt: header.id
    });
    log.info(`${saved.created ? "Created" : "Updated"} ${file.filename} → ${saved.share_url ?? saved.url}`);
  }
  // Deleted files leave their diagrams alone: someone may still hold the link.
}
