import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  act, json, REPO, HEAD, PR, FILES, STEPS, ANTHROPIC_ENV,
  commentEvent, saved, anthropicReply, prRoutes, permission
} from "./harness.js";
import { readMarker, writeMarker } from "../src/comment.js";

const LLM = "POST /v1/messages";
const FLOSTEP_OK = {
  folder: { id: 3, name: "PR diagrams", created: false },
  syntax: { code: 0, stdout: "A -> B: what happens\n" },
  upsert: saved()
};

const reactions = (r) => r.calls.filter((c) => c.key?.endsWith("/reactions")).map((c) => c.body.content);
const postedComment = (r) => r.body("POST /repos/acme/shop/issues/44/comments")?.body;

describe("who may run /flostep", () => {
  for (const role of ["read", "triage", "none"]) {
    test(`${role} access: no reaction, no Flostep, no model`, async () => {
      const r = await act({
        eventName: "issue_comment",
        event: commentEvent(),
        env: ANTHROPIC_ENV,
        github: { "GET /repos/acme/shop/collaborators/maintainer/permission": permission(role) }
      });

      assert.equal(r.code, 0);
      assert.deepEqual(r.github, ["GET /repos/acme/shop/collaborators/maintainer/permission"]);
      assert.equal(r.flostep.length, 0);
      assert.equal(r.llm.length, 0);
    });
  }

  // On a fork, the PR's author is the untrusted party; a maintainer runs it.
  test("the PR's author without write access is refused the same way", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent({ login: "contributor" }),
      env: ANTHROPIC_ENV,
      github: { "GET /repos/acme/shop/collaborators/contributor/permission": json(404, { message: "Not Found" }) }
    });

    assert.equal(r.code, 0);
    assert.equal(r.github.length, 1);
    assert.equal(r.flostep.length, 0);
    assert.equal(r.llm.length, 0);
  });

  test("maintain is enough", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: prRoutes({ role: "maintain" }),
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: FLOSTEP_OK
    });
    assert.deepEqual(reactions(r), ["eyes", "rocket"]);
  });

  test("a comment that isn't the command, or isn't on a PR, does nothing at all", async () => {
    for (const event of [
      commentEvent({ body: "looks good, /flostep later maybe" }),
      { ...commentEvent(), issue: { number: 44 } },
      { ...commentEvent(), action: "edited" }
    ]) {
      const r = await act({ eventName: "issue_comment", event, env: ANTHROPIC_ENV });
      assert.equal(r.calls.length, 0);
    }
  });
});

