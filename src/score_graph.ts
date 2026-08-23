/**
 * Same precision/recall/F1 methodology as score.ts, but compares a
 * precomputed graph (e.g. llm_refine.ts's output) directly against ground
 * truth, instead of regenerating from a catalog with generate(). score.ts
 * can only ever measure the deterministic core -- this is what's needed to
 * score the LLM-refined pipeline's actual output.
 *
 * Usage: node --import tsx src/score_graph.ts <graph.json> <ground_truth.json>
 */
import { readFileSync } from "fs";

const [graphPath, groundTruthPath] = process.argv.slice(2);
if (!graphPath || !groundTruthPath) {
  throw new Error("usage: score_graph.ts <graph.json> <ground_truth.json>");
}

const edgeKey = (e: { from: string; to: string; label: string }) => `${e.from}->${e.to}->${e.label}`;

const actual = (JSON.parse(readFileSync(graphPath, "utf-8")).edges ?? []) as
  { from: string; to: string; label: string }[];
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
  graph: graphPath,
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
