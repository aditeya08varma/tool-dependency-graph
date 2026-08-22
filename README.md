# tool-dependency-graph

Infers a **producer → consumer dependency graph** between API tools, from nothing but their JSON-schema catalogs — no hardcoded tool names, no LLM calls, no toolkit-specific logic.

## The problem

When an agent chains API calls together, some actions need information that only another action can supply first. A concrete example: to comment on a GitHub issue you need an `issue_number` — and the only way to get one is to have already called something like "list repository issues" or "create an issue." That's a **dependency**: `LIST_REPOSITORY_ISSUES → CREATE_AN_ISSUE_COMMENT`, connected by `issue_number`.

Given a big catalog of tools (each with a declared input schema and output schema), this project builds that graph automatically — by figuring out, for every tool's required input, which *other* tool's output could plausibly supply it.

## Why it's harder than it sounds

The catalog format used here wraps every tool's output identically:

```json
{ "data": { "$ref": "#/$defs/SomeResponse" }, "error": "string", "successful": true }
```

Every tool looks the same from the outside — `{data, error, successful}`. The real fields are hidden one or more `$ref` hops deep inside `$defs`, so naive "compare the two schemas' top-level properties" matching finds nothing.

Once you resolve that, the opposite problem shows up: almost every tool needs *some* form of scope (`owner`/`repo` on GitHub, `channel` on Slack). Those aren't dependencies — they're context the caller already has, not something looked up by calling another tool first. A matcher that doesn't distinguish the two produces a graph where everything appears connected to everything.

## How it works

`src/generate.ts` is a four-stage pipeline:

1. **Resolve** — recursively walk each tool's `outputParameters`, following every `$ref`/`$defs` indirection (cycle-guarded and depth-capped, since these schemas can reference themselves), flattening the result into every reachable field, each tagged with the tokens of its nearest enclosing named type (e.g. a `number` field inside a type called `PullRequest` is tagged with `["pull", "request"]`).
2. **Match, compound** — for each tool's required input, check whether any other tool has a field whose enclosing-type tokens plus field name form a matching compound (`pull` + `number` → `pull_number`). This is what lets `PullRequest.number` satisfy a consumer's `pull_number`, even though there's no field anywhere literally named `pull_number`.
3. **Match, bare** — a field matched purely by its own name (`id`, `sha`, `ref`, …) is only trusted when it's shaped like a real identifier *and* its enclosing type shares a word with the consumer's param name — this is what lets a `User.id` field satisfy a `user` param without also matching every unrelated `*_id` param in the catalog.
4. **Suppress ambient params** — any required input shared by more than ~5% of all tools in the catalog is treated as caller-supplied context, not a dependency, and dropped before matching. This is a *frequency* signal, not a list of known scope-param names — nothing toolkit-specific is hardcoded anywhere in this pipeline, which is what let it run against a second, structurally different catalog without modification.

## Proof it generalizes

The generator runs unmodified against two catalogs with different naming conventions:

| Catalog | Tools | Edges | Notable catch |
|---|---|---|---|
| [`catalogs/github.json`](catalogs/github.json) | 16 | 14 | `LIST_REPOSITORY_ISSUES → CREATE_AN_ISSUE_COMMENT` via `issue_number`; `LIST_PULL_REQUESTS → GET_A_BRANCH` via `branch` — the latter wasn't hand-tuned for, it fell out of the same context-matching rule |
| [`catalogs/slack.json`](catalogs/slack.json) | 14 | 2 | `LIST_USERS → GET_USER_INFO` via `user`, despite Slack's `user`/`channel` convention looking nothing like GitHub's `*_number`/`*_id` suffixes |

