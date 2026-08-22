/**
 * Reads a toolkit's tool catalog (Composio-style: slug, inputParameters,
 * outputParameters with $ref/$defs) and infers a producer -> consumer
 * dependency graph, without any toolkit-specific vocabulary.
 *
 * Usage: node --import tsx src/generate.ts path/to/catalog.json [--out path]
 */
import { readFileSync, writeFileSync } from "fs";

type Tool = Record<string, any>;
interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label: string;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

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

export function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

const KNOWN_HINT_TAGS = new Set([
  "openWorldHint", "updateHint", "createHint", "idempotentHint",
  "destructiveHint", "mcpIgnore", "important", "readOnlyHint",
]);

function serviceOf(tool: Tool): string | undefined {
  const tags: string[] = tool.tags ?? [];
  const tag = tags.find((t) => !KNOWN_HINT_TAGS.has(t) && !/Hint$/.test(t));
  return tag ? tag.toLowerCase() : undefined;
}

export function requiredInputNames(tool: Tool): string[] {
  const req: string[] = tool.inputParameters?.required ?? [];
  return req.map(String);
}

interface FieldRef {
  /** tokens of the nearest enclosing $defs name, e.g. ["pull","request"] for "PullRequest" */
  contextTokens: string[];
  fieldName: string;
}

function splitWords(name: string): string[] {
  const words = name.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [name];
  return words.map((w) => w.toLowerCase());
}

/** Recursively resolve $ref/$defs, collecting every reachable field with the
 * token-context of its nearest enclosing named schema. Cycle-guarded and
 * depth-capped since these schemas can be self-referential. */
function collectFields(
  node: any,
  defs: Record<string, any>,
  contextTokens: string[],
  collected: FieldRef[],
  visited: Set<string>,
  depth: number,
): void {
  if (!node || depth > 5) return;

  if (node.$ref) {
    const defName = String(node.$ref).split("/").pop()!;
    if (visited.has(defName)) return;
    const resolved = defs[defName];
    if (!resolved) return;
    collectFields(resolved, defs, splitWords(defName), collected, new Set(visited).add(defName), depth);
    return;
  }

  if (node.type === "array" && node.items) {
    collectFields(node.items, defs, contextTokens, collected, visited, depth);
    return;
  }

  if (node.properties) {
    for (const [fieldName, fieldSchema] of Object.entries<any>(node.properties)) {
      collected.push({ contextTokens, fieldName });
      collectFields(fieldSchema, defs, contextTokens, collected, visited, depth + 1);
    }
  }
}

function outputFields(tool: Tool): FieldRef[] {
  const op = tool.outputParameters;
  if (!op) return [];
  const defs = op.$defs ?? {};
  const dataSchema = op.properties?.data;
  if (!dataSchema) return [];
  const collected: FieldRef[] = [];
  collectFields(dataSchema, defs, [], collected, new Set(), 0);
  return collected;
}

// A bare field name (no context prefix) is only trusted as a signal if it's
// shaped like a resource identifier, and even then only when its enclosing
// context is semantically related to the consumer param -- this is what
// stops a generic "id" field from matching every unrelated *_id param.
const IDENTIFIER_SHAPE = /(^|_)(id|number|sha|slug|ref|key|token)$/i;

// Any input required by more than this fraction of the catalog's tools is
// ambient context (the caller already has it), not a scarce lookup result.
// No toolkit vocabulary is named here -- it's a frequency signal.
const AMBIENT_FREQUENCY_THRESHOLD = 0.05;

function compoundCandidates(field: FieldRef): string[] {
  const f = field.fieldName.toLowerCase();
  return field.contextTokens.map((t) => `${t}_${f}`);
}

function bareIdentifierMatch(field: FieldRef, consumerParam: string): boolean {
  const f = field.fieldName.toLowerCase();
  if (!IDENTIFIER_SHAPE.test(f)) return false;
  // Context-gate: a bare id/number/sha only counts if some word of the
  // consumer's own param name overlaps with the field's enclosing context.
  // (e.g. a bare "id" inside something tokenized "comment" only matches
  // "comment_id", not every unrelated *_id param.)
  const consumerWords = new Set(consumerParam.toLowerCase().split("_"));
  return field.contextTokens.some((t) => consumerWords.has(t));
}

interface ProducerField extends FieldRef {
  slug: string;
}

function buildIndex(tools: Tool[]): Map<string, ProducerField[]> {
  const index = new Map<string, ProducerField[]>();
  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug) continue;
    for (const field of outputFields(tool)) {
      for (const key of compoundCandidates(field)) {
        if (!index.has(key)) index.set(key, []);
        index.get(key)!.push({ slug, ...field });
      }
    }
  }
  return index;
}

export function generate(tools: Tool[]): Graph {
  const nodes: Node[] = tools
    .map((t) => ({ id: slugOf(t), service: serviceOf(t) }))
    .filter((n): n is Node => !!n.id);

  const requiredByCount = new Map<string, number>();
  for (const tool of tools) {
    for (const name of requiredInputNames(tool)) {
      const key = name.toLowerCase();
      requiredByCount.set(key, (requiredByCount.get(key) ?? 0) + 1);
    }
  }
  // On small catalogs, 5% of N can round below 1 and wrongly flag every
  // param as ambient -- floor it so at least 2 tools must share a param
  // before it's treated as context rather than a real dependency.
  const ambientCutoff = Math.max(tools.length * AMBIENT_FREQUENCY_THRESHOLD, 2);

  const compoundIndex = buildIndex(tools);
  // For the bare-identifier fallback, a field's own name only needs to look
  // like an identifier (checked in bareIdentifierMatch) -- it's matched to a
  // consumer param via shared context tokens, not via an exact-name lookup,
  // so this is a flat list scanned per consumer param, not a name-keyed index.
  const identifierFields: ProducerField[] = [];
  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug) continue;
    for (const field of outputFields(tool)) {
      if (IDENTIFIER_SHAPE.test(field.fieldName.toLowerCase())) {
        identifierFields.push({ slug, ...field });
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const consumerSlug = slugOf(tool);
    if (!consumerSlug) continue;

    for (const inputName of requiredInputNames(tool)) {
      const key = inputName.toLowerCase();
      if ((requiredByCount.get(key) ?? 0) > ambientCutoff) continue;

      const producers = new Map<string, ProducerField>();
      for (const p of compoundIndex.get(key) ?? []) producers.set(p.slug, p);
      for (const p of identifierFields) {
        if (bareIdentifierMatch(p, inputName)) producers.set(p.slug, p);
      }

      for (const p of producers.values()) {
        if (p.slug === consumerSlug) continue;
        const edgeKey = `${p.slug}->${consumerSlug}->${inputName}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        edges.push({ from: p.slug, to: consumerSlug, label: inputName });
      }
    }
  }

  return { nodes, edges };
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