describe("/flostep in AI mode", () => {
  test("drafts steps, publishes them by ref, and posts the comment", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: prRoutes(),
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: FLOSTEP_OK
    });

    assert.equal(r.code, 0);
    assert.deepEqual(r.unrouted, []);
    assert.deepEqual(reactions(r), ["eyes", "rocket"]);

    const upsert = r.flostep.find((c) => c.args[0] === "upsert");
    assert.deepEqual(upsert.args, ["upsert", "--ref", `github:${REPO}#44`, "--title", "PR #44: Cache sessions in Redis", "--folder", "PR diagrams", "--share", "--json"]);
    assert.equal(upsert.stdin, STEPS);
    assert.equal(upsert.env.FLOSTEP_TOKEN, "fls_test");
    assert.equal(upsert.pin, "flostep@0.1.6");

    // The model saw the grammar from the server, the PR, and a diff without the lockfile.
    const request = r.llm[0].body;
    assert.match(request.system, /A -> B: what happens/);
    assert.match(request.messages[0].content, /Cache sessions in Redis/);
    assert.match(request.messages[0].content, /redis\.read/);
    assert.doesNotMatch(request.messages[0].content, /redis \(5\.0\)/);
    assert.match(request.messages[0].content, /Gemfile\.lock/, "every changed file is still listed");

    const body = postedComment(r);
    assert.match(body, /\[!\[PR #44: Cache sessions in Redis\]\(https:\/\/flostep\.test\/s\/tok\.svg\?v=abc1234\)\]\(https:\/\/flostep\.test\/s\/tok\)/);
    assert.deepEqual(readMarker(body), {
      sha: HEAD,
      diagrams: [{ ref: `github:${REPO}#44`, id: "Xk3p9QvA2wE", title: "PR #44: Cache sessions in Redis", version: 1, url: saved().url, share_url: saved().share_url, image_url: saved().image_url }]
    });
  });

  test("an existing bot comment is edited, and its version is sent as --if-version", async () => {
    const marker = { sha: "old0000", diagrams: [{ ref: `github:${REPO}#44`, id: "Xk3p9QvA2wE", title: "t", version: 3 }] };
    const existing = { id: 77, user: { type: "Bot" }, body: writeMarker(marker) };
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: { ...prRoutes({ comments: [existing] }), "PATCH /repos/acme/shop/issues/comments/77": {} },
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: { ...FLOSTEP_OK, upsert: saved({ version: 4, created: false }) }
    });

    const upsert = r.flostep.find((c) => c.args[0] === "upsert");
    assert.deepEqual(upsert.args.slice(-3), ["--if-version", "3", "--json"]);
    assert.equal(readMarker(r.body("PATCH /repos/acme/shop/issues/comments/77").body).diagrams[0].version, 4);
    assert.equal(postedComment(r), undefined, "no second comment");
  });

  // A personal access token in github-token makes the bot's comment a User's.
  test("a comment that opens with the marker is the bot's, whoever its author", async () => {
    const existing = { id: 79, user: { type: "User" }, body: writeMarker({ sha: "old", diagrams: [] }) };
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: { ...prRoutes({ comments: [existing] }), "PATCH /repos/acme/shop/issues/comments/79": {} },
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: FLOSTEP_OK
    });
    assert.ok(r.github.includes("PATCH /repos/acme/shop/issues/comments/79"));
    assert.equal(postedComment(r), undefined);
  });

  test("a person quoting the marker doesn't become the bot's comment", async () => {
    const quoted = { id: 78, user: { type: "User" }, body: `> ${writeMarker({ sha: "x", diagrams: [] })}` };
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: prRoutes({ comments: [quoted] }),
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: FLOSTEP_OK
    });
    assert.ok(postedComment(r), "a new bot comment, not an edit of the person's");
  });

  test("a hand edit is left alone and the reply says how to overwrite it", async () => {
    const marker = { sha: "old0000", diagrams: [{ ref: `github:${REPO}#44`, id: "Xk3p9QvA2wE", title: "t", version: 3, share_url: "https://flostep.test/s/tok" }] };
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: { ...prRoutes({ comments: [{ id: 77, user: { type: "Bot" }, body: writeMarker(marker) }] }), "PATCH /repos/acme/shop/issues/comments/77": {} },
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: {
        ...FLOSTEP_OK,
        upsert: { code: 1, stderr: "Diagram Xk3p9QvA2wE changed after you read it (you had version 3, it is now version 5).\n  Run `flostep show <id>`…" }
      }
    });

    assert.deepEqual(reactions(r), ["eyes", "confused"]);
    assert.match(postedComment(r), /^@maintainer .*edited in Flostep.*\/flostep regenerate/s);
    // The comment keeps showing the diagram, with the version it last wrote.
    assert.equal(readMarker(r.body("PATCH /repos/acme/shop/issues/comments/77").body).diagrams[0].version, 3);
  });

  test("regenerate sends no version, so a hand edit is overwritten", async () => {
    const marker = { sha: "old0000", diagrams: [{ ref: `github:${REPO}#44`, version: 3 }] };
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent({ body: "/flostep regenerate" }),
      env: ANTHROPIC_ENV,
      github: { ...prRoutes({ comments: [{ id: 77, user: { type: "Bot" }, body: writeMarker(marker) }] }), "PATCH /repos/acme/shop/issues/comments/77": {} },
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: { ...FLOSTEP_OK, upsert: saved({ version: 6, created: false }) }
    });

    const upsert = r.flostep.find((c) => c.args[0] === "upsert");
    assert.ok(!upsert.args.includes("--if-version"));
    assert.deepEqual(reactions(r), ["eyes", "rocket"]);
  });

  test("NONE from the model publishes nothing and says so in the comment", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: prRoutes(),
      llm: { [LLM]: anthropicReply("NONE") },
      flostep: FLOSTEP_OK
    });

    assert.ok(!r.flostep.some((c) => c.args[0] === "upsert"));
    assert.match(postedComment(r), /Nothing in this change has a flow worth drawing/);
    assert.deepEqual(reactions(r), ["eyes", "rocket"]);
  });

  test("steps the parser refuses get one repair turn carrying its sentence", async () => {
    let upserts = 0;
    let llmCalls = 0;
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: prRoutes(),
      llm: { [LLM]: () => anthropicReply(++llmCalls === 1 ? "Here is the flow:" : STEPS) },
      flostep: {
        ...FLOSTEP_OK,
        upsert: () => (++upserts === 1
          ? { code: 1, stderr: "What arrived on stdin has no steps — it doesn't look like a diagram.\n" }
          : { code: 0, stdout: JSON.stringify(saved()) })
      }
    });

    assert.equal(r.llm.length, 2);
    const repair = r.llm[1].body.messages;
    assert.equal(repair.length, 3);
    assert.equal(repair[1].role, "assistant");
    assert.match(repair[2].content, /doesn't look like a diagram/);
    assert.deepEqual(reactions(r), ["eyes", "rocket"]);
  });

  test("a second refusal gives up with a reply, and never fails the run", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: prRoutes(),
      llm: { [LLM]: anthropicReply("not steps") },
      flostep: { ...FLOSTEP_OK, upsert: { code: 1, stderr: "What arrived on stdin has no steps — it doesn't look like a diagram.\n" } }
    });

    assert.equal(r.code, 0);
    assert.equal(r.llm.length, 2);
    assert.deepEqual(reactions(r), ["eyes", "confused"]);
    assert.match(postedComment(r), /^@maintainer Couldn't make the diagram/);
  });

  test("without a model or steps-file, the reply says what to configure", async () => {
    const r = await act({ eventName: "issue_comment", event: commentEvent(), github: prRoutes(), flostep: FLOSTEP_OK });

    assert.equal(r.code, 0);
    assert.deepEqual(reactions(r), ["eyes", "confused"]);
    assert.match(postedComment(r), /llm-provider, llm-model and llm-api-key/);
  });

  test("steps-file publishes the file and calls no model", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: { ...ANTHROPIC_ENV, "INPUT_STEPS-FILE": "steps.txt" },
      files: { "steps.txt": `${STEPS}\n` },
      github: prRoutes(),
      flostep: FLOSTEP_OK
    });

    assert.equal(r.llm.length, 0);
    assert.equal(r.flostep.find((c) => c.args[0] === "upsert").stdin, STEPS);
  });

  test("an unknown subcommand is answered and changes nothing", async () => {
    const r = await act({ eventName: "issue_comment", event: commentEvent({ body: "/flostep please" }), github: prRoutes(), flostep: FLOSTEP_OK });

    assert.deepEqual(reactions(r), ["eyes", "confused"]);
    assert.match(postedComment(r), /isn't a command/);
    assert.equal(r.flostep.length, 0);
  });
});

