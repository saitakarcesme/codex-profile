import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAuth, tempEnvironment, writeJson } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "codex-profile.js");
const fakeCodex = path.join(projectRoot, "test", "fixtures", "fake-codex.js");

function invoke(args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, cwd: projectRoot });
}

test("install-to-switch flow retains two logins and one workspace", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const env = {
    ...fixture.env,
    CODEX_PROFILE_CODEX_BIN: process.execPath,
    CODEX_PROFILE_CODEX_PREFIX: JSON.stringify([fakeCodex]),
    FAKE_CODEX_ACCOUNT: "account-2",
    FAKE_CODEX_EMAIL: "second@example.test",
  };
  const authPath = path.join(fixture.codexHome, "auth.json");
  const configPath = path.join(fixture.codexHome, "config.toml");
  const sharedPath = path.join(fixture.codexHome, "sessions", "same-project.jsonl");
  writeJson(authPath, fakeAuth("account-1", "first@example.test"));
  fs.writeFileSync(configPath, "[mcp_servers.shared]\nurl = \"https://mcp.example.test\"\n");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.writeFileSync(sharedPath, "same workspace\n");

  let result = invoke(["init", "--label", "First"], env);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["add", "Second"], env);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(["list", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  let listed = JSON.parse(result.stdout);
  assert.equal(listed.profiles.length, 2);
  assert.equal(listed.profiles.find((profile) => profile.label === "First").active, true);

  result = invoke(["use", "Second", "--force"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "account-2");
  assert.match(fs.readFileSync(configPath, "utf8"), /\[mcp_servers\.shared\]/);
  assert.equal(fs.readFileSync(sharedPath, "utf8"), "same workspace\n");

  // A manual login can change the real auth slot without updating the registry.
  // Listing must still mark the identity in the slot as active.
  writeJson(authPath, fakeAuth("account-1", "first@example.test"));
  result = invoke(["list", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  listed = JSON.parse(result.stdout);
  assert.equal(listed.profiles.find((profile) => profile.label === "First").active, true);
  assert.equal(listed.profiles.find((profile) => profile.label === "Second").active, false);
  result = invoke(["use", "Second", "--force"], env);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(["list", "--usage", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  listed = JSON.parse(result.stdout);
  assert.equal(listed.activeUsage.account.account.email, "second@example.test");
  assert.equal(listed.activeUsage.usage.rateLimits.primary.usedPercent, 25);

  result = invoke(["run", "--", "--version"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fake-0\.1\.0/);

  result = invoke(["doctor", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.codexVersion, "codex-cli fake-0.1.0");
  assert.equal(report.credentialState, "ok");
});
