import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProfileStore } from "../src/store.js";
import { fakeAuth, tempEnvironment, writeJson } from "./helpers.js";

test("two profiles switch atomically while workspace and MCP state remain shared", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const authPath = path.join(fixture.codexHome, "auth.json");
  const configPath = path.join(fixture.codexHome, "config.toml");
  const sessionPath = path.join(fixture.codexHome, "sessions", "shared.jsonl");
  const mcpPath = path.join(fixture.codexHome, ".credentials.json");
  writeJson(authPath, fakeAuth("account-1", "first@example.test"));
  fs.writeFileSync(configPath, "[mcp_servers.shared]\nurl = \"https://mcp.example.test\"\n");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "shared-session\n");
  fs.writeFileSync(mcpPath, "shared-mcp-credential-container\n");

  const store = new ProfileStore(fixture.env);
  const initialized = store.initialize("First");
  const secondSource = path.join(fixture.root, "second-auth.json");
  writeJson(secondSource, fakeAuth("account-2", "second@example.test"));
  const second = store.addFromAuth(secondSource, "Second");

  writeJson(authPath, fakeAuth("account-1", "first@example.test", "rotated-first"));
  const before = {
    config: fs.readFileSync(configPath, "utf8"),
    session: fs.readFileSync(sessionPath, "utf8"),
    mcp: fs.readFileSync(mcpPath, "utf8"),
  };
  store.activate(second.id);
  assert.equal(store.inspectShared().email, "second@example.test");
  store.activate(initialized.imported.id);
  assert.equal(store.inspectShared().email, "first@example.test");
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.refresh_token, "rotated-first");
  assert.deepEqual({
    config: fs.readFileSync(configPath, "utf8"),
    session: fs.readFileSync(sessionPath, "utf8"),
    mcp: fs.readFileSync(mcpPath, "utf8"),
  }, before);
});

test("credential drift cannot overwrite an unknown account", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  const source = path.join(fixture.root, "second.json");
  writeJson(source, fakeAuth("account-2", "second@example.test"));
  store.addFromAuth(source, "Second");
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("unknown", "unknown@example.test"));
  assert.throws(() => store.activate("Second"), /unregistered account/);
  assert.equal(store.inspectShared().email, "unknown@example.test");
});

test("duplicate account and active-profile removal are rejected", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const authPath = path.join(fixture.codexHome, "auth.json");
  writeJson(authPath, fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  assert.throws(() => store.addFromAuth(authPath, "Duplicate"), /already stored/);
  assert.throws(() => store.remove("First"), /active profile/);
});

test("a stale lock from a dead process is recovered", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const authPath = path.join(fixture.codexHome, "auth.json");
  writeJson(authPath, fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  writeJson(store.paths.lock, { pid: 99999999, startedAt: new Date(Date.now() - 300_000).toISOString() });
  const source = path.join(fixture.root, "second.json");
  writeJson(source, fakeAuth("account-2", "second@example.test"));
  assert.equal(store.addFromAuth(source, "Second").label, "Second");
  assert.equal(fs.existsSync(store.paths.lock), false);
});

test("renaming changes only profile metadata", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  const initialized = store.initialize("First");
  const authBefore = fs.readFileSync(store.authPath(initialized.imported.id), "utf8");
  const result = store.rename("First", "Personal");
  assert.equal(result.profile.label, "Personal");
  assert.equal(store.resolve("Personal").email, "first@example.test");
  assert.equal(fs.readFileSync(store.authPath(initialized.imported.id), "utf8"), authBefore);
});

test("Codex username is explicit metadata and is never inferred from email", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "mail-local@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("Personal");
  assert.equal(store.load().profiles[0].username, undefined);
  const profile = store.setUsername("Personal", "@real-codex-user");
  assert.equal(profile.username, "real-codex-user");
  assert.equal(store.load().profiles[0].email, "mail-local@example.test");
});

test("credential repair only accepts the same account identity", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test", "old-refresh"));
  const store = new ProfileStore(fixture.env);
  const initialized = store.initialize("First");
  const same = path.join(fixture.root, "same.json");
  writeJson(same, fakeAuth("account-1", "first@example.test", "new-refresh"));
  store.replaceProfileAuth("First", same);
  assert.notEqual(store.inspectProfile(initialized.imported).credentialHash, store.inspectShared().credentialHash);
  const wrong = path.join(fixture.root, "wrong.json");
  writeJson(wrong, fakeAuth("account-2", "second@example.test"));
  assert.throws(() => store.replaceProfileAuth("First", wrong), /does not match/);
  assert.equal(store.inspectProfile(initialized.imported).email, "first@example.test");
});

test("auth health metadata is credential-free and persists server revocation state", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  writeJson(path.join(fixture.codexHome, "auth.json"), fakeAuth("account-1", "first@example.test"));
  const store = new ProfileStore(fixture.env);
  store.initialize("First");
  store.updateAuthHealth("First", "reauth-pending");
  assert.equal(store.load().profiles[0].authHealth, "reauth-pending");
  store.updateAuthHealth("First", "reauth-required");
  const stateText = fs.readFileSync(store.paths.state, "utf8");
  const profile = store.load().profiles[0];
  assert.equal(profile.authHealth, "reauth-required");
  assert.equal(typeof profile.lastAuthCheckedAt, "string");
  assert.equal(stateText.includes("refresh-account-1"), false);
});
