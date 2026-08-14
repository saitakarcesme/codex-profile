import crypto from "node:crypto";
import fs from "node:fs";

const AUTH_CLAIM = "https://api.openai.com/auth";

export function readAuthFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`no Codex credential file found at ${file}`);
    throw error;
  }
  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error(`Codex credential file is not valid JSON: ${file}`);
  }
  return { auth, raw };
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function inspectAuth(auth) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("credential payload must be a JSON object");
  }

  const authMode = typeof auth.auth_mode === "string"
    ? auth.auth_mode
    : auth.OPENAI_API_KEY
      ? "api-key"
      : auth.tokens
        ? "chatgpt"
        : "unknown";
  const idClaims = decodeJwtPayload(auth.tokens?.id_token);
  const accessClaims = decodeJwtPayload(auth.tokens?.access_token);
  const claims = idClaims || accessClaims || {};
  const openai = claims[AUTH_CLAIM] && typeof claims[AUTH_CLAIM] === "object"
    ? claims[AUTH_CLAIM]
    : {};
  const accountId = auth.tokens?.account_id || openai.chatgpt_account_id || null;
  const email = typeof claims.email === "string" ? claims.email : null;
  const name = typeof claims.name === "string" ? claims.name : null;
  const planType = typeof openai.chatgpt_plan_type === "string" ? openai.chatgpt_plan_type : null;
  const subject = typeof claims.sub === "string" ? claims.sub : null;
  const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : null;
  const identitySeed = accountId || subject || email || (apiKey ? `api-key:${apiKey}` : null);

  if (!identitySeed) {
    throw new Error("credential payload has no recognizable Codex account identity");
  }
  if (authMode === "chatgpt" && !auth.tokens?.refresh_token && !auth.tokens?.access_token) {
    throw new Error("ChatGPT credential payload contains no usable access or refresh token");
  }

  const exp = Number(accessClaims?.exp || idClaims?.exp || 0) || null;
  const expired = exp ? exp * 1000 <= Date.now() : false;
  return {
    authMode,
    email,
    name,
    planType,
    fingerprint: hash(`${authMode}\0${identitySeed}`),
    credentialHash: hash(JSON.stringify(auth)),
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    status: expired && auth.tokens?.refresh_token ? "refresh-needed" : expired ? "expired" : "ready",
  };
}

export function defaultLabel(identity) {
  if (identity.name) return identity.name;
  if (identity.email) return identity.email.split("@")[0];
  return identity.authMode === "api-key" ? "API key" : "Codex account";
}

export function sanitizeLabel(label) {
  const value = String(label || "").trim().replace(/\s+/g, " ");
  if (!value) throw new Error("profile label cannot be empty");
  if (value.length > 80) throw new Error("profile label must be 80 characters or fewer");
  if (/\p{C}/u.test(value)) throw new Error("profile label contains control characters");
  return value;
}

export function sanitizeUsername(username) {
  const value = String(username || "").trim().replace(/^@+/, "");
  if (!value) throw new Error("Codex username cannot be empty");
  if (value.length > 64) throw new Error("Codex username must be 64 characters or fewer");
  if (!/^[\p{L}\p{N}._-]+$/u.test(value)) {
    throw new Error("Codex username may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return value;
}
