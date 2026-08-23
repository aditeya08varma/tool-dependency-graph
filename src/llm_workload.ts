/**
 * Answers a specific question: of every required input across a catalog, how
 * many did the deterministic core resolve on its own (zero LLM involvement --
 * ambient-suppressed, enum-excluded, or high-confidence matched) versus how
 * many actually need an LLM call (low-confidence validation, or fill-gap for
 * zero-candidate inputs)? This is the workload split the deterministic pass
 * exists to create -- without it, every required input would need an LLM
 * judgment call instead of only the genuinely ambiguous ones.
 *
 * Usage: node --import tsx src/llm_workload.ts catalogs/x.json
 */
import { readFileSync } from "fs";
import { generateDetailed, requiredInputNames, slugOf, type Tool } from "./core.ts";

function loadCatalog(path: string): Tool[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

const catalogPath = process.argv[2];
if (!catalogPath) throw new Error("usage: llm_workload.ts <catalog.json>");

const tools = loadCatalog(catalogPath);
const toolBySlug = new Map(tools.map((t) => [slugOf(t), t]));
const { edges, unmatched } = generateDetailed(tools);

const allRequired: { tool: string; param: string }[] = [];
for (const tool of tools) {
  const slug = slugOf(tool)!;
  for (const param of requiredInputNames(tool)) allRequired.push({ tool: slug, param });
}

const unmatchedSet = new Set(unmatched.map((u) => `${u.tool}::${u.param}`));

// confidence per (tool,param): "high" if any producer for it is high, else "low"
const confidenceByInput = new Map<string, "high" | "low">();
for (const e of edges) {
  const key = `${e.to}::${e.label}`;
  const existing = confidenceByInput.get(key);
  if (existing !== "high") confidenceByInput.set(key, e.confidence);
}

let ambientOrEnum = 0;
let highConfidence = 0;
let lowConfidenceOnly = 0;
let unmatchedCount = 0;

for (const { tool, param } of allRequired) {
  const key = `${tool}::${param}`;
  if (unmatchedSet.has(key)) {
    unmatchedCount++;
    continue;
  }
  const conf = confidenceByInput.get(key);
  if (conf === "high") {
    highConfidence++;
  } else if (conf === "low") {
    lowConfidenceOnly++;
  } else {
    // not ambient (would've been unmatched if not enum-excluded either),
    // not matched -- must have been filtered before candidate-building.
    ambientOrEnum++;
  }
}

const total = allRequired.length;
const resolvedByDeterministic = ambientOrEnum + highConfidence;
const needsLlm = lowConfidenceOnly + unmatchedCount;
const pct = (n: number) => `${n} (${((n / total) * 100).toFixed(1)}%)`;

console.log(JSON.stringify({
  catalog: catalogPath,
  total_required_inputs: total,
  resolved_with_zero_llm_calls: pct(resolvedByDeterministic),
  breakdown: {
    ambient_or_enum_excluded: pct(ambientOrEnum),
    high_confidence_matched: pct(highConfidence),
  },
  needs_an_llm_call: pct(needsLlm),
  breakdown_llm: {
    low_confidence_needs_validation: pct(lowConfidenceOnly),
    unmatched_needs_fill_gap: pct(unmatchedCount),
  },
}, null, 2));
