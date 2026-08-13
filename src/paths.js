import os from "node:os";
import path from "node:path";

export function resolveCodexHome(env = process.env) {
  if (env.CODEX_PROFILE_CODEX_HOME) return path.resolve(env.CODEX_PROFILE_CODEX_HOME);
  if (env.CODEX_HOME) return path.resolve(env.CODEX_HOME);
  return path.join(os.homedir(), ".codex");
}

export function resolveProfileHome(env = process.env, platform = process.platform) {
  if (env.CODEX_PROFILE_HOME) return path.resolve(env.CODEX_PROFILE_HOME);
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexProfile");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodexProfile");
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "codex-profile");
}

export function storePaths(env = process.env) {
  const root = resolveProfileHome(env);
  return {
    root,
    state: path.join(root, "state.json"),
    lock: path.join(root, "operation.lock"),
    journal: path.join(root, "switch-journal.json"),
    desktopAudit: path.join(root, "last-desktop-switch.json"),
    desktopAuditHistory: path.join(root, "desktop-switch-history.jsonl"),
    relaunchPending: path.join(root, "relaunch-pending.json"),
    profiles: path.join(root, "profiles"),
    staging: path.join(root, "staging"),
  };
}
