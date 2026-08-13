import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { captureSharedState, compareSharedState } from "../src/shared-state.js";
import { tempEnvironment, writeJson } from "./helpers.js";

test("shared-state verification ignores auth and permits new local sessions", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), "[mcp_servers.example]\ncommand = 'safe'\n");
  fs.mkdirSync(path.join(fixture.codexHome, "skills", "example"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexHome, "skills", "example", "SKILL.md"), "shared skill\n");
  fs.mkdirSync(path.join(fixture.codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexHome, "sessions", "before.jsonl"), "{}\n");
  fs.writeFileSync(path.join(fixture.codexHome, ".credentials.json"), "mcp credential container\n");
  writeJson(path.join(fixture.codexHome, ".codex-global-state.json"), {
    "local-projects": { test: { rootPaths: [fixture.root] } },
    "active-workspace-roots": [fixture.root],
  });
  const before = captureSharedState(fixture.codexHome, fixture.root);
  fs.writeFileSync(path.join(fixture.codexHome, "auth.json"), "credential changed but not inspected\n");
  fs.writeFileSync(path.join(fixture.codexHome, ".credentials.json"), "mcp token rotated independently\n");
  fs.writeFileSync(path.join(fixture.codexHome, "sessions", "after.jsonl"), "{}\n");
  const after = captureSharedState(fixture.codexHome, fixture.root);
  assert.equal(compareSharedState(before, after).ok, true);
  assert.equal(JSON.stringify(before).includes("credential changed"), false);
});

test("shared-state verification detects deletion of an MCP credential container", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const credentialFile = path.join(fixture.codexHome, ".credentials.json");
  fs.writeFileSync(credentialFile, "container\n");
  const before = captureSharedState(fixture.codexHome, fixture.root);
  fs.unlinkSync(credentialFile);
  const result = compareSharedState(before, captureSharedState(fixture.codexHome, fixture.root));
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["MCP credential containers"]);
});

test("shared-state verification detects shared config changes and deleted sessions", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), "model = 'one'\n");
  fs.mkdirSync(path.join(fixture.codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(fixture.codexHome, "sessions", "keep.jsonl"), "{}\n");
  const before = captureSharedState(fixture.codexHome, fixture.root);
  fs.writeFileSync(path.join(fixture.codexHome, "config.toml"), "model = 'two'\n");
  fs.unlinkSync(path.join(fixture.codexHome, "sessions", "keep.jsonl"));
  const result = compareSharedState(before, captureSharedState(fixture.codexHome, fixture.root));
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed.sort(), ["config and MCP definitions", "local sessions"]);
});

test("shared-state verification permits plugin cache additions but detects removals", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const original = path.join(fixture.codexHome, "plugins", "cache", "source", "plugin", "1.0.0");
  fs.mkdirSync(original, { recursive: true });
  const before = captureSharedState(fixture.codexHome, fixture.root);
  fs.mkdirSync(path.join(fixture.codexHome, "plugins", "cache", "source", "new-plugin", "2.0.0"), { recursive: true });
  assert.equal(compareSharedState(before, captureSharedState(fixture.codexHome, fixture.root)).ok, true);
  fs.rmSync(original, { recursive: true });
  const result = compareSharedState(before, captureSharedState(fixture.codexHome, fixture.root));
  assert.equal(result.ok, false);
  assert.equal(result.missingPluginCount, 1);
});

test("shared-state verification permits bundled system-skill refresh but protects user skills", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const systemSkill = path.join(fixture.codexHome, "skills", ".system", "bundled", "SKILL.md");
  const userSkill = path.join(fixture.codexHome, "skills", "mine", "SKILL.md");
  fs.mkdirSync(path.dirname(systemSkill), { recursive: true });
  fs.mkdirSync(path.dirname(userSkill), { recursive: true });
  fs.writeFileSync(systemSkill, "system v1\n");
  fs.writeFileSync(userSkill, "mine\n");
  const before = captureSharedState(fixture.codexHome, fixture.root);
  fs.writeFileSync(systemSkill, "system v2\n");
  assert.equal(compareSharedState(before, captureSharedState(fixture.codexHome, fixture.root)).ok, true);
  fs.writeFileSync(userSkill, "changed\n");
  const result = compareSharedState(before, captureSharedState(fixture.codexHome, fixture.root));
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ["skills"]);
});
