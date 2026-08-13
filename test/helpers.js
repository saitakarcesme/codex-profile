import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.test-signature`;
}

export function fakeAuth(account, email, refresh = `refresh-${account}`) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: `user-${account}`,
    email,
    name: `User ${account}`,
    exp: now + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: account,
      chatgpt_plan_type: account === "account-1" ? "plus" : "pro",
    },
  };
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt(claims),
      access_token: jwt(claims),
      refresh_token: refresh,
      account_id: account,
    },
    last_refresh: new Date().toISOString(),
  };
}

export function tempEnvironment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-test-"));
  const codexHome = path.join(root, "codex-home");
  const profileHome = path.join(root, "profile-home");
  fs.mkdirSync(codexHome, { recursive: true });
  return {
    root,
    codexHome,
    profileHome,
    env: {
      ...process.env,
      CODEX_PROFILE_HOME: profileHome,
      CODEX_PROFILE_CODEX_HOME: codexHome,
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
