import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fakeAuth } from "../helpers.js";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli fake-0.1.0\n");
  process.exit(0);
}

if (args.includes("login")) {
  if (process.env.FAKE_CODEX_LOGIN_HANG === "1") {
    setInterval(() => {}, 60_000);
  } else {
    const account = process.env.FAKE_CODEX_ACCOUNT || "account-2";
    const email = process.env.FAKE_CODEX_EMAIL || "second@example.test";
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), `${JSON.stringify(fakeAuth(account, email), null, 2)}\n`);
    process.exit(0);
  }
}

if (args.includes("app-server")) {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 1) process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "fake" } })}\n`);
    if (message.method === "account/read") process.stdout.write(`${JSON.stringify({ id: message.id, result: { account: { type: "chatgpt", email: "second@example.test", planType: "pro" }, requiresOpenaiAuth: true } })}\n`);
    if (message.method === "account/rateLimits/read") process.stdout.write(`${JSON.stringify({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25, resetsAt: 2000000000, windowDurationMins: 300 } }, rateLimitsByLimitId: null, rateLimitResetCredits: null } })}\n`);
    if (message.method === "model/list") process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [
      { id: "model-1", model: "gpt-test", displayName: "GPT Test", description: "fixture", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fixture" }] },
    ], nextCursor: null } })}\n`);
  });
} else {
  process.stdout.write(`fake Codex invoked: ${args.join(" ")}\n`);
}
