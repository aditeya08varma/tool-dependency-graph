/**
 * Reports how the matching logic actually performs on a catalog: not just
 * nodes/edges, but what fraction of required inputs got suppressed as
 * ambient, matched a producer, or found nothing at all. That last number is
 * the one that tells you whether an LLM fallback pass would actually help.
 *
 * Usage: node --import tsx src/metrics.ts catalogs/github.json
 */
import { loadCatalog, generate, requiredInputNames, slugOf } from "./generate.ts";

const catalogPath = process.argv[2];
if (!catalogPath) throw new Error("usage: metrics.ts <catalog.json>");

const tools = loadCatalog(catalogPath);
const graph = generate(tools);

// Recompute the same ambient cutoff generate() uses, to classify every
// required input the same way it did internally.
const AMBIENT_FREQUENCY_THRESHOLD = 0.05;
const requiredByCount = new Map<string, number>();
const allRequired: { tool: string; param: string }[] = [];
for (const tool of tools) {
  const slug = slugOf(tool)!;
  for (const param of requiredInputNames(tool)) {
    allRequired.push({ tool: slug, param });
    const key = param.toLowerCase();
    requiredByCount.set(key, (requiredByCount.get(key) ?? 0) + 1);
  }
}
const ambientCutoff = Math.max(tools.length * AMBIENT_FREQUENCY_THRESHOLD, 2);

const matchedPairs = new Set(graph.edges.map((e) => `${e.to}::${e.label}`));

let ambientCount = 0;
let matchedCount = 0;
let unmatchedCount = 0;
const unmatchedSamples: string[] = [];

for (const { tool, param } of allRequired) {
  const key = param.toLowerCase();
  if ((requiredByCount.get(key) ?? 0) > ambientCutoff) {
    ambientCount++;
  } else if (matchedPairs.has(`${tool}::${param}`)) {
    matchedCount++;
  } else {
    unmatchedCount++;
    if (unmatchedSamples.length < 15) unmatchedSamples.push(`${tool} needs "${param}"`);
  }
}

const total = allRequired.length;
const pct = (n: number) => `${n} (${((n / total) * 100).toFixed(1)}%)`;

console.log(JSON.stringify({
  catalog: catalogPath,
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  edges_per_node: Number((graph.edges.length / graph.nodes.length).toFixed(2)),
  total_required_inputs: total,
  suppressed_as_ambient: pct(ambientCount),
  matched_to_a_producer: pct(matchedCount),
  unmatched_residual: pct(unmatchedCount),
}, null, 2));

if (unmatchedSamples.length) {
  console.log("\nSample of unmatched required inputs (candidates for an LLM fallback pass):");
  for (const s of unmatchedSamples) console.log(`  - ${s}`);
}
