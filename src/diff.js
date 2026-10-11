// The part of a PR's diff worth sending to a model, built from the per-file
// patches GitHub already returns with the file list — so a path can be left
// out by name, and a PR too large for GitHub's whole-diff endpoint still works.

const DEFAULT_IGNORE = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/Gemfile.lock", "**/poetry.lock",
  "**/Cargo.lock", "**/go.sum", "**/composer.lock", "**/*.lock",
  "**/node_modules/**", "**/vendor/**", "**/dist/**", "**/build/**", "**/coverage/**",
  "**/*.min.js", "**/*.map", "**/*.snap", "**/*.svg", "**/db/schema.rb"
];

export const DIFF_LIMIT = 60_000;

export function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more whole directories.
      if (glob[i + 2] === "/") { pattern += "(?:.*/)?"; i += 2; } else { pattern += ".*"; i += 1; }
    } else if (c === "*") pattern += "[^/]*";
    else if (c === "?") pattern += "[^/]";
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

export function buildDiff(files, { ignore = [], limit = DIFF_LIMIT } = {}) {
  const patterns = [...DEFAULT_IGNORE, ...ignore].map(globToRegExp);
  const ignored = (name) => patterns.some((re) => re.test(name));

  let text = "";
  const omitted = [];
  for (const file of files) {
    if (ignored(file.filename) || !file.patch) continue;
    const chunk = `--- ${file.previous_filename ?? file.filename}\n+++ ${file.filename}\n${file.patch}\n`;
    if (text.length + chunk.length > limit) { omitted.push(file.filename); continue; }
    text += chunk;
  }

  return { text: text.trimEnd() || "(no textual changes outside ignored paths)", truncated: omitted.length > 0, omitted };
}
