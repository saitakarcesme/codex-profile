import { spawn } from "node:child_process";
import { codexInvocation } from "./codex-adapter.js";

export function readActiveAccountAndUsage(codexHome, env = process.env, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const invocation = codexInvocation(env);
    const child = spawn(invocation.command, [...invocation.prefix, "-c", "cli_auth_credentials_store=\"file\"", "app-server", "--stdio"], {
      env: { ...env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    const responses = new Map();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("timed out reading Codex account usage")), timeoutMs);

    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id != null) responses.set(Number(message.id), message);
        if (responses.has(2) && responses.has(3)) {
          const account = responses.get(2);
          const usage = responses.get(3);
          if (account.error) return finish(new Error(account.error.message || "Codex account/read failed"));
          if (usage.error) return finish(new Error(usage.error.message || "Codex rate-limit query failed"));
          return finish(null, { account: account.result, usage: usage.result });
        }
      }
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before replying (${code})`));
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-profile", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "account/read", params: { refreshToken: false } });
    send({ id: 3, method: "account/rateLimits/read", params: null });
  });
}

export function readAvailableModels(codexHome, env = process.env, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const invocation = codexInvocation(env);
    const child = spawn(invocation.command, [...invocation.prefix, "-c", "cli_auth_credentials_store=\"file\"", "app-server", "--stdio"], {
      env: { ...env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("timed out reading the Codex model catalog")), timeoutMs);

    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (Number(message.id) !== 2) continue;
        if (message.error) return finish(new Error(message.error.message || "Codex model/list failed"));
        const models = Array.isArray(message.result?.data) ? message.result.data : [];
        return finish(null, models.map((model) => ({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          hidden: Boolean(model.hidden),
          isDefault: Boolean(model.isDefault),
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: (model.supportedReasoningEfforts || []).map((option) => option.reasoningEffort),
        })));
      }
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before replying (${code})`));
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-profile", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "model/list", params: { includeHidden: false, limit: 100 } });
  });
}
