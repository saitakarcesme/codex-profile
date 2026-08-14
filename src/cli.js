import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProfileStore } from "./store.js";
import {
  codexVersion,
  configUsesFileAuth,
  ensureFileAuthConfig,
  loginInto,
  runCodex,
} from "./codex-adapter.js";
import { assertSafeToSwitch, activeCodexProcesses } from "./process-guard.js";
import { readActiveAccountAndUsage } from "./app-server.js";
import {
  desktopProcessState,
  installWindowsShortcuts,
  launchDesktopMenu,
  resolveDesktopWorkspace,
  switchDesktopProfile,
} from "./desktop.js";

const VERSION = "0.1.0";

function hasFlag(args, flag) {
  return args.includes(flag);
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function removeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

export function parseDesktopUseArguments(args) {
  const workspace = takeOption(args, "--workspace");
  const repairLoginRequested = removeFlag(args, "--repair-login");
  removeFlag(args, "--no-login-repair"); // Deprecated no-op: browser repair is opt-in.
  if (args.length !== 1) throw new Error("desktop use requires exactly one profile selector");
  return { workspace, repairLoginRequested, selector: args[0] };
}

function help() {
  return `Codex Profile ${VERSION} — multiple accounts, one workspace

Usage:
  codex-profile init [--label LABEL]
  codex-profile list [--usage] [--json]
  codex-profile add [LABEL] [--device-code]
  codex-profile reauth PROFILE [--device-code]
  codex-profile use PROFILE [--force]
  codex-profile rename PROFILE LABEL
  codex-profile username PROFILE USERNAME
  codex-profile remove PROFILE [--force]
  codex-profile run [--profile PROFILE] [--] [CODEX_ARGS...]
  codex-profile handoff SESSION [--profile PROFILE] [--force] [-- CODEX_ARGS...]
  codex-profile desktop use PROFILE [--workspace PATH] [--repair-login]
  codex-profile desktop menu
  codex-profile desktop shortcuts
  codex-profile desktop audit [--json]
  codex-profile doctor [--json]

Switching changes only the protected Codex auth slot. The existing CODEX_HOME,
repository, sessions, config, skills, plugins, MCP setup, and MCP credentials stay shared.
Close Codex Desktop and active Codex CLI processes before \`use\` or \`handoff\`.
\`desktop use\` performs the safe close, switch, and official relaunch as one action.
`;
}

function profileRows(store, state) {
  const drift = store.activeDrift(state);
  const actual = drift.shared
    ? state.profiles.find((profile) => profile.fingerprint === drift.shared.fingerprint) || null
    : null;
  const effectiveActiveId = actual?.id || state.activeProfileId;
  return state.profiles.map((profile) => {
    let identity;
    let status = "invalid";
    try {
      identity = store.inspectProfile(profile);
      status = identity.status;
    } catch { /* status remains invalid without revealing credential details */ }
    if (profile.authHealth === "reauth-pending") status = "reauth-pending";
    else if (profile.authHealth === "reauth-required") status = "reauth-required";
    else if (profile.authHealth === "temporarily-unavailable") status = "unavailable";
    if (profile.id === effectiveActiveId && drift.status !== "ok" && !actual) status = "drift";
    return {
      active: profile.id === effectiveActiveId,
      label: profile.label,
      username: profile.username || null,
      name: identity?.name || null,
      email: profile.email,
      plan: profile.planType,
      auth: profile.authMode,
      status,
      avatar: store.avatarPath(profile.id),
      id: profile.id,
    };
  });
}

function printProfiles(rows) {
  if (!rows.length) {
    process.stdout.write("No profiles stored. Run `codex-profile add`.\n");
    return;
  }
  const headers = ["", "LABEL", "EMAIL", "PLAN", "AUTH", "STATUS", "ID"];
  const data = rows.map((row) => [
    row.active ? "*" : " ",
    row.label,
    row.email || "—",
    row.plan || "—",
    row.auth,
    row.status,
    row.id.slice(0, 8),
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...data.map((row) => String(row[index]).length)));
  const line = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
  process.stdout.write(`${line(headers)}\n${data.map(line).join("\n")}\n`);
}

function formatWindow(name, window) {
  if (!window) return null;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : "unknown reset";
  return `${name}: ${window.usedPercent}% used, resets ${reset}`;
}

async function commandInit(args, store) {
  const label = takeOption(args, "--label");
  if (args.length) throw new Error(`unexpected init argument: ${args[0]}`);
  const config = ensureFileAuthConfig(store.codexHome);
  const result = store.initialize(label);
  if (result.alreadyInitialized) {
    process.stdout.write(`Codex Profile is already initialized at ${store.paths.root}\n`);
  } else if (result.imported) {
    process.stdout.write(`Detected and stored existing account as "${result.imported.label}".\n`);
  } else {
    process.stdout.write("Initialized without an existing file-based account. Add an account next.\n");
  }
  if (config.changed) process.stdout.write(`Configured file-backed auth in ${config.file}; restart Codex Desktop before switching.\n`);
}

async function commandAdd(args, store) {
  const deviceCode = removeFlag(args, "--device-code");
  if (!store.exists()) {
    ensureFileAuthConfig(store.codexHome);
    store.initialize(null);
  }
  if (args.length > 1) throw new Error("add accepts at most one profile label");
  const label = args[0] || null;
  const staging = path.join(store.paths.staging, crypto.randomUUID());
  process.stdout.write("Starting an isolated Codex login. The currently active account will not be touched.\n");
  try {
    const authFile = await loginInto(staging, { deviceCode, env: store.env });
    const profile = store.addFromAuth(authFile, label);
    process.stdout.write(`Stored profile "${profile.label}" (${profile.email || profile.authMode}).\n`);
    process.stdout.write(`Activate it after closing Codex with: codex-profile use ${profile.id.slice(0, 8)}\n`);
  } finally {
    if (path.dirname(staging) === store.paths.staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function repairProfileLogin(store, selector, { deviceCode = false } = {}) {
  const profile = store.resolve(selector);
  const staging = path.join(store.paths.staging, `reauth-${crypto.randomUUID()}`);
  store.updateAuthHealth(profile.id, "reauth-pending");
  try {
    const authFile = await loginInto(staging, { deviceCode, env: store.env });
    return store.replaceProfileAuth(profile.id, authFile);
  } catch (error) {
    store.updateAuthHealth(profile.id, "reauth-required");
    throw error;
  } finally {
    if (path.dirname(staging) === store.paths.staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function commandReauth(args, store) {
  const deviceCode = removeFlag(args, "--device-code");
  if (args.length !== 1) throw new Error("reauth requires exactly one profile selector");
  const profile = store.resolve(args[0]);
  process.stdout.write(`Starting the supported Codex sign-in to repair profile "${profile.label}". Existing credentials remain stored until the account identity is verified.\n`);
  const result = await repairProfileLogin(store, profile.id, { deviceCode });
  process.stdout.write(`Refreshed authentication for "${result.profile.label}" (${result.profile.email || result.profile.authMode}).\n`);
}

async function commandList(args, store) {
  const json = removeFlag(args, "--json");
  const usageRequested = removeFlag(args, "--usage");
  if (args.length) throw new Error(`unexpected list argument: ${args[0]}`);
  const state = store.load();
  const rows = profileRows(store, state);
  let usage = null;
  let usageError = null;
  if (usageRequested && state.activeProfileId) {
    try { usage = await readActiveAccountAndUsage(store.codexHome, store.env); }
    catch (error) { usageError = error.message; }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ profiles: rows, activeUsage: usage, usageError }, null, 2)}\n`);
    return;
  }
  printProfiles(rows);
  if (usageRequested) {
    if (usageError) process.stdout.write(`\nActive usage unavailable: ${usageError}\n`);
    else if (usage) {
      const account = usage.account?.account;
      const limits = usage.usage?.rateLimits;
      const details = [formatWindow("primary", limits?.primary), formatWindow("secondary", limits?.secondary)].filter(Boolean);
      process.stdout.write(`\nActive account: ${account?.email || account?.type || "unknown"}${account?.planType ? ` (${account.planType})` : ""}\n`);
      process.stdout.write(details.length ? `${details.join("\n")}\n` : "No rate-limit window was returned.\n");
    }
  }
}

async function commandUse(args, store) {
  const force = removeFlag(args, "--force");
  if (args.length !== 1) throw new Error("use requires exactly one profile selector");
  assertSafeToSwitch({ force });
  const result = store.activate(args[0]);
  process.stdout.write(result.changed
    ? `Active Codex profile is now "${result.target.label}".\n`
    : `"${result.target.label}" is already active; its rotated credentials were retained.\n`);
  if (result.repairedFrom) process.stdout.write(`Repaired stale active-profile metadata previously pointing to "${result.repairedFrom}".\n`);
  process.stdout.write("Start Codex normally; the workspace and local sessions are unchanged.\n");
}

async function commandRemove(args, store) {
  const force = removeFlag(args, "--force");
  if (args.length !== 1) throw new Error("remove requires exactly one profile selector");
  const state = store.load();
  const profile = store.resolve(args[0], state);
  if (profile.id === state.activeProfileId) assertSafeToSwitch({ force });
  const removed = store.remove(args[0], { allowActive: force });
  process.stdout.write(`Removed profile "${removed.label}" and its stored credential snapshot. This cannot be undone.\n`);
}

async function commandRename(args, store) {
  if (args.length !== 2) throw new Error("rename requires a profile selector and new label");
  const result = store.rename(args[0], args[1]);
  process.stdout.write(`Renamed profile "${result.previousLabel}" to "${result.profile.label}".\n`);
}

async function commandUsername(args, store) {
  if (args.length !== 2) throw new Error("username requires a profile selector and the account's Codex username");
  const profile = store.setUsername(args[0], args[1]);
  process.stdout.write(`Stored Codex username "@${profile.username}" for profile "${profile.label}".\n`);
}

async function activateIfRequested(args, store, force) {
  const selector = takeOption(args, "--profile");
  if (!selector) return null;
  const state = store.load();
  const target = store.resolve(selector, state);
  if (target.id !== state.activeProfileId) {
    assertSafeToSwitch({ force });
    return store.activate(target.id);
  }
  return { target, changed: false };
}

async function commandRun(args, store) {
  const force = removeFlag(args, "--force");
  await activateIfRequested(args, store, force);
  if (args[0] === "--") args.shift();
  const state = store.load();
  if (!state.activeProfileId) throw new Error("no active profile; add and activate an account first");
  const code = await runCodex(args, store.codexHome, store.env);
  if (code !== 0) process.exitCode = code;
}

async function commandHandoff(args, store) {
  const force = removeFlag(args, "--force");
  const separator = args.indexOf("--");
  const trailing = separator === -1 ? [] : args.splice(separator + 1);
  if (separator !== -1) args.splice(separator, 1);
  await activateIfRequested(args, store, force);
  if (args.length !== 1) throw new Error("handoff requires a local session id or name");
  const session = args[0];
  const code = await runCodex(["fork", session, ...trailing], store.codexHome, store.env);
  if (code !== 0) process.exitCode = code;
}

async function commandDesktop(args, store) {
  const action = args.shift();
  if (!action || action === "help" || action === "--help" || action === "-h") {
    process.stdout.write(`Desktop commands:\n  codex-profile desktop use PROFILE [--workspace PATH] [--repair-login]\n  codex-profile desktop menu\n  codex-profile desktop shortcuts\n  codex-profile desktop status [--json]\n  codex-profile desktop audit [--json]\n`);
    return;
  }
  if (action === "use") {
    const { workspace, repairLoginRequested, selector } = parseDesktopUseArguments(args);
    const result = await switchDesktopProfile({
      store,
      selector,
      requestedWorkspace: workspace,
      repairLogin: repairLoginRequested ? (profileStore, selector) => repairProfileLogin(profileStore, selector) : null,
    });
    // Keep the selector independent from the Desktop process tree and recover it
    // automatically if the previous instance exited during the close/relaunch cycle.
    if (process.platform === "win32" && store.env.CODEX_PROFILE_DESKTOP_SHELL !== "tauri") {
      launchDesktopMenu({ env: store.env, cliPath: process.argv[1], cwd: process.cwd(), startHidden: true });
    }
    process.stdout.write(`Switched to "${result.switched.target.label}" and relaunched Codex Desktop in ${result.workspace}.\n`);
    if (result.closed.forced) process.stdout.write("Codex Desktop did not close gracefully and its process tree had to be terminated.\n");
    if (result.usage) process.stdout.write(`Verified active identity: ${result.usage.email || result.usage.accountType}${result.usage.planType ? ` (${result.usage.planType})` : ""}.\n`);
    else process.stdout.write(`Active usage verification unavailable: ${result.usageError}\n`);
    process.stdout.write(`Shared workspace integrity: ${result.integrity.ok ? "verified" : `changed (${result.integrity.changed.join(", ")})`}.\n`);
    return;
  }
  if (action === "menu") {
    if (args.length) throw new Error(`unexpected desktop menu argument: ${args[0]}`);
    const launched = launchDesktopMenu({ env: store.env, cliPath: process.argv[1], cwd: process.cwd() });
    process.stdout.write(`Opened Codex Profile companion launcher (${launched.processId}); it remains available in the notification area until Exit is chosen.\n`);
    const code = await launched.completion;
    if (code !== 0) throw new Error(`companion launcher exited with code ${code}`);
    return;
  }
  if (action === "shortcuts") {
    if (args.length) throw new Error(`unexpected desktop shortcuts argument: ${args[0]}`);
    const state = store.load();
    if (!state.profiles.length) throw new Error("no profiles are available for shortcuts");
    const created = installWindowsShortcuts(state.profiles, { env: store.env, cliPath: process.argv[1], cwd: resolveDesktopWorkspace(store.codexHome) });
    process.stdout.write(`Created ${created.length} Codex Profile Desktop shortcut${created.length === 1 ? "" : "s"}:\n${created.join("\n")}\n`);
    return;
  }
  if (action === "status") {
    const json = removeFlag(args, "--json");
    if (args.length) throw new Error(`unexpected desktop status argument: ${args[0]}`);
    const processes = desktopProcessState(store.env);
    const workspace = resolveDesktopWorkspace(store.codexHome);
    const output = { running: processes.desktop.length > 0, processCount: processes.desktop.length, otherCodexProcessCount: processes.otherCodex.length, workspace };
    process.stdout.write(json ? `${JSON.stringify(output, null, 2)}\n` : `Codex Desktop: ${output.running ? "running" : "stopped"}\nWorkspace: ${workspace}\nOther Codex processes: ${output.otherCodexProcessCount}\n`);
    return;
  }
  if (action === "audit") {
    const json = removeFlag(args, "--json");
    if (args.length) throw new Error(`unexpected desktop audit argument: ${args[0]}`);
    if (!fs.existsSync(store.paths.desktopAudit)) throw new Error("no completed Desktop switch audit is available yet");
    const audit = JSON.parse(fs.readFileSync(store.paths.desktopAudit, "utf8"));
    if (json) process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    else {
      process.stdout.write(`Last Desktop switch: ${audit.from?.label || "none"} -> ${audit.to.label}\n`);
      process.stdout.write(`Identity: ${audit.identity?.email || `unavailable (${audit.usageError})`}\n`);
      process.stdout.write(`Shared workspace integrity: ${audit.sharedState.ok ? "verified" : `changed (${audit.sharedState.changed.join(", ")})`}\n`);
      process.stdout.write(`Workspace: ${audit.workspace}\n`);
    }
    return;
  }
  throw new Error(`unknown desktop command: ${action}`);
}

async function commandDoctor(args, store) {
  const json = removeFlag(args, "--json");
  if (args.length) throw new Error(`unexpected doctor argument: ${args[0]}`);
  const report = {
    version: VERSION,
    codexVersion: codexVersion(store.env),
    sharedCodexHome: store.codexHome,
    profileHome: store.paths.root,
    initialized: store.exists(),
    fileAuthConfigured: configUsesFileAuth(store.codexHome),
    switchJournalPresent: fs.existsSync(store.paths.journal),
    relaunchPending: fs.existsSync(store.paths.relaunchPending),
    desktopAuditHistoryPresent: fs.existsSync(store.paths.desktopAuditHistory),
    operationLockPresent: fs.existsSync(store.paths.lock),
    codexProcesses: activeCodexProcesses(),
    profileCount: 0,
    activeProfile: null,
    credentialState: "uninitialized",
  };
  if (report.initialized) {
    const state = store.load();
    const drift = store.activeDrift(state);
    report.profileCount = state.profiles.length;
    report.activeProfile = drift.active ? { id: drift.active.id, label: drift.active.label, email: drift.active.email } : null;
    report.credentialState = drift.status;
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const [key, value] of Object.entries(report)) {
      const rendered = Array.isArray(value) ? `${value.length} running` : value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "unavailable");
      process.stdout.write(`${key}: ${rendered}\n`);
    }
  }
  const healthy = report.initialized && report.fileAuthConfigured && report.credentialState !== "mismatch" && !report.switchJournalPresent;
  if (!healthy) process.exitCode = 1;
}

export async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(help());
    return;
  }
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const store = new ProfileStore(process.env);
  const commands = {
    init: commandInit,
    add: commandAdd,
    reauth: commandReauth,
    list: commandList,
    profiles: commandList,
    use: commandUse,
    switch: commandUse,
    remove: commandRemove,
    rename: commandRename,
    username: commandUsername,
    run: commandRun,
    handoff: commandHandoff,
    desktop: commandDesktop,
    doctor: commandDoctor,
    status: commandList,
  };
  const handler = commands[command];
  if (!handler) throw new Error(`unknown command: ${command}\n\n${help()}`);
  await handler(args, store);
}
