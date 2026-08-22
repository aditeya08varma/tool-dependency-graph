/**
 * Pure matching logic -- no filesystem access, no Node built-ins. This is
 * what gets bundled for the browser app as well as used by the CLI, so it
 * has to run identically in both places.
 */
export type Tool = Record<string, any>;
export interface Node {
  id: string;
  service?: string;
}
export interface Edge {
  from: string;
  to: string;
  label: string;
}
export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

/**
 * "high" = the producer's enclosing type name is a single word (e.g. "Issue",
 * "Release") -- there's no ambiguity about what it represents.
 * "low" = the match only works because of ONE word inside a multi-word
 * compound type name (e.g. "PullRequest", "WorkflowRun") or a bare-field
 * context-overlap. Both mechanisms are used by real matches (PullRequest ->
 * pull_number) and by wrong ones (WorkflowRun -> workflow_id) in exactly the
 * same way -- no lexical rule can tell those apart, since it's a question of
 * domain convention, not grammar. "low" is a flag for further review (e.g.
 * an LLM judgment call), not a rejection.
 */
export type Confidence = "high" | "low";
export interface DetailedEdge extends Edge {
  confidence: Confidence;
  /** the producer's actual enclosing type name, e.g. "ReleaseAsset" -- lets a
   * reviewer (human or LLM) see that a field came from a nested sub-object,
   * not the tool's own top-level entity. */
  producerType: string;
}
export interface UnmatchedInput {
  tool: string;
  param: string;
}
export interface DetailedGraph {
  nodes: Node[];
  edges: DetailedEdge[];
  unmatched: UnmatchedInput[];
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

// A required param constrained to an enum (e.g. status: queued|in_progress|
// completed) is a closed set of caller choices, not a value fetched from
// another tool -- excluding these is what stops a coincidental context-word
// overlap (DeploymentStatus.id sharing "status" with an unrelated enum
// param) from producing a nonsensical edge, without needing to guess at the
// param's name shape (which would also reject legitimate non-"_id"-shaped
// params like Slack's "user").
function isEnumConstrained(tool: Tool, paramName: string): boolean {
  return Array.isArray(tool.inputParameters?.properties?.[paramName]?.enum);
}

interface FieldRef {
  /** tokens of the nearest enclosing $defs name, e.g. ["pull","request"] for "PullRequest" */
  contextTokens: string[];
  fieldName: string;
  /** the raw enclosing type name (e.g. "ReleaseAsset"), for surfacing to an
   * LLM reviewer so it can tell "this tool's own id" apart from "a field on
   * a nested sub-object" -- contextTokens alone can't distinguish those. */
  defName: string;
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
  defName: string,
  collected: FieldRef[],
  visited: Set<string>,
  depth: number,
): void {
  if (!node || depth > 5) return;

  if (node.$ref) {
    const refName = String(node.$ref).split("/").pop()!;
    if (visited.has(refName)) return;
    const resolved = defs[refName];
    if (!resolved) return;
    collectFields(resolved, defs, splitWords(refName), refName, collected, new Set(visited).add(refName), depth);
    return;
  }

  if (node.type === "array" && node.items) {
    collectFields(node.items, defs, contextTokens, defName, collected, visited, depth);
    return;
  }

  if (node.properties) {
    for (const [fieldName, fieldSchema] of Object.entries<any>(node.properties)) {
      collected.push({ contextTokens, fieldName, defName });
      collectFields(fieldSchema, defs, contextTokens, defName, collected, visited, depth + 1);
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
  collectFields(dataSchema, defs, [], "(root)", collected, new Set(), 0);
  return collected;
}

// A bare field name (no context prefix) is only trusted as a signal if it's
// shaped like a resource identifier, and even then only when its enclosing
// context is semantically related to the consumer param -- this is what
// stops a generic "id" field from matching every unrelated *_id param.
const IDENTIFIER_SHAPE = /(^|_)(id|number|sha|slug|ref|key|token)$/i;

// Any input required by more than this fraction of the catalog's tools is
// ambient context (the caller already has it), not a scarce lookup result.
// No toolkit vocabulary is named here -- it's a frequency signal. 5% was
// calibrated against a large (893-tool) catalog, where ambient params like
// owner/repo sit at ~49% -- but on a mid-sized catalog, 5% can be as few as
// 2-3 tools, which wrongly flags a real entity ID shared by a handful of
// related tools (e.g. gist_id across 4 gist endpoints) as ambient. 15% still
// leaves a wide margin below genuinely ambient params while no longer
// catching legitimately-scarce ones on smaller catalogs.
const AMBIENT_FREQUENCY_THRESHOLD = 0.15;

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

export function generateDetailed(tools: Tool[]): DetailedGraph {
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

  const edges: DetailedEdge[] = [];
  const unmatched: UnmatchedInput[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const consumerSlug = slugOf(tool);
    if (!consumerSlug) continue;

    for (const inputName of requiredInputNames(tool)) {
      const key = inputName.toLowerCase();
      if ((requiredByCount.get(key) ?? 0) > ambientCutoff) continue;
      if (isEnumConstrained(tool, inputName)) continue;

      // A single-word type name is unambiguous (the whole type IS the
      // concept). A multi-word compound only works because of one word among
      // several (e.g. "pull" in "PullRequest") -- that's the exact mechanism
      // behind both real matches (pull_number) and wrong ones (workflow_id
      // from "WorkflowRun"), so it can't be trusted without further review.
      const producers = new Map<string, { field: ProducerField; confidence: Confidence }>();
      for (const p of compoundIndex.get(key) ?? []) {
        const confidence: Confidence = p.contextTokens.length === 1 ? "high" : "low";
        const existing = producers.get(p.slug);
        if (!existing || (existing.confidence === "low" && confidence === "high")) {
          producers.set(p.slug, { field: p, confidence });
        }
      }
      for (const p of identifierFields) {
        if (bareIdentifierMatch(p, inputName) && !producers.has(p.slug)) {
          producers.set(p.slug, { field: p, confidence: "low" });
        }
      }

      if (producers.size === 0) {
        unmatched.push({ tool: consumerSlug, param: inputName });
        continue;
      }

      for (const { field: p, confidence } of producers.values()) {
        if (p.slug === consumerSlug) continue;
        const edgeKey = `${p.slug}->${consumerSlug}->${inputName}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        edges.push({ from: p.slug, to: consumerSlug, label: inputName, confidence, producerType: p.defName });
      }
    }
  }

  return { nodes, edges, unmatched };
}

export function generate(tools: Tool[]): Graph {
  const { nodes, edges } = generateDetailed(tools);
  return { nodes, edges: edges.map(({ from, to, label }) => ({ from, to, label })) };
}
