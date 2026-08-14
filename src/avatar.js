import { readAuthFile } from "./auth.js";
import { execFileSync } from "node:child_process";
import net from "node:net";

const PROFILE_ENDPOINT = "https://chatgpt.com/backend-api/me";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function safeHttpsUrl(value) {
  if (value instanceof URL) value = value.toString();
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    const unwrappedHostname = hostname.replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || net.isIP(unwrappedHostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function installedDesktopVersion(platform, env = process.env) {
  if (env.CODEX_PROFILE_CHATGPT_VERSION) return env.CODEX_PROFILE_CHATGPT_VERSION;
  try {
    if (platform === "darwin") {
      return execFileSync("/usr/bin/plutil", [
        "-extract", "CFBundleShortVersionString", "raw",
        "/Applications/ChatGPT.app/Contents/Info.plist",
      ], { encoding: "utf8", timeout: 3000 }).trim();
    }
    if (platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()",
      ], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    }
  } catch { /* use the compatibility fallback below */ }
  return "26.810.41047";
}

function desktopUserAgent(platform = process.platform, env = process.env) {
  const system = platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `ChatGPTBrowser/${installedDesktopVersion(platform, env)} Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.137 Safari/537.36`;
}

function matchesImageSignature(bytes, mime) {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

async function downloadAvatar(initialUrl, fetchImpl, accountHeaders) {
  let url = initialUrl;
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const parsed = safeHttpsUrl(url);
    if (!parsed) return null;
    const trusted = parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com");
    response = await fetchImpl(parsed, {
      headers: {
        ...(trusted ? accountHeaders : {}),
        accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
        "user-agent": accountHeaders["user-agent"],
      },
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) return null;
    url = new URL(location, parsed).toString();
  }
  if (!response?.ok || !safeHttpsUrl(response.url || url)) return null;
  const mime = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  const extension = MIME_EXTENSIONS.get(mime);
  if (!extension) return null;
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_AVATAR_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES || !matchesImageSignature(bytes, mime)) return null;
  return { bytes, extension };
}

export async function fetchAccountAvatar(authFile, { fetchImpl = globalThis.fetch, platform = process.platform, env = process.env } = {}) {
  try {
    const { auth } = readAuthFile(authFile);
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (typeof accessToken !== "string" || typeof accountId !== "string") return null;
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/",
      "user-agent": desktopUserAgent(platform, env),
    };
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetchImpl(PROFILE_ENDPOINT, { headers });
      if (response.status !== 403) break;
      await response.body?.cancel();
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) return null;
    const profile = await response.json();
    const picture = safeHttpsUrl(profile?.picture);
    return picture ? await downloadAvatar(picture, fetchImpl, headers) : null;
  } catch {
    return null;
  }
}

export const _test = { MAX_AVATAR_BYTES, PROFILE_ENDPOINT, desktopUserAgent, safeHttpsUrl };
