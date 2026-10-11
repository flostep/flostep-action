// The handful of GitHub REST calls the action makes, over plain fetch.

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_PAGES = 30; // 3,000 items: the most files GitHub lists for one PR.

export class GitHub {
  constructor({ token, apiUrl, repo, fetch = globalThis.fetch }) {
    this.token = token;
    this.apiUrl = apiUrl;
    this.repo = repo;
    this.fetch = fetch;
  }

  async request(method, path, { body, accept = "application/vnd.github+json", text = false } = {}) {
    const response = await this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "flostep/action-to-flostep",
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const raw = await response.text();
    if (!response.ok) {
      let message = raw;
      try { message = JSON.parse(raw).message ?? raw; } catch { /* not JSON */ }
      throw new GitHubError(response.status, `GitHub ${method} ${path} returned ${response.status}: ${message}`);
    }
    if (text) return raw;
    return raw ? JSON.parse(raw) : null;
  }

  async paginate(path) {
    const items = [];
    const joiner = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.request("GET", `${path}${joiner}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  // "admin" | "maintain" | "write" | "triage" | "read" | "none". role_name is
  // the precise one; `permission` folds maintain into write and triage into
  // read. Someone who isn't a collaborator at all can be a 404.
  async permission(user) {
    try {
      const data = await this.request("GET", `/repos/${this.repo}/collaborators/${encodeURIComponent(user)}/permission`);
      return data.role_name || data.permission || "none";
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return "none";
      throw error;
    }
  }

  react(commentId, content) {
    return this.request("POST", `/repos/${this.repo}/issues/comments/${commentId}/reactions`, { body: { content } });
  }

  pull(number) { return this.request("GET", `/repos/${this.repo}/pulls/${number}`); }
  pullFiles(number) { return this.paginate(`/repos/${this.repo}/pulls/${number}/files`); }
  comments(number) { return this.paginate(`/repos/${this.repo}/issues/${number}/comments`); }

  createComment(number, body) {
    return this.request("POST", `/repos/${this.repo}/issues/${number}/comments`, { body: { body } });
  }
  updateComment(id, body) {
    return this.request("PATCH", `/repos/${this.repo}/issues/comments/${id}`, { body: { body } });
  }
  deleteComment(id) {
    return this.request("DELETE", `/repos/${this.repo}/issues/comments/${id}`);
  }

  // A file's text at a commit. A fork's head commit is reachable from the base
  // repository, so this works for PRs from forks without checking anything out.
  fileAt(path, ref) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.request("GET", `/repos/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
      accept: "application/vnd.github.raw+json",
      text: true
    });
  }

  compare(base, head) {
    return this.request("GET", `/repos/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  }
}
