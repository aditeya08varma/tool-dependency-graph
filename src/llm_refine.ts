/**
 * LLM refinement pass, run on top of the deterministic graph. Two separate
 * jobs, matched to the two separate problems found via ground-truth scoring:
 *
 *  1. VALIDATE low-confidence edges. These come from either a multi-word
 *     compound type name (only one word of several matched -- e.g. "pull" in
 *     "PullRequest") or a bare-field context-overlap. Both mechanisms produce
 *     real matches (PullRequest -> pull_number) and wrong ones (WorkflowRun
 *     -> workflow_id) via the identical process -- no lexical rule can tell
 *     them apart, since it's a question of domain convention, not grammar.
 *     An LLM can answer "does a WorkflowRun's own id actually mean the same
 *     thing as a workflow's id?" in a way string matching cannot.
 *
 *  2. FILL genuinely unmatched required inputs (zero deterministic candidates
 *     at all) -- this is the synonym/substring class (username vs login,
 *     hook_id vs Webhook) that lexical matching structurally cannot solve.
 *
 * Only runs if OPENAI_API_KEY is set. Without it, this is a no-op and the
 * deterministic graph (including its low-confidence edges, kept as-is) is
 * exactly what you get -- the tool works standalone with zero API calls.
 *
 * Usage: OPENAI_API_KEY=... node --import tsx src/llm_refine.ts catalogs/x.json [--out path]
 */
import { readFileSync, writeFileSync } from "fs";
import OpenAI from "openai";
import { generateDetailed, slugOf, declaredOutputFields, type Tool, type Graph, type DetailedEdge, type UnmatchedInput } from "./core.ts";

function loadCatalog(path: string): Tool[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const outFlagIndex = args.indexOf("--out");
  const outPath = outFlagIndex >= 0 ? args[outFlagIndex + 1] : "dependency_graph.json";
  const catalogPath = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out")[0];
  if (!catalogPath) throw new Error("pass the toolkit catalog path as an argument");
  return { catalogPath, outPath };
}

const BATCH_SIZE = 15;

async function validateLowConfidenceEdges(
  client: OpenAI,
  lowConfidence: DetailedEdge[],
  toolBySlug: Map<string, Tool>,
): Promise<{ kept: DetailedEdge[]; rejected: DetailedEdge[]; raw: any[] }> {
  const kept: DetailedEdge[] = [];
  const rejected: DetailedEdge[] = [];
  const raw: any[] = [];

  for (let i = 0; i < lowConfidence.length; i += BATCH_SIZE) {
    const batch = lowConfidence.slice(i, i + BATCH_SIZE);
    const items = batch.map((e, idx) => ({
      index: idx,
      producer: e.from,
      producer_description: toolBySlug.get(e.from)?.description,
      // The producer's ACTUAL enclosing type for this specific field -- e.g.
      // GITHUB_GET_A_RELEASE's tool name suggests "Release", but if the
      // matched field actually came from a nested "ReleaseAsset" sub-object,
      // this says so. Without this, "producer looks like it's about X" and
      // "producer's field is actually about Y" are indistinguishable.
      producer_actual_field_source_type: e.producerType,
      consumer: e.to,
      required_param: e.label,
      consumer_param_description: toolBySlug.get(e.to)?.inputParameters?.properties?.[e.label]?.description,
    }));

    const prompt = `For each candidate below, a deterministic matcher found that "producer" tool's output MIGHT supply the "consumer" tool's required "required_param". This match came from a single overlapping word inside a multi-word type name (or a loose field-name overlap), so it is NOT guaranteed to be semantically correct -- e.g. a "WorkflowRun" object's own id is NOT the same thing as a "workflow_id", even though "workflow" appears in "WorkflowRun". By contrast, "PullRequest"'s identifying number genuinely IS what "pull_number" refers to -- that's a real, known API convention, not a coincidence.

Pay close attention to "producer_actual_field_source_type": it's the REAL type the matched field belongs to, which can differ from what the producer tool's own name suggests. A tool named like it's about "Release" can still validly supply "asset_id" if this field's actual source type is "ReleaseAsset" (a nested sub-object) -- that's a correct match, not a coincidence, because ReleaseAsset genuinely represents an asset. Don't reject a match just because the tool's own name doesn't mention the consumer's concept -- check whether producer_actual_field_source_type does.

For each item, decide: does the producer's output plausibly and specifically supply this exact required parameter, based on real-world API conventions -- not just shared words?

Candidates:
${JSON.stringify(items, null, 0)}

Respond with strict JSON: {"decisions": [{"index": 0, "keep": true, "reason": "short reason"}, ...]} -- one entry per candidate, in order.`;

    try {
      const resp = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? "openai/gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
      const decisions: { index: number; keep: boolean; reason: string }[] = parsed.decisions ?? [];
      raw.push({ batch: i / BATCH_SIZE, items, decisions });

      for (const item of items) {
        const decision = decisions.find((d) => d.index === item.index);
        const edge = batch[item.index];
        if (decision?.keep) kept.push(edge);
        else rejected.push(edge);
      }
    } catch (err) {
      console.error("LLM validation batch failed, keeping candidates as-is:", err);
      kept.push(...batch);
    }
  }

  return { kept, rejected, raw };
}

