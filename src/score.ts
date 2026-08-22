/**
 * Compares generate()'s actual output against a hand-labeled ground-truth
 * edge list and reports real precision/recall/F1 -- not just an edge count.
 * This is what actually answers "is it capturing everything it should,
 * and only what it should" instead of eyeballing the output.
 *
 * Usage: node --import tsx src/score.ts catalogs/github.json tests/ground_truth.github.json
 */
import { readFileSync } from "fs";
import { generate, type Tool } from "./core.ts";

const [catalogPath, groundTruthPath] = process.argv.slice(2);
if (!catalogPath || !groundTruthPath) {
  throw new Error("usage: score.ts <catalog.json> <ground_truth.json>");
}

function loadCatalog(path: string): Tool[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

const edgeKey = (e: { from: string; to: string; label: string }) => `${e.from}->${e.to}->${e.label}`;

const tools = loadCatalog(catalogPath);
const actual = generate(tools).edges;
const truth = JSON.parse(readFileSync(groundTruthPath, "utf-8")).edges as
  { from: string; to: string; label: string }[];

const actualKeys = new Set(actual.map(edgeKey));
const truthKeys = new Set(truth.map(edgeKey));

const truePositives = actual.filter((e) => truthKeys.has(edgeKey(e)));
const falsePositives = actual.filter((e) => !truthKeys.has(edgeKey(e)));
const falseNegatives = truth.filter((e) => !actualKeys.has(edgeKey(e)));

const precision = actual.length ? truePositives.length / actual.length : 0;
const recall = truth.length ? truePositives.length / truth.length : 0;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

console.log(JSON.stringify({
  catalog: catalogPath,
  ground_truth_edges: truth.length,
  generator_output_edges: actual.length,
  true_positives: truePositives.length,
  false_positives: falsePositives.length,
  false_negatives: falseNegatives.length,
  precision: Number(precision.toFixed(3)),
  recall: Number(recall.toFixed(3)),
  f1: Number(f1.toFixed(3)),
}, null, 2));

if (falsePositives.length) {
  console.log("\nFalse positives (generator found, but shouldn't have):");
  for (const e of falsePositives) console.log(`  ${e.from} -> ${e.to} [${e.label}]`);
}
if (falseNegatives.length) {
  console.log("\nFalse negatives (should exist, generator missed):");
  for (const e of falseNegatives) console.log(`  ${e.from} -> ${e.to} [${e.label}]`);
}
