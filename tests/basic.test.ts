/**
 * Minimal regression tests, run with `npm test` (node's built-in test runner).
 * Not a full suite -- just locks in the behaviors this project's design
 * decisions actually depend on, so a future change can't silently break them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function runGenerator(catalogPath: string, outPath: string) {
  execFileSync("node", ["--import", "tsx", "src/generate.ts", catalogPath, "--out", outPath], {
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(outPath, "utf-8"));
}

test("finds the README's own issue_number example", () => {
  const graph = runGenerator("catalogs/github.json", "tests/.tmp.github.json");
  const hit = graph.edges.find(
    (e: any) => e.to === "GITHUB_CREATE_AN_ISSUE_COMMENT" && e.label === "issue_number"
  );
  assert.ok(hit, "expected an issue_number edge into GITHUB_CREATE_AN_ISSUE_COMMENT");
});

test("finds the README's own pull_number example, despite the camelCase mismatch", () => {
  const graph = runGenerator("catalogs/github.json", "tests/.tmp.github.json");
  const hit = graph.edges.find(
    (e: any) => e.to === "GITHUB_MERGE_A_PULL_REQUEST" && e.label === "pull_number"
  );
  assert.ok(hit, "expected a pull_number edge into GITHUB_MERGE_A_PULL_REQUEST (PullRequest.number -> pull_number)");
});

test("does not treat ambient scope params (owner/repo) as dependencies", () => {
  const graph = runGenerator("catalogs/github.json", "tests/.tmp.github.json");
  const ambientEdges = graph.edges.filter((e: any) => e.label === "owner" || e.label === "repo");
  assert.equal(ambientEdges.length, 0, "owner/repo are required by nearly every tool and should be filtered as context, not dependencies");
});

test("generalizes to a non-GitHub catalog with different naming conventions", () => {
  const graph = runGenerator("catalogs/slack.json", "tests/.tmp.slack.json");
  const hit = graph.edges.find(
    (e: any) => e.to === "SLACK_GET_USER_INFO" && e.label === "user"
  );
  assert.ok(hit, "expected a user edge into SLACK_GET_USER_INFO from a tool that produces a User.id");
  // Slack's own ambient param ("channel") should be filtered the same way GitHub's is,
  // via the same frequency signal -- no toolkit-specific vocabulary involved.
  const channelEdges = graph.edges.filter((e: any) => e.label === "channel");
  assert.equal(channelEdges.length, 0, "channel is required by nearly every Slack tool and should be filtered as context");
});

test("node ids are always real catalog slugs (provenance)", () => {
  const catalog = JSON.parse(readFileSync("catalogs/github.json", "utf-8"));
  const slugs = new Set(catalog.map((t: any) => t.slug));
  const graph = runGenerator("catalogs/github.json", "tests/.tmp.github.json");
  for (const node of graph.nodes) {
    assert.ok(slugs.has(node.id), `node id ${node.id} is not a real slug from the catalog`);
  }
});

test("is deterministic across repeated runs", () => {
  const a = runGenerator("catalogs/github.json", "tests/.tmp.github.a.json");
  const b = runGenerator("catalogs/github.json", "tests/.tmp.github.b.json");
  assert.deepEqual(a, b);
});
