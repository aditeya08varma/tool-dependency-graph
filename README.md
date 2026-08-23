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

## Closing the gaps the scorer found

Two fixes landed from the precision/recall numbers above, and one deliberately didn't — worth walking through, because the one that didn't work is more informative than the ones that did.

**A fix that looked right and wasn't.** The obvious-seeming theory: compound type names are right-headed in English ("WorkflowRun" is a kind of *run*, not a kind of *workflow*), so only trust the *last* word. Concrete counter-evidence killed it: `PullRequest` → `pull_number` (correct) and `WorkflowRun` → `workflow_id` (wrong) both work by matching the *first* word of a two-word compound — the exact same mechanism produces one true positive and one false positive. Position in the compound name doesn't correlate with correctness at all; the actual difference is whether "pull_number" is a real, known API convention, which is a fact about the domain, not the grammar. No lexical rule can see that.

**A fix that did work.** `DeploymentStatus.id` was falsely satisfying an unrelated `status` enum parameter — a different bug entirely, since `status` (`queued`/`in_progress`/`completed`) was never asking for an ID in the first place. The real signal: a required param constrained by `enum` in its schema is a closed set of caller choices, not a lookup value. Excluding enum-constrained params from matching entirely fixed this with zero side effects (verified against both ground-truth catalogs — no regressions).

**What that split reveals, precisely.** Every match now carries a confidence label: `high` when the producer's entire type name is a single word (`Issue`, `Release` — unambiguous), `low` when the match only works because of one word inside a multi-word compound, or via a loose bare-field overlap. Checked against ground truth: **0 of 37 high-confidence edges on the 42-tool catalog are wrong.** Every false positive lives in the low-confidence bucket — and so does every true positive that depends on a compound qualifier word (`pull_number`, `commit_sha`). That's not a flaw in the split; it's the same fact stated precisely: lexical matching genuinely cannot tell these apart, so isolating exactly which edges are unverifiable by lexical means — rather than either trusting or discarding all of them — is the honest place to stop without semantic help.

**Where the LLM actually earns its cost.** `src/llm_refine.ts` runs on top of the deterministic pass, and only touches what the analysis above identified as genuinely ambiguous:
1. **Validates low-confidence edges** — asks specifically "does a WorkflowRun's own id actually mean the same as a workflow's id?", not "find edges."
2. **Fills unmatched required inputs** — the synonym/substring class (`username` vs `login`, `hook_id` vs `Webhook`) that no lexical rule can close, by name.

```bash
npm run refine -- catalogs/github_extended.json --out dependency_graph.json
```

(reads credentials from a local, gitignored `.env` — `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`; never committed, never hardcoded into tracked source.)

Without an API key present, this is a verified no-op: diffed its output against the plain deterministic CLI and confirmed byte-identical edge sets — the tool works standalone, the LLM step is a pure opt-in addition, never a requirement.

**Tested against Gemini via its OpenAI-compatibility endpoint, across three iterations of prompt fixes, on all three catalogs that have ground truth:**

| Catalog | Deterministic | LLM v1 | LLM v2 | LLM v3 (current) |
|---|---|---|---|---|
| GitHub (16 tools) | 0.857 / 0.923 / 0.889 | — | — | **1.000 / 0.923 / 0.960** |
| GitHub extended (42 tools) | 0.567 / 0.902 / 0.696 | 0.846 / 0.902 / 0.873 | 0.762 / **1.000** / 0.865 | **0.847 / 1.000 / 0.917** |
| Slack (14 tools) | **1.000** / 0.250 / 0.400 | — | — | 0.444 / **1.000** / 0.615 |

*(precision / recall / F1)*

**What each iteration actually fixed, and what it revealed:**

- **v1**: validated low-confidence edges using only tool descriptions. Correctly rejected `LIST_CHECK_RUNS_FOR_A_REF → GET_A_WORKFLOW_RUN [run_id]` with *"Check run IDs belong to the Check Runs API and are distinct from GitHub Actions workflow run IDs"* — but also wrongly rejected a real nested-entity case (`GET_A_RELEASE → GET_A_RELEASE_ASSET [asset_id]`), since it had no way to see that the field actually came from a nested `ReleaseAsset`, not the release itself.
- **v2**: fixed that by passing each field's *actual* enclosing type name (`producerType`) instead of just a description, and by asking the fill-gap step for *all* plausible producers instead of one. Recall reached 1.0 on the extended catalog — but surfaced a new, distinct false positive: `tag_name` (caller-chosen, like a title) got treated as fetchable.
- **v3**: fixed `tag_name` with an explicit create-vs-lookup principle in the prompt (confirmed: zero `tag_name` edges now, anywhere), and grounded the fill-gap step in each tool's *actual declared output fields* instead of letting it guess from background knowledge of similar real-world APIs — this measurably mattered on Slack specifically, where it stopped assuming `GET_USER_INFO`/`LIST_USERS` return an `email` field that this catalog's schema simply doesn't declare, even though real Slack profiles do have one.