describe("/flostep in file mode", () => {
  const flowFile = { filename: "docs/checkout.flostep", status: "modified", additions: 1, deletions: 0, patch: "+x" };

  test("previews each changed .flostep file by path and calls no model", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent(),
      env: ANTHROPIC_ENV,
      github: {
        ...prRoutes({ files: [...FILES, flowFile, { ...flowFile, filename: "docs/old.flostep", status: "removed" }] }),
        [`GET /repos/acme/shop/contents/docs/checkout.flostep?ref=${HEAD}`]: "# flostep-title: Checkout\nCart -> API: pay"
      },
      flostep: { ...FLOSTEP_OK, upsert: saved({ title: "PR #44 preview: Checkout" }) }
    });

    assert.equal(r.llm.length, 0);
    const upserts = r.flostep.filter((c) => c.args[0] === "upsert");
    assert.equal(upserts.length, 1, "removed files aren't previewed");
    assert.deepEqual(upserts[0].args.slice(0, 5), ["upsert", "--ref", `github:${REPO}#44:docs/checkout.flostep`, "--title", "PR #44 preview: Checkout"]);
    assert.match(upserts[0].stdin, /Cart -> API: pay/);
  });

  test("mode: files with no .flostep changes says so", async () => {
    const r = await act({ eventName: "issue_comment", event: commentEvent(), env: { INPUT_MODE: "files" }, github: prRoutes(), flostep: FLOSTEP_OK });

    assert.ok(!r.flostep.some((c) => c.args[0] === "upsert"));
    assert.match(postedComment(r), /changes no `\.flostep` files/);
  });
});

