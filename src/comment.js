// The one bot comment per pull request, and the hidden marker inside it.
//
// The marker is a convenience, not the source of truth: diagrams are found by
// their ref on the Flostep side, so deleting the comment loses nothing but the
// `version` the hand-edit check uses. It carries enough to redraw the comment
// (titles, links) without asking Flostep, which is what lets the out-of-date
// note on a push run with no Flostep token at all.

const PREFIX = "<!-- flostep-pr:";

export function readMarker(body) {
  const match = String(body ?? "").match(/<!-- flostep-pr:(\{.*?\}) -->/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// `<` and `>` are escaped so a PR title containing "-->" can't end the HTML
// comment early. Both are valid JSON escapes, so the marker still parses.
export function writeMarker(data) {
  return `${PREFIX}${JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}

// The action's own comment. With the default GITHUB_TOKEN its author is a
// Bot; with a personal access token it's that person, so authorship alone
// isn't enough — the action always writes the marker first, which a reply
// quoting it ("> <!-- …") never does. Spoofing one gains nothing: diagrams
// are found by ref, and the marker only carries what the comment displays.
export function findBotComment(comments) {
  return comments.find((c) => c.user?.type === "Bot" && String(c.body).includes(PREFIX))
    ?? comments.find((c) => String(c.body).startsWith(PREFIX))
    ?? null;
}

const short = (sha) => String(sha ?? "").slice(0, 7);
// Alt text ends at "]", and a title is one line.
const alt = (title) => String(title).replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "Flostep diagram";

export function renderComment({ marker, command, behind = 0, note = null }) {
  const lines = [writeMarker(marker), "### Flostep diagram"];

  if (behind > 0) {
    lines.push("", `> [!NOTE]\n> This diagram is from \`${short(marker.sha)}\`, ${behind} commit${behind === 1 ? "" : "s"} behind. Comment \`${command}\` to refresh it.`);
  }
  if (note) lines.push("", note);

  const many = marker.diagrams.length > 1;
  for (const diagram of marker.diagrams) {
    lines.push("");
    if (many) lines.push(`**${alt(diagram.title)}**`, "");
    const link = diagram.share_url || diagram.url;
    if (diagram.image_url && diagram.share_url) {
      // ?v= makes GitHub's image proxy fetch a fresh copy after each update;
      // the server ignores it.
      lines.push(`[![${alt(diagram.title)}](${diagram.image_url}?v=${short(marker.sha)})](${diagram.share_url})`, "");
    }
    lines.push(`[Open the walkthrough →](${link})`);
  }

  lines.push("", `<sub>From \`${short(marker.sha)}\` · \`${command}\` refreshes · \`${command} regenerate\` overwrites edits made in Flostep · \`${command} delete\` removes it</sub>`);
  return lines.join("\n");
}
