import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileDigest(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile()
    ? sha256(fs.readFileSync(file))
    : null;
}

function walkFiles(root, relative = "") {
  if (!fs.existsSync(root)) return [];
  const directory = path.join(root, relative);
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(root, next));
    else if (entry.isFile()) output.push(next.split(path.sep).join("/"));
  }
  return output;
}

function directoryFingerprint(root) {
  const files = walkFiles(root);
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, ...relative.split("/"))));
    hash.update("\0");
  }
  return { files: files.length, digest: hash.digest("hex") };
}

function pluginInventory(root) {
  const cache = path.join(root, "cache");
  if (!fs.existsSync(cache)) return { entries: [] };
  const entries = [];
  for (const source of fs.readdirSync(cache, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const sourcePath = path.join(cache, source.name);
    for (const plugin of fs.readdirSync(sourcePath, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const pluginPath = path.join(sourcePath, plugin.name);
      const versions = fs.readdirSync(pluginPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const version of versions) entries.push(`${source.name}/${plugin.name}/${version}`);
    }
  }
  return { entries: entries.sort() };
}

function skillInventory(root) {
  if (!fs.existsSync(root)) return { user: { files: 0, digest: sha256("") }, systemSkills: [] };
  const userFiles = walkFiles(root).filter((relative) => !relative.startsWith(".system/"));
  const hash = crypto.createHash("sha256");
  for (const relative of userFiles) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, ...relative.split("/"))));
    hash.update("\0");
  }
  const systemRoot = path.join(root, ".system");
  const systemSkills = fs.existsSync(systemRoot)
    ? fs.readdirSync(systemRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(systemRoot, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort()
    : [];
  return { user: { files: userFiles.length, digest: hash.digest("hex") }, systemSkills };
}

function desktopProjects(codexHome) {
  const file = path.join(codexHome, ".codex-global-state.json");
  if (!fs.existsSync(file)) return { projects: [], activeRoots: [] };
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const projects = Object.values(state["local-projects"] || {})
      .flatMap((project) => project?.rootPaths || [])
      .filter((root) => typeof root === "string")
      .map((root) => path.resolve(root))
      .sort();
    const activeRoots = (state["active-workspace-roots"] || [])
      .filter((root) => typeof root === "string")
      .map((root) => path.resolve(root))
      .sort();
    return { projects, activeRoots };
  } catch {
    return { projects: [], activeRoots: [], unreadable: true };
  }
}

function mcpCredentialInventory(codexHome) {
  return [".credentials.json", "secrets/mcp_oauth.age"]
    .filter((relative) => fs.existsSync(path.join(codexHome, ...relative.split("/"))))
    .sort();
}

function gitState(workspace) {
  const run = (args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  const top = run(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { repository: false, workspace: path.resolve(workspace) };
  const root = top.stdout.trim();
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    repository: true,
    workspace: path.resolve(root),
    head: head.status === 0 ? head.stdout.trim() : null,
    statusDigest: status.status === 0 ? sha256(status.stdout.replace(/\r\n/g, "\n")) : null,
  };
}

export function captureSharedState(codexHome, workspace) {
  const sessions = ["sessions", "archived_sessions"]
    .flatMap((directory) => walkFiles(path.join(codexHome, directory)).map((file) => `${directory}/${file}`))
    .sort();
  return {
    version: 1,
    codexHome: path.resolve(codexHome),
    workspace: gitState(workspace),
    configDigest: fileDigest(path.join(codexHome, "config.toml")),
    sharedDirectories: {
      skills: skillInventory(path.join(codexHome, "skills")),
      plugins: pluginInventory(path.join(codexHome, "plugins")),
      rules: directoryFingerprint(path.join(codexHome, "rules")),
    },
    desktopProjects: desktopProjects(codexHome),
    mcpCredentialFiles: mcpCredentialInventory(codexHome),
    sessions,
  };
}

export function compareSharedState(before, after) {
  const unchanged = [];
  const changed = [];
  const compare = (name, left, right) => {
    if (JSON.stringify(left) === JSON.stringify(right)) unchanged.push(name);
    else changed.push(name);
  };
  compare("CODEX_HOME", before.codexHome, after.codexHome);
  compare("config and MCP definitions", before.configDigest, after.configDigest);
  const afterSystemSkills = new Set(after.sharedDirectories.skills.systemSkills);
  const missingSystemSkills = before.sharedDirectories.skills.systemSkills.filter((entry) => !afterSystemSkills.has(entry));
  if (JSON.stringify(before.sharedDirectories.skills.user) !== JSON.stringify(after.sharedDirectories.skills.user) || missingSystemSkills.length) changed.push("skills");
  else unchanged.push("skills");
  const afterPlugins = new Set(after.sharedDirectories.plugins.entries);
  const missingPlugins = before.sharedDirectories.plugins.entries.filter((entry) => !afterPlugins.has(entry));
  if (missingPlugins.length) changed.push("plugins");
  else unchanged.push("plugins");
  compare("rules", before.sharedDirectories.rules, after.sharedDirectories.rules);
  compare("Desktop project roots", before.desktopProjects, after.desktopProjects);
  const afterMcpFiles = new Set(after.mcpCredentialFiles);
  const missingMcpFiles = before.mcpCredentialFiles.filter((entry) => !afterMcpFiles.has(entry));
  if (missingMcpFiles.length) changed.push("MCP credential containers");
  else unchanged.push("MCP credential containers");
  compare("repository", before.workspace, after.workspace);
  const afterSessions = new Set(after.sessions);
  const missingSessions = before.sessions.filter((session) => !afterSessions.has(session));
  if (missingSessions.length) changed.push("local sessions");
  else unchanged.push("local sessions");
  return { ok: changed.length === 0, unchanged, changed, missingSessionCount: missingSessions.length, missingPluginCount: missingPlugins.length, missingSystemSkillCount: missingSystemSkills.length, missingMcpCredentialFileCount: missingMcpFiles.length };
}

export const _test = { directoryFingerprint, pluginInventory, skillInventory, walkFiles };
