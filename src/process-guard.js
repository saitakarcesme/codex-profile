import { spawnSync } from "node:child_process";

export function activeCodexProcesses(platform = process.platform) {
  if (platform === "win32") {
    const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    if (result.status !== 0) return [];
    return result.stdout.split(/\r?\n/).map((line) => {
      const match = line.match(/^"([^"]+)","(\d+)"/);
      return match ? { name: match[1], pid: Number(match[2]) } : null;
    }).filter((item) => item && /^(?:codex|chatgpt)(?:-|\.)/i.test(item.name));
  }
  const result = spawnSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    return match && /(?:^|\/)(?:codex|Codex)(?:\s|$|\.)/i.test(`${match[2]} ${match[3]}`)
      ? { name: match[2], pid: Number(match[1]) }
      : null;
  }).filter(Boolean).filter((item) => item.pid !== process.pid);
}

export function assertSafeToSwitch({ force = false } = {}) {
  const processes = activeCodexProcesses();
  if (processes.length && !force) {
    const summary = processes.slice(0, 5).map((item) => `${item.name} (${item.pid})`).join(", ");
    throw new Error(`Codex is running: ${summary}. Close Codex Desktop/CLI, then retry; use --force only if you know those processes do not use the shared Codex home.`);
  }
  return processes;
}