Regenerate either with `npm run demo:github` / `npm run demo:slack`, or open the committed [`visualization.github.html`](visualization.github.html) / [`visualization.slack.html`](visualization.slack.html) directly — both are self-contained (the graph JSON is embedded inline, so there's no fetch/CORS dependency and no server needed).

## Known limitation — and a confirmed instance of it

Matching is purely lexical and structural; it has no semantic understanding of what a field *means*. Concretely, this surfaced a real false-positive class in this exact codebase: `GITHUB_MERGE_A_PULL_REQUEST`'s own output type is named `MergeAPullRequestResponse` — a name that embeds the tool's own action ("merge a pull request"), not a description of what its fields mean. Because the resolver tags a field's context with its *enclosing type's* tokens, `MergeAPullRequestResponse.sha` shares the token "pull" with a consumer's `pull_number` param purely by naming coincidence, producing a spurious edge — verified by manually auditing all 14 edges in the GitHub demo catalog.

The underlying cause: RPC-style catalogs conventionally name a tool's own top-level response wrapper `<VerbNoun>Response`, which leaks the tool's own action name into context the same way a genuinely reused entity type (`Issue`, `PullRequest`, `User`) would — but a wrapper referenced from exactly one place isn't the same kind of signal as a type reused across many tools. A cleaner fix (weight context by how many places a type is `$ref`'d from) was considered and rejected here: at small catalog scale it broke a different, correct match (`Invitation`, which only happens to appear once in this demo catalog). Fixing this properly needs either a larger catalog to make the reuse-count signal reliable, or a small second pass that specifically discounts a tool's own top-level wrapper type. Left as an open, documented gap rather than patched with something fragile.

## How do you know it's actually right?

Edge count alone doesn't tell you that — a graph can look plausible and still be mostly wrong, or mostly right but missing things, and you can't tell which just by eyeballing it. `src/score.ts` answers this properly: it compares the generator's actual output against a **hand-derived ground truth** — every producer/consumer relationship worked out independently by reading each tool's schema, not by looking at what the tool already found — and reports real precision, recall, and F1.

```bash
npm run score -- catalogs/github.json tests/ground_truth.github.json
npm run score -- catalogs/github_extended.json tests/ground_truth.github_extended.json
```

| Catalog | Precision | Recall | F1 |
|---|---|---|---|
| GitHub (16 tools) | 0.857 | 0.923 | 0.889 |
| GitHub extended (42 tools) | 0.556 | 0.902 | 0.688 |

This is also how a real, previously-invisible bug got caught: the ambient-frequency threshold (originally 5%, calibrated against a much larger 893-tool catalog) was silently discarding real dependencies on the 42-tool catalog, because a genuinely scarce ID shared by 3-4 related tools (e.g. `gist_id` across gist endpoints) is >5% of only 42 tools. Recall on that catalog was 34% before raising the threshold to 15%, and 90% after — a one-line fix that ground-truth scoring caught and casual inspection of edge counts never would have. See `tests/ground_truth.*.json` for the full hand-worked reasoning behind every expected edge, including the two cases (`username`/`login`, `hook_id`/`Webhook`) deliberately left as known misses to document exactly where the tokenizer's limits are.

## How the matching logic actually performs

`npm run metrics -- catalogs/<name>.json` classifies every required input in a catalog into one of three buckets, instead of just reporting a raw edge count:

| Catalog | Suppressed as ambient | Matched to a producer | Unmatched residual |
|---|---|---|---|
| GitHub | 71.4% | 19.0% | 9.5% (4 inputs) |
| Slack | 45.0% | 5.0% | 50.0% (10 inputs) |

The unmatched residual isn't automatically "wrong" — most of it is genuinely user-supplied content with no producer to find (an issue's `title`, a message's `text`, an email address). But breaking down Slack's residual specifically surfaces a real, precise gap: `SLACK_POST_MESSAGE` produces a message `ts`, but `SLACK_UPDATE_MESSAGE`/`SLACK_DELETE_MESSAGE` (`ts`) and `SLACK_ADD_REACTION`/`SLACK_PIN_MESSAGE` (`timestamp`) never connect to it, because neither `ts` nor `timestamp` is shaped like the identifiers this matcher trusts (`_id`/`_number`/`_sha`/etc.). That's exactly the kind of case an LLM fallback pass would close — now backed by a number instead of a guess.

## Try it in the browser

`web/index.html` is a self-contained, client-side app — paste or upload a catalog, click generate, get the graph. Nothing is sent anywhere; the same matching code from `src/core.ts` runs directly in your browser via a bundled script.

```bash
npm run build:web   # regenerates web/core.bundle.js and web/index.html
open web/index.html # or just double-click it
```

## Running it

```bash
npm install
npm run generate -- catalogs/github.json --out dependency_graph.json
npm run viz -- dependency_graph.json visualization.html
npm run metrics -- catalogs/github.json
npm test
```

`generate.ts` (and the pure logic in `core.ts` it wraps) takes any catalog in the same shape (array of tools, each with `slug`, `inputParameters.required`, `outputParameters.properties.data` resolving through `$defs`) — it isn't specific to either catalog committed here.