**Precision on Slack is still low (0.444), and it's worth being precise about why rather than treating it as a failure.** Checking the actual schema: 7 of the 10 "false positives" are technically correct — `SLACK_UPDATE_MESSAGE` really does declare a `ts` field in its own response, `Message` really does declare a `user` field — my hand-built ground truth simply didn't anticipate every tool that happens to also expose a matching field. Exactly **one** is a genuine, distinct mismatch: `GET_USER_INFO → INVITE_TO_CONVERSATION [users]` — a tool returning a single user wrongly satisfying a parameter that needs a plural list. That's a real, narrow, fixable gap (a producer/consumer cardinality check, singular vs. plural), not evidence the approach doesn't work — just the next thing worth doing, not yet done.

**One honest scope boundary, found on the 16-tool catalog:** `LIST_BRANCHES → GET_A_BRANCH [branch]` is still missed, and it's not a prompt problem — the fill-gap step only reviews required inputs with *zero* deterministic candidates. Since `branch` already had one producer (`LIST_PULL_REQUESTS`, via a different field), it was never eligible for the LLM to propose a second, better one. Deliberate cost control, not a bug, but a real edge the current design can't reach.

### Stress-testing against an adversarial catalog

GitHub and Slack are real APIs, not catalogs built to break this specific tool. `catalogs/payments.json` (41 Stripe-style tools, `tests/ground_truth.payments.json` with 118 hand-derived edges) is deliberately engineered to hit two known weak points at once: `customer_id` is required by 13/41 tools (31.7%, comfortably above the 15% ambient-suppression threshold), and `PaymentIntent`/`SetupIntent`/`PaymentMethod` share overlapping tokens the way `WorkflowRun`/`PullRequest` do on GitHub. It also plants two silent legacy-name synonyms (`cust_id` for `customer_id`, `pm_id` for `payment_method_id`) with explicit "(legacy short form of ...)" hints in their param descriptions.

The first pass surfaced a real bug, not just a benchmark number: `customer_id` was being blanket-suppressed as "ambient" before either the deterministic matcher or the LLM layer ever got a chance to see it, at any confidence level.

| Catalog | Deterministic (before fix) | Deterministic (after fix) | LLM-refined (after fix) |
|---|---|---|---|
| Payments (41 tools) | 0.548 / 0.585 / 0.566 | 0.608 / 0.907 / 0.728 | **0.790 / 0.924 / 0.852** |

*(precision / recall / F1 — run via `node --import tsx src/score_graph.ts <graph> tests/ground_truth.payments.json`, since `score.ts` only ever measures the deterministic core; scoring the LLM-refined *output* needed a small second script, `src/score_graph.ts`, added specifically for this.)*

**The bug, and why the obvious fix ("just remove the ambient filter") is wrong.** Ambient suppression exists so widely-shared caller context (`owner`/`repo` on GitHub) doesn't get treated as a lookup value — checked with `declaredOutputFields()`, neither has a producer anywhere in a 42-tool GitHub catalog, confirming they really are external context, not a matching gap. But "frequent" also describes something else entirely: a central entity's id needed by many workflows (`customer_id`), which *does* have a real in-catalog producer (`Customer.id`). Both looked identical by frequency alone.

The fix (`src/core.ts`): only suppress a frequent param as ambient if it *also* has zero producer via an exact compound-key match (`customer` + `id` = `customer_id`) — not the looser bare-identifier heuristic. That distinction mattered in practice: an earlier version of the fix used *any* producer (including bare-identifier matches) to override ambient suppression, and it broke Slack's `channel` — required by nearly every Slack tool as pure caller context, yet `Channel.id`'s context word happens to bare-overlap with a param literally named `channel`, the exact same loose mechanism that legitimately resolves `User.id → user`. Using an intentionally-uncertain heuristic to override another heuristic is circular; restricting the override to *exact* compound-key producers fixed `customer_id` without reopening `channel` (confirmed: all 8 tests pass, GitHub/GitHub-extended/Slack scores are byte-identical to before this change).

