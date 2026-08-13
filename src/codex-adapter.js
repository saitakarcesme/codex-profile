import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { atomicWrite, ensurePrivateDir } from "./fs-safe.js";

const FILE_AUTH_SETTING = "cli_auth_credentials_store = \"file\"";

export function codexBinary(env = process.env) {
  const configured = env.CODEX_PROFILE_CODEX_BIN;
  if (configured) return configured;
  if (process.platform !== "win32") return "codex";

  const located = spawnSync("where.exe", ["codex"], { encoding: "utf8", env });
  if (located.status === 0) {
    const candidates = located.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const shim = candidates.find((item) => item.toLowerCase().endsWith(".cmd"));
    if (shim) {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const native = path.join(
        path.dirname(shim),
        "node_modules", "@openai", "codex", "node_modules", "@openai",
        `codex-win32-${arch}`, "vendor",
        arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
        "bin", "codex.exe",
      );
      if (fs.existsSync(native)) return native;
      const javascript = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(javascript)) return javascript;
    }
    const executable = candidates.find((item) => item.toLowerCase().endsWith(".exe"));
    if (executable) return executable;
  }
  return "codex.exe";
}

export function codexInvocation(env = process.env) {
  let prefix = [];
  if (env.CODEX_PROFILE_CODEX_PREFIX) {
    try {
      prefix = JSON.parse(env.CODEX_PROFILE_CODEX_PREFIX);
    } catch {
      throw new Error("CODEX_PROFILE_CODEX_PREFIX must be a JSON array");
    }
    if (!Array.isArray(prefix) || prefix.some((item) => typeof item !== "string")) {
      throw new Error("CODEX_PROFILE_CODEX_PREFIX must be a JSON array of strings");
    }
  }
  const command = codexBinary(env);
  if (process.platform === "win32" && command.toLowerCase().endsWith(".js")) {
    return { command: process.execPath, prefix: [command, ...prefix] };
  }
  return { command, prefix };
}

export function codexVersion(env = process.env) {
  const invocation = codexInvocation(env);
  const result = spawnSync(invocation.command, [...invocation.prefix, "--version"], { encoding: "utf8", env, shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function ensureFileAuthConfig(codexHome) {
  ensurePrivateDir(codexHome);
  const file = path.join(codexHome, "config.toml");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const setting = /^\s*cli_auth_credentials_store\s*=\s*([^#\r\n]+).*$/m;
  let after;
  if (setting.test(before)) {
    after = before.replace(setting, FILE_AUTH_SETTING);
  } else {
    const marker = "# Codex Profile v0.1: account credentials are isolated as protected files.\n";
    const table = before.search(/^\s*\[/m);
    if (table === -1) {
      after = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${marker}${FILE_AUTH_SETTING}\n`;
    } else {
      after = `${before.slice(0, table)}${marker}${FILE_AUTH_SETTING}\n\n${before.slice(table)}`;
    }
  }
  if (after !== before) atomicWrite(file, after, 0o600);
  return { file, changed: after !== before };
}

export function configUsesFileAuth(codexHome) {
  const file = path.join(codexHome, "config.toml");
  if (!fs.existsSync(file)) return false;
  return /^\s*cli_auth_credentials_store\s*=\s*["']file["']\s*(?:#.*)?$/m.test(fs.readFileSync(file, "utf8"));
}

const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export function loginInto(stagingDir, { deviceCode = false, env = process.env, timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS } = {}) {
  ensurePrivateDir(stagingDir);
  atomicWrite(path.join(stagingDir, "config.toml"), `${FILE_AUTH_SETTING}\n`, 0o600);
  const args = ["-c", "cli_auth_credentials_store=\"file\"", "login"];
  if (deviceCode) args.push("--device-auth");
  return new Promise((resolve, reject) => {
    const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LOGIN_TIMEOUT_MS;
    const invocation = codexInvocation(env);
    const child = spawn(invocation.command, [...invocation.prefix, ...args], {
      env: { ...env, CODEX_HOME: stagingDir },
      stdio: "inherit",
      shell: false,
    });
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code, signal) => {
      if (code === 0) finish(resolve, path.join(stagingDir, "auth.json"));
      else finish(reject, new Error(`Codex login did not complete successfully (${signal || `exit ${code}`})`));
    });
    timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Codex login timed out after ${Math.ceil(effectiveTimeout / 60_000)} minute(s); the active Desktop account was not changed`));
    }, effectiveTimeout);
  });
}

export function runCodex(args, codexHome, env = process.env) {
  return new Promise((resolve, reject) => {
    const invocation = codexInvocation(env);
    const child = spawn(invocation.command, [...invocation.prefix, "-c", "cli_auth_credentials_store=\"file\"", ...args], {
      env: { ...env, CODEX_HOME: codexHome },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`Codex exited after signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}
