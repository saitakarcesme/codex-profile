import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { configUsesFileAuth, ensureFileAuthConfig } from "../src/codex-adapter.js";
import { tempEnvironment } from "./helpers.js";

test("file auth configuration preserves workspace MCP configuration", (t) => {
  const fixture = tempEnvironment();
  t.after(() => fixture.cleanup());
  const file = path.join(fixture.codexHome, "config.toml");
  const mcp = "[mcp_servers.shared]\nurl = \"https://mcp.example.test\"\n";
  fs.writeFileSync(file, `model = \"test\"\n${mcp}`);
  const result = ensureFileAuthConfig(fixture.codexHome);
  assert.equal(result.changed, true);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /cli_auth_credentials_store = "file"/);
  assert.match(after, /\[mcp_servers\.shared\]/);
  assert.equal(configUsesFileAuth(fixture.codexHome), true);
  assert.equal(ensureFileAuthConfig(fixture.codexHome).changed, false);
});