**What actually improved, staged:**
- **Deterministic recall: 0.585 → 0.907.** The `customer_id` family (39 edges), `cust_id`, and `pm_id` are no longer silently dropped before matching even runs.
- **LLM-refined, full pipeline: 0.852 F1**, the best of any catalog tested. Validation still cleans up the `PaymentIntent`/`SetupIntent`/`PaymentMethod` cross-contamination the deterministic pass produces from shared tokens (same mechanism proven on GitHub's `WorkflowRun`/`PullRequest` case), and the fill-gap step this run connected both `cust_id` and `pm_id` to their real producers despite the earlier run (documented below) missing them entirely — a reminder that LLM synonym resolution isn't fully deterministic run-to-run, not just a fixed capability.
- **The workload number that matters most:** payments.json's total share of inputs needing *any* LLM call stayed flat at 39.2% before and after this fix (verified with `src/llm_workload.ts`) — but its composition flipped. Previously 27.5% of inputs were wrongly written off as ambient (dead weight, no chance at recall); now that's 2.0%, and the recovered inputs landed as **high-confidence, zero-LLM-call matches** (33.3% → 58.8%), not new LLM work. Slack's workload split (45.0% zero-LLM / 55.0% needs-LLM) is byte-identical before and after — confirming the fix only activates where a real compound producer exists, never wherever something is merely frequent.

**One earlier, now-superseded finding, kept for the record:** the very first LLM-refined run (before the ambient fix landed) scored 0.929 / 0.551 / 0.691 — a precision-only illusion, since ~45 of its 53 false negatives were the exact `customer_id`/`cust_id`/`pm_id` edges the ambient bug made structurally unreachable by any LLM step. That run also caught a real, separate finding worth keeping: the fill-gap step came back genuinely empty (`{"found": []}`, verified via `llm_refine_debug.json` — not a caught error or quota fallback) for `cust_id`/`pm_id` even with an explicit "(legacy short form of customer_id)" hint in the param description — a synonym-resolution miss the Gemini-tested catalogs never surfaced, and one the later run above didn't reliably avoid either (it succeeded that time, but the mechanism is non-deterministic, not fixed).

### A bigger, more deeply-nested catalog surfaces two new failure modes

`catalogs/tracker.json` (57 tools, an issue-tracker domain — Workspace/Project/Sprint/Epic/Issue/Comment/Board/Webhook, etc. — with `tests/ground_truth.tracker.json`, 208 hand-derived edges) is deliberately bigger and more deeply nested than any prior catalog: `Board → BoardColumn → Issue → {reporter, assignee}: User` is four `$ref` levels deep, `Issue.parent_issue_id` is genuinely self-referential, and the same underlying entity (`User`) is needed under four different role names (`reporter_id`, `assignee_id`, `author_id`, `uploaded_by`) instead of payments.json's two.

| | Precision | Recall | F1 |
|---|---|---|---|
| Deterministic | 0.695 | 0.942 | 0.800 |
| LLM-refined | 0.627 | **0.986** | 0.766 |

Recall is the best of any catalog tested. Precision *dropping* after LLM refinement is a first, and the reason is two new, distinct bugs this catalog was finally complex enough to expose — neither is the ambient-threshold issue above; both are new.

**1. Nested-entity leakage, and why it's invisible.** The compound-key matcher indexes any reachable `(type, field)` pair regardless of nesting depth or whether that type is a tool's actual subject. So `TRK_CREATE_BOARD` — nominally about boards — silently becomes a "certain" producer of `issue_id` *and* `user_id` for over a dozen unrelated consumers, purely because `Issue`/`User` happen to be reachable four levels down in its response schema. Worse: since the matched type name is a single word (`Issue`, `User`), it's tagged **high-confidence** — the exact tier `generateDetailed()` treats as unambiguous enough to skip LLM review entirely. This produced 86 of the run's false positives, and the LLM refinement layer had zero opportunity to catch any of them, because they never reach it. The proof this is a confidence-tagging gap rather than an unfixable one: the identical leakage pattern also happened via `parent_issue_id` (self-referential, matched via the bare-identifier path, tagged **low**-confidence) — and there, LLM validation caught it correctly, rejecting `TRK_CREATE_BOARD → LINK_SUBTASK [parent_issue_id]` with *"Board creation doesn't yield an Issue id."* Same underlying bug, two confidence paths, only one has a safety net.

**2. Fill-gap hallucination on generic caller-authored fields.** For `TRK_CREATE_BOARD`'s `name` param (a brand-new name the caller is inventing), the fill-gap step proposed **37 of the 57 tools in the catalog** as valid producers — anything with any `name`-shaped output field. Its own returned reasoning: *"it's more likely that the board name is user-provided... [but] since 'name' is a common field, they are plausible producers."* The model identified the correct answer, then overrode itself — the prompt's "list every plausible producer, don't stop at one" instruction beat the create-vs-lookup guidance once a generic field name (`name`/`title`/`url`/`emoji`) turned out to be shared across dozens of entities. This is the same bug class as the `tag_name` fix earlier in this README, and proves that fix was narrower than it looked — it closed one specific instance, not the general pattern.

Both are open, not yet fixed: (1) needs confidence tagging to account for nesting depth/directness, not just whether a type name is one word; (2) needs the fill-gap prompt's exhaustiveness instruction to stop overriding its own create-vs-lookup judgment when a field name is common across many entities.

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

To use `npm run refine` (the optional LLM step), copy `.env.example` to `.env` and fill in your own credentials — `.env` is gitignored and never committed.
