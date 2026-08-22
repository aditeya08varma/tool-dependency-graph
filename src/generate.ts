/**
 * CLI wrapper. The actual matching logic lives in core.ts (kept dependency-
 * free so it can also be bundled for the browser app in web/).
 *
 * Usage: node --import tsx src/generate.ts path/to/catalog.json [--out path]
 */
import { readFileSync, writeFileSync } from "fs";
import { generate, slugOf, type Tool } from "./core.ts";

function parseArgs() {
  const args = process.argv.slice(2);
  const outFlagIndex = args.indexOf("--out");
  const outPath = outFlagIndex >= 0 ? args[outFlagIndex + 1] : "dependency_graph.json";
  const catalogPath = args.filter((a, i) => a !== "--out" && args[i - 1] !== "--out")[0];
  if (!catalogPath) throw new Error("pass the toolkit catalog path as an argument");
  return { catalogPath, outPath };
}

export function loadCatalog(path: string): Tool[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function main() {
  const { catalogPath, outPath } = parseArgs();
  const tools = loadCatalog(catalogPath);
  const graph = generate(tools);
  writeFileSync(outPath, JSON.stringify(graph, null, 2), "utf-8");

  const slugs = new Set(tools.map((t) => String(slugOf(t)).toUpperCase()));
  const provenance = graph.nodes.length
    ? graph.nodes.filter((n) => slugs.has(n.id.toUpperCase())).length / graph.nodes.length
    : 0;

  console.log(JSON.stringify({
    catalog: catalogPath,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    edges_per_node: Number((graph.edges.length / graph.nodes.length).toFixed(2)),
    provenance_ratio: Number(provenance.toFixed(3)),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
