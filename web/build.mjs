/**
 * Bundles src/core.ts into web/core.bundle.js (browser-ready, exposes
 * window.DepGraph.generate), and generates web/index.html with the two demo
 * catalogs embedded inline -- not fetched, since fetch() to a local file
 * fails under file://, and this page needs to work opened directly from disk.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";

await build({
  entryPoints: ["src/core.ts"],
  bundle: true,
  format: "iife",
  globalName: "DepGraph",
  outfile: "web/core.bundle.js",
  target: "es2020",
});

const githubCatalog = readFileSync("catalogs/github.json", "utf-8");
const slackCatalog = readFileSync("catalogs/slack.json", "utf-8");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Tool Dependency Graph</title>
<script src="https://unpkg.com/vis-network@9/standalone/umd/vis-network.min.js"></script>
<script src="core.bundle.js"></script>
<style>
  :root {
    --bg: #14171C; --surface: #1B1F26; --surface-2: #232833;
    --ink: #E7E7E2; --ink-soft: #9BA1AC; --line: #2A2F38;
    --accent: #E0A752; --good: #7FB08F; --bad: #d9736a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: grid; grid-template-columns: 380px 1fr; height: 100vh;
  }
  aside {
    padding: 1.5rem; border-right: 1px solid var(--line); overflow-y: auto;
    display: flex; flex-direction: column; gap: 1rem;
  }
  h1 { font-size: 1.2rem; margin: 0; }
  p.lede { color: var(--ink-soft); font-size: 0.85rem; margin: 0; line-height: 1.5; }
  textarea {
    width: 100%; min-height: 220px; background: var(--surface-2); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 0.6rem;
    font-family: ui-monospace, monospace; font-size: 0.78rem; resize: vertical;
  }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  button {
    background: var(--surface-2); color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: 0.5rem 0.9rem; font-size: 0.85rem; cursor: pointer;
  }
  button.primary { background: var(--accent); color: #1B1F26; border: none; font-weight: 600; }
  button:hover { filter: brightness(1.1); }
  input[type="file"] { color: var(--ink-soft); font-size: 0.8rem; }
  #error { color: var(--bad); font-size: 0.82rem; white-space: pre-wrap; }
  #stats { font-size: 0.82rem; color: var(--ink-soft); }
  #stats b { color: var(--ink); }
  #graph { position: relative; }
  #network { width: 100%; height: 100%; }
  .placeholder {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--ink-soft); font-size: 0.9rem;
  }
</style>
</head>
<body>
  <aside>
    <h1>Tool Dependency Graph</h1>
    <p class="lede">Paste or upload a tool catalog (Composio-style: slug, inputParameters, outputParameters with $ref/$defs) and this infers a producer &rarr; consumer dependency graph &mdash; entirely in your browser, nothing uploaded anywhere.</p>
    <div class="row">
      <button id="loadGithub">Load GitHub example</button>
      <button id="loadSlack">Load Slack example</button>
    </div>
    <textarea id="input" placeholder="Paste catalog JSON here, or load an example above"></textarea>
    <input type="file" id="file" accept="application/json">
    <button class="primary" id="run">Generate graph</button>
    <div id="error"></div>
    <div id="stats"></div>
  </aside>
  <div id="graph">
    <div class="placeholder" id="placeholder">Load a catalog and click "Generate graph"</div>
    <div id="network"></div>
  </div>

<script>
  const EXAMPLE_GITHUB = ${githubCatalog};
  const EXAMPLE_SLACK = ${slackCatalog};

  const input = document.getElementById("input");
  const errorBox = document.getElementById("error");
  const statsBox = document.getElementById("stats");
  const placeholder = document.getElementById("placeholder");

  document.getElementById("loadGithub").onclick = () => { input.value = JSON.stringify(EXAMPLE_GITHUB, null, 2); };
  document.getElementById("loadSlack").onclick = () => { input.value = JSON.stringify(EXAMPLE_SLACK, null, 2); };

  document.getElementById("file").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { input.value = reader.result; };
    reader.readAsText(file);
  };

  let network = null;

  document.getElementById("run").onclick = () => {
    errorBox.textContent = "";
    let tools;
    try {
      const parsed = JSON.parse(input.value);
      tools = Array.isArray(parsed) ? parsed : (parsed.tools ?? parsed.items ?? []);
      if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error("Expected a JSON array of tools (or {tools: [...]} / {items: [...]})");
      }
    } catch (err) {
      errorBox.textContent = "Couldn't parse catalog: " + err.message;
      return;
    }

    let graph;
    try {
      graph = DepGraph.generate(tools);
    } catch (err) {
      errorBox.textContent = "Generator error: " + err.message;
      return;
    }

    const slugs = new Set(tools.map((t) => String(t.slug ?? t.name ?? "").toUpperCase()));
    const provenance = graph.nodes.length
      ? graph.nodes.filter((n) => slugs.has(n.id.toUpperCase())).length / graph.nodes.length
      : 0;

    statsBox.innerHTML =
      "<b>" + graph.nodes.length + "</b> nodes &nbsp; <b>" + graph.edges.length + "</b> edges &nbsp; " +
      "<b>" + (graph.nodes.length ? (graph.edges.length / graph.nodes.length).toFixed(2) : "0") + "</b> edges/node &nbsp; " +
      "<b>" + provenance.toFixed(2) + "</b> provenance";

    placeholder.style.display = "none";
    const nodes = new vis.DataSet(graph.nodes.map((n) => ({
      id: n.id, label: n.id.replace(/_/g, " "), group: n.service || "other"
    })));
    const edges = new vis.DataSet(graph.edges.map((e, i) => ({
      id: i, from: e.from, to: e.to, label: e.label, arrows: "to",
      font: { size: 10, color: "#9BA1AC" }
    })));

    if (network) network.destroy();
    network = new vis.Network(document.getElementById("network"), { nodes, edges }, {
      layout: { improvedLayout: false },
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -120, springLength: 150 },
        stabilization: { iterations: 200 },
      },
      edges: { smooth: false, color: { color: "#4a5568", opacity: 0.6 } },
      nodes: { shape: "dot", size: 10, font: { color: "#e7e7e2", size: 12 },
               borderWidth: 1, color: { border: "#2a2f38" } },
    });
    // Creating vis.Network inside a click handler (rather than at page load)
    // computes node positions but doesn't paint an initial frame -- calling
    // redraw()/fit() synchronously here does nothing, because the container
    // hasn't had a browser paint cycle yet. Deferring to the next tick (after
    // the browser lays out the now-visible container) is what actually works.
    setTimeout(() => { network.redraw(); network.fit(); }, 0);
  };
</script>
</body>
</html>`;

writeFileSync("web/index.html", html, "utf-8");
console.log("wrote web/core.bundle.js and web/index.html");