async function fillUnmatchedInputs(
  client: OpenAI,
  unmatched: UnmatchedInput[],
  tools: Tool[],
  toolBySlug: Map<string, Tool>,
): Promise<{ found: DetailedEdge[]; raw: any[] }> {
  if (unmatched.length === 0) return { found: [], raw: [] };

  // Include each tool's ACTUAL declared output fields, not just its
  // description -- without this, the model fills gaps from background
  // knowledge of what a similar real-world API "usually" returns (e.g.
  // assuming a Slack profile has an email field because real ones do), not
  // from what this catalog actually declares.
  const producerSummaries = tools.map((t) => ({
    slug: slugOf(t),
    description: t.description,
    declared_output_fields: declaredOutputFields(t),
  })).filter((p) => p.slug);

  const found: DetailedEdge[] = [];
  const raw: any[] = [];

  for (let i = 0; i < unmatched.length; i += BATCH_SIZE) {
    const batch = unmatched.slice(i, i + BATCH_SIZE);
    const items = batch.map((u, idx) => ({
      index: idx,
      consumer: u.tool,
      consumer_description: toolBySlug.get(u.tool)?.description,
      required_param: u.param,
      param_description: toolBySlug.get(u.tool)?.inputParameters?.properties?.[u.param]?.description,
    }));

    const prompt = `A deterministic name-matcher found NO producer for each required parameter below -- often because of a synonym (e.g. a tool returns "login" but another requires "username") or a substring the matcher's word-tokenizer doesn't credit (e.g. "Webhook" vs "hook_id"). For each item, list EVERY tool whose output plausibly supplies that exact value under a different name -- there may be more than one valid producer (e.g. both a "list" and a "get" endpoint for the same entity), so don't stop at the first one you find. If nothing plausible exists (e.g. it's genuinely user-authored content like a title or message body), omit it.

Only propose a producer whose "declared_output_fields" list actually contains a field that plausibly maps to the required parameter. Do NOT propose a producer based on what a similar real-world API would typically return if this catalog's declared fields don't actually include it -- e.g. don't assume a user-profile tool returns an email just because real ones often do; check whether "email" (or an equivalent field) is actually in its declared_output_fields first.

Watch specifically for parameters on a CREATE-style tool that happen to share a name with a field on the entity that tool creates -- that's usually the caller inventing a brand-new value, not looking one up. Example: "tag_name" on a "create a release" tool is the caller naming a NEW tag (like "v2.0.0") right then; the fact that existing releases also happen to have a "tag_name" field doesn't mean you should fetch it from one of them -- there's nothing to look up, the value doesn't exist yet until this call creates it. Only propose a producer when the value must already exist somewhere before this call can succeed.

Available tools:
${JSON.stringify(producerSummaries.slice(0, 300), null, 0)}

Unmatched required parameters:
${JSON.stringify(items, null, 0)}

Respond with strict JSON: {"found": [{"index": 0, "producers": ["<tool slug>", "..."], "reason": "short reason"}, ...]} -- omit indices with no plausible producer, and include ALL plausible producers per index, not just one.`;

    try {
      const resp = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? "openai/gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}");
      const results: { index: number; producers: string[]; reason: string }[] = parsed.found ?? [];
      raw.push({ batch: i / BATCH_SIZE, items, results });

      for (const r of results) {
        const item = batch[r.index];
        if (!item) continue;
        for (const producer of r.producers ?? []) {
          if (producer === item.tool) continue;
          found.push({ from: producer, to: item.tool, label: item.param, confidence: "low", producerType: "(llm-inferred)" });
        }
      }
    } catch (err) {
      console.error("LLM fill-gap batch failed, skipping:", err);
    }
  }

  return { found, raw };
}

async function main() {
  const { catalogPath, outPath } = parseArgs();
  const tools = loadCatalog(catalogPath);
  const toolBySlug = new Map(tools.map((t) => [slugOf(t)!, t]));
  const { nodes, edges, unmatched } = generateDetailed(tools);

  const highConfidence = edges.filter((e) => e.confidence === "high");
  const lowConfidence = edges.filter((e) => e.confidence === "low");

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      `No OPENAI_API_KEY set -- skipping LLM refinement. Writing deterministic graph as-is ` +
      `(${highConfidence.length} high-confidence + ${lowConfidence.length} low-confidence edges, unreviewed).`,
    );
    const graph: Graph = { nodes, edges: edges.map(({ from, to, label }) => ({ from, to, label })) };
    writeFileSync(outPath, JSON.stringify(graph, null, 2), "utf-8");
    return;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });

  console.error(`Validating ${lowConfidence.length} low-confidence edges...`);
  const { kept, rejected, raw: validationLog } = await validateLowConfidenceEdges(client, lowConfidence, toolBySlug);

  console.error(`Searching for producers for ${unmatched.length} unmatched required inputs...`);
  const { found, raw: fillLog } = await fillUnmatchedInputs(client, unmatched, tools, toolBySlug);

  const finalEdges = [...highConfidence, ...kept, ...found];
  const graph: Graph = { nodes, edges: finalEdges.map(({ from, to, label }) => ({ from, to, label })) };
  writeFileSync(outPath, JSON.stringify(graph, null, 2), "utf-8");

  writeFileSync(
    "llm_refine_debug.json",
    JSON.stringify({ rejected, found, validationLog, fillLog }, null, 2),
    "utf-8",
  );

  console.error(JSON.stringify({
    high_confidence_kept: highConfidence.length,
    low_confidence_validated_kept: kept.length,
    low_confidence_rejected: rejected.length,
    new_edges_from_unmatched: found.length,
    total_edges: finalEdges.length,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
