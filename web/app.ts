/**
 * The whole app: parse a pasted/uploaded catalog, run the same generate()
 * logic the CLI uses, render with vis-network. Bundled with esbuild into a
 * single self-contained script -- vis-network is bundled in too, not loaded
 * from a CDN, so this has zero network dependency and works fully offline.
 */
import { Network, DataSet } from "vis-network/standalone/esm/vis-network.js";
import { generate, type Tool } from "../src/core.ts";

const input = document.getElementById("input") as HTMLTextAreaElement;
const errorBox = document.getElementById("error")!;
const statsBox = document.getElementById("stats")!;
const placeholder = document.getElementById("placeholder")!;
const fileInput = document.getElementById("file") as HTMLInputElement;

declare const EXAMPLE_GITHUB: Tool[];
declare const EXAMPLE_SLACK: Tool[];

document.getElementById("loadGithub")!.addEventListener("click", () => {
  input.value = JSON.stringify(EXAMPLE_GITHUB, null, 2);
});
document.getElementById("loadSlack")!.addEventListener("click", () => {
  input.value = JSON.stringify(EXAMPLE_SLACK, null, 2);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { input.value = String(reader.result); };
  reader.onerror = () => { errorBox.textContent = "Couldn't read file: " + reader.error; };
  reader.readAsText(file);
});

let network: InstanceType<typeof Network> | null = null;

document.getElementById("run")!.addEventListener("click", () => {
  errorBox.textContent = "";

  let tools: Tool[];
  try {
    const parsed = JSON.parse(input.value);
    tools = Array.isArray(parsed) ? parsed : (parsed.tools ?? parsed.items ?? []);
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error("Expected a JSON array of tools (or {tools: [...]} / {items: [...]})");
    }
  } catch (err: any) {
    errorBox.textContent = "Couldn't parse catalog: " + err.message;
    return;
  }

  try {
    const graph = generate(tools);

    const slugs = new Set(tools.map((t) => String(t.slug ?? t.name ?? "").toUpperCase()));
    const provenance = graph.nodes.length
      ? graph.nodes.filter((n) => slugs.has(n.id.toUpperCase())).length / graph.nodes.length
      : 0;

    statsBox.innerHTML =
      `<b>${graph.nodes.length}</b> nodes &nbsp; <b>${graph.edges.length}</b> edges &nbsp; ` +
      `<b>${graph.nodes.length ? (graph.edges.length / graph.nodes.length).toFixed(2) : "0"}</b> edges/node &nbsp; ` +
      `<b>${provenance.toFixed(2)}</b> provenance`;

    if (graph.nodes.length === 0) {
      errorBox.textContent = "Generated 0 nodes -- check that each tool has a slug/name.";
      return;
    }

    placeholder.style.display = "none";

    const nodes = new DataSet(graph.nodes.map((n) => ({
      id: n.id, label: n.id.replace(/_/g, " "), group: n.service || "other",
    })));
    const edges = new DataSet(graph.edges.map((e, i) => ({
      id: i, from: e.from, to: e.to, label: e.label, arrows: "to",
      font: { size: 10, color: "#9BA1AC" },
    })));

    if (network) network.destroy();
    network = new Network(document.getElementById("network")!, { nodes, edges } as any, {
      layout: { improvedLayout: false },
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -120, springLength: 150 },
        stabilization: { iterations: 200 },
      },
      edges: { smooth: false, color: { color: "#4a5568", opacity: 0.6 } },
      nodes: { shape: "dot", size: 10, font: { color: "#e7e7e2", size: 12 },
               borderWidth: 1, color: { border: "#2a2f38" } },
    } as any);

    // Force an initial paint -- creating the network inside a click handler
    // (rather than at page load) can leave the canvas blank until something
    // else triggers a redraw, so don't rely solely on vis-network's own
    // internal scheduling.
    requestAnimationFrame(() => {
      network!.redraw();
      network!.fit();
    });
    network.once("stabilizationIterationsDone", () => network!.fit());
  } catch (err: any) {
    console.error(err);
    errorBox.textContent = "Something went wrong rendering the graph: " + (err?.message ?? String(err));
  }
});