describe("/flostep delete", () => {
  test("deletes this PR's diagrams by ref — not another PR's — and the comment", async () => {
    const r = await act({
      eventName: "issue_comment",
      event: commentEvent({ body: "/flostep delete" }),
      github: {
        ...prRoutes({ comments: [{ id: 77, user: { type: "Bot" }, body: writeMarker({ sha: HEAD, diagrams: [{ ref: `github:${REPO}#44` }] }) }] }),
        "DELETE /repos/acme/shop/issues/comments/77": json(204)
      },
      flostep: {
        list: [
          { id: "a", external_ref: `github:${REPO}#44` },
          { id: "b", external_ref: `github:${REPO}#44:docs/checkout.flostep` },
          { id: "c", external_ref: `github:${REPO}#445` },
          { id: "d", external_ref: null }
        ],
        delete: { code: 0, stdout: "" }
      }
    });

    const deleted = r.flostep.filter((c) => c.args[0] === "delete").map((c) => c.args[2]);
    assert.deepEqual(deleted.sort(), [`github:${REPO}#44`, `github:${REPO}#44:docs/checkout.flostep`]);
    assert.ok(r.github.includes("DELETE /repos/acme/shop/issues/comments/77"));
    assert.deepEqual(reactions(r), ["eyes", "rocket"]);
  });
});

describe("a closed pull request", () => {
  const closed = (merged) => ({ action: "closed", pull_request: { ...PR, state: "closed", merged } });
  const routes = { "GET /repos/acme/shop/issues/44/comments?per_page=100&page=1": [] };
  const list = [{ external_ref: `github:${REPO}#44` }, { external_ref: `github:${REPO}#44:docs/checkout.flostep` }];

  test("merged: previews go, the PR's diagram stays as its record", async () => {
    const r = await act({ eventName: "pull_request", event: closed(true), github: routes, flostep: { list, delete: { code: 0 } } });
    assert.deepEqual(r.flostep.filter((c) => c.args[0] === "delete").map((c) => c.args[2]), [`github:${REPO}#44:docs/checkout.flostep`]);
  });

  test("closed unmerged: everything goes", async () => {
    const r = await act({ eventName: "pull_request", event: closed(false), github: routes, flostep: { list, delete: { code: 0 } } });
    assert.equal(r.flostep.filter((c) => c.args[0] === "delete").length, 2);
  });

  test("a fork's run without the token cleans nothing and stays green", async () => {
    const r = await act({ eventName: "pull_request", event: closed(false), env: { "INPUT_FLOSTEP-TOKEN": "" } });
    assert.equal(r.code, 0);
    assert.equal(r.calls.length, 0);
  });
});

