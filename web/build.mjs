/**
 * Bundles web/app.ts (which itself imports core.ts + vis-network) into a
 * single self-contained web/app.bundle.js -- no CDN, works fully offline --
 * and generates web/index.html with the two demo catalogs embedded inline
 * (not fetched, since fetch() to a local file fails under file://).
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";

const result = await build({
  entryPoints: ["web/app.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  logLevel: "info",
  write: false,
});
const appCode = result.outputFiles[0].text;
// Also write it standalone for anyone who wants to inspect the bundle directly.
writeFileSync("web/app.bundle.js", appCode, "utf-8");

const githubCatalog = readFileSync("catalogs/github.json", "utf-8");
const slackCatalog = readFileSync("catalogs/slack.json", "utf-8");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Tool Dependency Graph</title>
<style>
  :root {
    --bg: #14171C; --surface: #1B1F26; --surface-2: #232833;
    --ink: #E7E7E2; --ink-soft: #9BA1AC; --line: #2A2F38;
    --accent: #E0A752; --good: #7FB08F; --bad: #d9736a;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: grid; grid-template-columns: 380px 1fr; grid-template-rows: 100vh;
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
  #graph { position: relative; height: 100vh; overflow: hidden; }
  #network { position: absolute; inset: 0; }
  .placeholder {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--ink-soft); font-size: 0.9rem;
  }
</style>
</head>
<body>
  <aside>
    <h1>Tool Dependency Graph</h1>
    <p class="lede">Paste or upload a tool catalog (Composio-style: slug, inputParameters, outputParameters with $ref/$defs) and this infers a producer &rarr; consumer dependency graph &mdash; entirely in your browser, nothing uploaded anywhere, no CDN, works offline.</p>
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
</script>
<script>
${appCode.replace(/<\/script>/gi, "<\\/script>")}
</script>
</body>
</html>`;

writeFileSync("web/index.html", html, "utf-8");
console.log("wrote web/app.bundle.js and web/index.html");
