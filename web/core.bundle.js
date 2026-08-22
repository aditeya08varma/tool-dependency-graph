var DepGraph = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/core.ts
  var core_exports = {};
  __export(core_exports, {
    generate: () => generate,
    requiredInputNames: () => requiredInputNames,
    slugOf: () => slugOf
  });
  function slugOf(tool) {
    return tool.slug ?? tool.name ?? tool.function?.name;
  }
  var KNOWN_HINT_TAGS = /* @__PURE__ */ new Set([
    "openWorldHint",
    "updateHint",
    "createHint",
    "idempotentHint",
    "destructiveHint",
    "mcpIgnore",
    "important",
    "readOnlyHint"
  ]);
  function serviceOf(tool) {
    const tags = tool.tags ?? [];
    const tag = tags.find((t) => !KNOWN_HINT_TAGS.has(t) && !/Hint$/.test(t));
    return tag ? tag.toLowerCase() : void 0;
  }
  function requiredInputNames(tool) {
    const req = tool.inputParameters?.required ?? [];
    return req.map(String);
  }
  function splitWords(name) {
    const words = name.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [name];
    return words.map((w) => w.toLowerCase());
  }
  function collectFields(node, defs, contextTokens, collected, visited, depth) {
    if (!node || depth > 5) return;
    if (node.$ref) {
      const defName = String(node.$ref).split("/").pop();
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
      for (const [fieldName, fieldSchema] of Object.entries(node.properties)) {
        collected.push({ contextTokens, fieldName });
        collectFields(fieldSchema, defs, contextTokens, collected, visited, depth + 1);
      }
    }
  }
  function outputFields(tool) {
    const op = tool.outputParameters;
    if (!op) return [];
    const defs = op.$defs ?? {};
    const dataSchema = op.properties?.data;
    if (!dataSchema) return [];
    const collected = [];
    collectFields(dataSchema, defs, [], collected, /* @__PURE__ */ new Set(), 0);
    return collected;
  }
  var IDENTIFIER_SHAPE = /(^|_)(id|number|sha|slug|ref|key|token)$/i;
  var AMBIENT_FREQUENCY_THRESHOLD = 0.05;
  function compoundCandidates(field) {
    const f = field.fieldName.toLowerCase();
    return field.contextTokens.map((t) => `${t}_${f}`);
  }
  function bareIdentifierMatch(field, consumerParam) {
    const f = field.fieldName.toLowerCase();
    if (!IDENTIFIER_SHAPE.test(f)) return false;
    const consumerWords = new Set(consumerParam.toLowerCase().split("_"));
    return field.contextTokens.some((t) => consumerWords.has(t));
  }
  function buildIndex(tools) {
    const index = /* @__PURE__ */ new Map();
    for (const tool of tools) {
      const slug = slugOf(tool);
      if (!slug) continue;
      for (const field of outputFields(tool)) {
        for (const key of compoundCandidates(field)) {
          if (!index.has(key)) index.set(key, []);
          index.get(key).push({ slug, ...field });
        }
      }
    }
    return index;
  }
  function generate(tools) {
    const nodes = tools.map((t) => ({ id: slugOf(t), service: serviceOf(t) })).filter((n) => !!n.id);
    const requiredByCount = /* @__PURE__ */ new Map();
    for (const tool of tools) {
      for (const name of requiredInputNames(tool)) {
        const key = name.toLowerCase();
        requiredByCount.set(key, (requiredByCount.get(key) ?? 0) + 1);
      }
    }
    const ambientCutoff = Math.max(tools.length * AMBIENT_FREQUENCY_THRESHOLD, 2);
    const compoundIndex = buildIndex(tools);
    const identifierFields = [];
    for (const tool of tools) {
      const slug = slugOf(tool);
      if (!slug) continue;
      for (const field of outputFields(tool)) {
        if (IDENTIFIER_SHAPE.test(field.fieldName.toLowerCase())) {
          identifierFields.push({ slug, ...field });
        }
      }
    }
    const edges = [];
    const seen = /* @__PURE__ */ new Set();
    for (const tool of tools) {
      const consumerSlug = slugOf(tool);
      if (!consumerSlug) continue;
      for (const inputName of requiredInputNames(tool)) {
        const key = inputName.toLowerCase();
        if ((requiredByCount.get(key) ?? 0) > ambientCutoff) continue;
        const producers = /* @__PURE__ */ new Map();
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
  return __toCommonJS(core_exports);
})();