describe("a push to the pull request", () => {
  const sync = { action: "synchronize", pull_request: { ...PR, head: { sha: "fff9999" } } };
  const marker = { sha: HEAD, diagrams: [{ ref: `github:${REPO}#44`, title: "PR #44", share_url: "https://flostep.test/s/tok", image_url: "https://flostep.test/s/tok.svg" }] };

  test("marks the diagram out of date, touching neither Flostep nor the model", async () => {
    const r = await act({
      eventName: "pull_request",
      event: sync,
      env: ANTHROPIC_ENV,
      github: {
        "GET /repos/acme/shop/issues/44/comments?per_page=100&page=1": [{ id: 77, user: { type: "Bot" }, body: writeMarker(marker) }],
        [`GET /repos/acme/shop/compare/${HEAD}...fff9999`]: { ahead_by: 2 },
        "PATCH /repos/acme/shop/issues/comments/77": {}
      }
    });

    assert.equal(r.flostep.length, 0);
    assert.equal(r.llm.length, 0);
    const body = r.body("PATCH /repos/acme/shop/issues/comments/77").body;
    assert.match(body, /from `abc1234`, 2 commits behind\. Comment `\/flostep` to refresh/);
    assert.deepEqual(readMarker(body), marker, "the marker itself is unchanged");
  });

  test("auto: push regenerates instead", async () => {
    const r = await act({
      eventName: "pull_request",
      event: { ...sync, pull_request: PR },
      env: { ...ANTHROPIC_ENV, INPUT_AUTO: "push" },
      github: prRoutes(),
      llm: { [LLM]: anthropicReply(STEPS) },
      flostep: FLOSTEP_OK
    });
    assert.ok(r.flostep.some((c) => c.args[0] === "upsert"));
  });
});

describe("a push to the default branch", () => {
  const push = { before: "aaa1111", after: "bbb2222" };

  test("updates each changed file's live diagram by path, adopting a pinned id", async () => {
    const r = await act({
      eventName: "push",
      event: push,
      github: {
        "GET /repos/acme/shop/compare/aaa1111...bbb2222": {
          files: [
            { filename: "docs/checkout.flostep", status: "modified" },
            { filename: "docs/gone.flostep", status: "removed" },
            { filename: "app/x.rb", status: "modified" }
          ]
        },
        "GET /repos/acme/shop/contents/docs/checkout.flostep?ref=bbb2222": "# flostep-id: Ab12Cd34Ef5\nCart -> API: pay"
      },
      flostep: { folder: { id: 1 }, upsert: saved({ created: false }) }
    });

    const upserts = r.flostep.filter((c) => c.args[0] === "upsert");
    assert.equal(upserts.length, 1, "deleted files keep their diagrams");
    assert.deepEqual(upserts[0].args, ["upsert", "--ref", `github:${REPO}:docs/checkout.flostep`, "--title", "checkout", "--folder", "Diagrams", "--share", "--adopt", "Ab12Cd34Ef5", "--json"]);
  });

  test("a new branch is skipped", async () => {
    const r = await act({ eventName: "push", event: { before: "0000000000000000000000000000000000000000", after: "b" } });
    assert.equal(r.calls.length, 0);
  });
});

describe("configuration", () => {
  test("half-configured AI mode fails the run loudly", async () => {
    const r = await act({ eventName: "issue_comment", event: commentEvent(), env: { "INPUT_LLM-PROVIDER": "openai", "INPUT_LLM-MODEL": "gpt-5" } });

    assert.equal(r.code, 1);
    assert.match(r.logs.find(([level]) => level === "error")[1], /go together/);
    assert.equal(r.calls.length, 0);
  });

  test("an unknown provider names the OpenAI-compatible route", async () => {
    const r = await act({ eventName: "issue_comment", event: commentEvent(), env: { "INPUT_LLM-PROVIDER": "gemini", "INPUT_LLM-MODEL": "gemini-2.5-pro", "INPUT_LLM-API-KEY": "k" } });

    assert.equal(r.code, 1);
    assert.match(r.logs.find(([level]) => level === "error")[1], /"openai" with llm-base-url/);
  });
});
