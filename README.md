# Flostep PR Diagram

Comment **`/flostep`** on a pull request and get a walkable [Flostep](https://flostep.dev) diagram of the flow it changes, posted as an image that links to the step-through walkthrough.

- **From committed `.flostep` files**, if the PR changes any: each one is previewed as it stands in the PR. The live diagram is only updated once the change reaches the default branch.
- **From the diff, with any LLM**, otherwise: Claude, OpenAI, Gemini, Azure OpenAI, Groq, Mistral, OpenRouter, a self-hosted Ollama or vLLM. Or bring your own steps from an earlier step in the job.

The diagram is made **when someone asks for it**, not on every push. A push only marks the comment as out of date, and the next `/flostep` refreshes it with the same link.

## Setup

1. Create a Flostep API key at [flostep.dev/api-keys](https://flostep.dev/api-keys): **Read & write**, expiry **Never**. Save it as the repository secret `FLOSTEP_TOKEN`.
2. For AI mode, save your model provider's API key as a secret, e.g. `LLM_API_KEY`.
3. Add `.github/workflows/flostep.yml`:

```yaml
name: Flostep
on:
  issue_comment:
    types: [created]
  pull_request:
    types: [synchronize, closed]
  push:
    branches: [main]
    paths: ["**/*.flostep"]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: flostep-${{ github.event.issue.number || github.event.pull_request.number || github.ref }}

jobs:
  diagram:
    runs-on: ubuntu-latest
    steps:
      - uses: flostep/flostep-action@v1
        with:
          flostep-token: ${{ secrets.FLOSTEP_TOKEN }}
          llm-provider: anthropic
          llm-model: claude-opus-5-5
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

Leave the three `llm-` inputs out to use committed `.flostep` files only.

## Commands

| Comment | Does |
|---|---|
| `/flostep` | Make the diagram, or refresh it to the current head |
| `/flostep regenerate` | The same, but overwrites a diagram someone edited by hand in Flostep |
| `/flostep delete` | Delete this PR's diagrams and the bot comment |

The bot reacts 👀 when it starts, then 🚀 or 😕. Only people with **write access** to the repository can run it. That includes a PR's author only if they have write access.

If someone edits the diagram in Flostep, `/flostep` leaves their edits alone and says so. `/flostep regenerate` is the explicit way to overwrite them.

## Choosing a model

There is no default provider or model. Which LLM reads your code is your call. `llm-provider` picks the request format:

```yaml
# Claude
llm-provider: anthropic
llm-model: claude-opus-5-5

# OpenAI
llm-provider: openai
llm-model: gpt-5

# Gemini, through its OpenAI-compatible endpoint
llm-provider: openai
llm-model: gemini-2.5-pro
llm-base-url: https://generativelanguage.googleapis.com/v1beta/openai

# Azure OpenAI
llm-provider: openai
llm-model: <your deployment name>
llm-base-url: https://<resource>.openai.azure.com/openai/v1

# OpenRouter, Groq, Mistral, a self-hosted Ollama or vLLM on a self-hosted runner…
llm-provider: openai
llm-model: <model>
llm-base-url: <the provider's OpenAI-compatible base URL>
```

The model gets Flostep's step grammar (fetched from Flostep, so it is always current), the PR's title and description, the list of changed files, and the diff. Lockfiles, vendored and generated code are left out; add your own globs with `paths-ignore`. If Flostep's parser rejects the answer, the model gets one retry with the parser's error. When nothing in the change is flow-shaped, the model answers `NONE` and the comment says so.

### Bring your own steps

Point `steps-file` at a file written by an earlier step in the job, from any tool or internal gateway, and the action publishes that instead of calling a model:

```yaml
      - run: ./scripts/describe-flow > steps.txt   # your generator
      - uses: flostep/flostep-action@v1
        with:
          flostep-token: ${{ secrets.FLOSTEP_TOKEN }}
          steps-file: steps.txt
```

## Committed `.flostep` files

When the PR changes `.flostep` files, each one gets a **preview** diagram for that PR, and no model is called. On a push to the default branch, each changed file's **live** diagram is created or updated. It's keyed by the file's path, so its share link stays the same from one merge to the next. Previews are deleted when the PR closes.

Two optional header lines (the parser ignores `#` lines):

```
# flostep-title: Checkout
# flostep-id: Xk3p9QvA2wE
Cart -> API: POST /checkout
```

`flostep-id` ties the file to a diagram you already have, so a link you've already shared keeps working. Renaming a file without it starts a new live diagram.

## Inputs

| Input | Default | |
|---|---|---|
| `flostep-token` | (required) | Flostep API key, read & write, no expiry |
| `llm-provider` | | `anthropic` or `openai` (any OpenAI-compatible API) |
| `llm-model` | | Model id as the provider spells it |
| `llm-api-key` | | The provider's API key |
| `llm-base-url` | provider default | For Gemini, Azure, OpenRouter, Ollama… |
| `steps-file` | | Publish this file instead of calling a model |
| `mode` | `auto` | `auto` (files if any changed, else AI), `files`, or `ai` |
| `auto` | `none` | Also generate without a comment: `opened` (when a PR opens or is ready for review) or `push` (every push) |
| `command` | `/flostep` | The comment command |
| `folder` | `PR diagrams` | Flostep folder for PR diagrams and previews |
| `files-folder` | `Diagrams` | Flostep folder for live diagrams of committed files |
| `share` | `true` | Turn on each diagram's public link. The image in the comment needs it. |
| `paths-ignore` | | Extra globs left out of the diff |
| `max-files` | `10` | Most `.flostep` previews per PR |
| `github-token` | `github.token` | Leave as is |

## Security and privacy

- **Only collaborators with write access trigger it.** `issue_comment` runs with your secrets even on PRs from forks, so the action checks the commenter's permission before doing anything, including reacting. It never checks out or runs code from the PR: the diff and file contents are read through the API, as text.
- **The diff is sent to the provider you configure,** and nowhere else.
- **The diff is untrusted input to the model.** The model's answer is only ever step text, published under a ref the action chooses. The model has no tools and can't pick an id or run a command. The worst a hostile diff can do is produce a misleading diagram on its own PR.
- **`share: true` makes each diagram readable by anyone with its link,** which is how the image in the comment renders. For a private repository where that isn't acceptable, set `share: false` and the comment links to the diagram in your Flostep workspace instead.
- **Permissions:** `contents: read` and `pull-requests: write` (for comments and reactions). Nothing else.
- **For maximum safety, pin the action to a full commit SHA** rather than `@v1`.

Images in the comment need a paid Flostep plan. On a free workspace the comment shows a link instead.

## License

MIT
