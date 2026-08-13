import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectAuth, defaultLabel, readAuthFile, sanitizeLabel } from "./auth.js";
import { atomicCopy, atomicWrite, ensurePrivateDir, protectPrivateTree, withOperationLock } from "./fs-safe.js";
import { resolveCodexHome, storePaths } from "./paths.js";

const STATE_VERSION = 1;
const ADAPTER_ID = "codex-auth-json-v1";

export class ProfileStore {
  constructor(env = process.env) {
    this.env = env;
    this.paths = storePaths(env);
    this.codexHome = resolveCodexHome(env);
    if (fs.existsSync(this.paths.root)) protectPrivateTree(this.paths.root);
  }

  authPath(profileId) {
    return path.join(this.paths.profiles, profileId, "auth.json");
  }

  avatarPath(profileId) {
    const directory = path.join(this.paths.profiles, profileId);
    for (const name of ["avatar.jpg", "avatar.png", "avatar.jpeg", "avatar.webp"]) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  sharedAuthPath() {
    return path.join(this.codexHome, "auth.json");
  }

  exists() {
    return fs.existsSync(this.paths.state);
  }

  load() {
    if (!this.exists()) throw new Error("Codex Profile is not initialized; run `codex-profile init`");
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.paths.state, "utf8"));
    } catch {
      throw new Error(`profile registry is unreadable or corrupt: ${this.paths.state}`);
    }
    if (state.version !== STATE_VERSION || !Array.isArray(state.profiles)) {
      throw new Error(`unsupported profile registry version in ${this.paths.state}`);
    }
    if (path.resolve(state.sharedCodexHome) !== path.resolve(this.codexHome)) {
      throw new Error(`registry belongs to a different shared Codex home: ${state.sharedCodexHome}`);
    }
    return state;
  }

  save(state) {
    state.updatedAt = new Date().toISOString();
    atomicWrite(this.paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  initialize(label) {
    return withOperationLock(this.paths, () => {
      if (this.exists()) return { state: this.load(), imported: null, alreadyInitialized: true };
      ensurePrivateDir(this.paths.profiles);
      ensurePrivateDir(this.paths.staging);
      const now = new Date().toISOString();
      const state = {
        version: STATE_VERSION,
        adapter: ADAPTER_ID,
        sharedCodexHome: this.codexHome,
        activeProfileId: null,
        createdAt: now,
        updatedAt: now,
        profiles: [],
      };
      let imported = null;
      if (fs.existsSync(this.sharedAuthPath())) {
        const { auth } = readAuthFile(this.sharedAuthPath());
        const identity = inspectAuth(auth);
        imported = this.#createProfile(state, this.sharedAuthPath(), label || defaultLabel(identity), identity);
        state.activeProfileId = imported.id;
      }
      this.save(state);
      return { state, imported, alreadyInitialized: false };
    });
  }

  addFromAuth(authFile, label) {
    return withOperationLock(this.paths, () => {
      const state = this.load();
      const { auth } = readAuthFile(authFile);
      const identity = inspectAuth(auth);
      const duplicate = state.profiles.find((profile) => profile.fingerprint === identity.fingerprint);
      if (duplicate) {
        throw new Error(`that account is already stored as profile "${duplicate.label}"`);
      }
      const profile = this.#createProfile(state, authFile, label || defaultLabel(identity), identity);
      this.save(state);
      return profile;
    });
  }

  #createProfile(state, sourceAuth, label, identity) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const profile = {
      id,
      label: sanitizeLabel(label),
      email: identity.email,
      authMode: identity.authMode,
      planType: identity.planType,
      fingerprint: identity.fingerprint,
      createdAt: now,
      lastUsedAt: null,
    };
    ensurePrivateDir(path.dirname(this.authPath(id)));
    atomicCopy(sourceAuth, this.authPath(id));
    state.profiles.push(profile);
    return profile;
  }

  resolve(selector, state = this.load()) {
    if (!selector) throw new Error("a profile label, email, or id is required");
    const needle = String(selector).toLowerCase();
    const exact = state.profiles.filter((profile) =>
      profile.id.toLowerCase() === needle
      || profile.label.toLowerCase() === needle
      || profile.email?.toLowerCase() === needle);
    if (exact.length === 1) return exact[0];
    const prefix = state.profiles.filter((profile) => profile.id.toLowerCase().startsWith(needle));
    if (prefix.length === 1 && needle.length >= 8) return prefix[0];
    if (exact.length + prefix.length > 1) throw new Error(`profile selector is ambiguous: ${selector}`);
    throw new Error(`profile not found: ${selector}`);
  }

  inspectProfile(profile) {
    const { auth } = readAuthFile(this.authPath(profile.id));
    const identity = inspectAuth(auth);
    if (identity.fingerprint !== profile.fingerprint) {
      throw new Error(`stored credentials do not match profile metadata for "${profile.label}"`);
    }
    return identity;
  }

  inspectShared() {
    if (!fs.existsSync(this.sharedAuthPath())) return null;
    return inspectAuth(readAuthFile(this.sharedAuthPath()).auth);
  }

  activeDrift(state = this.load()) {
    const active = state.profiles.find((profile) => profile.id === state.activeProfileId) || null;
    const shared = this.inspectShared();
    if (!active && !shared) return { active, shared, status: "empty" };
    if (!active || !shared) return { active, shared, status: "mismatch" };
    return { active, shared, status: active.fingerprint === shared.fingerprint ? "ok" : "mismatch" };
  }

  activate(selector) {
    return withOperationLock(this.paths, () => {
      const state = this.load();
      const target = this.resolve(selector, state);
      const targetIdentity = this.inspectProfile(target);
      let current = state.profiles.find((profile) => profile.id === state.activeProfileId) || null;
      const shared = this.inspectShared();
      let repairedFrom = null;

      if (shared && (!current || shared.fingerprint !== current.fingerprint)) {
        const actual = state.profiles.find((profile) => profile.fingerprint === shared.fingerprint);
        if (!actual) {
          throw new Error("the shared Codex credential belongs to an unregistered account; refusing to overwrite it");
        }
        repairedFrom = current?.label || null;
        current = actual;
        state.activeProfileId = actual.id;
      }

      if (current && shared) atomicCopy(this.sharedAuthPath(), this.authPath(current.id));
      if (current?.id === target.id) {
        current.lastUsedAt = new Date().toISOString();
        this.save(state);
        return { target, changed: false, repairedFrom };
      }

      atomicWrite(this.paths.journal, `${JSON.stringify({
        version: 1,
        from: current?.id || null,
        to: target.id,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`, 0o600);
      atomicCopy(this.authPath(target.id), this.sharedAuthPath());
      const installed = this.inspectShared();
      if (installed?.fingerprint !== targetIdentity.fingerprint) {
        throw new Error("post-switch credential verification failed; switch journal retained for recovery");
      }
      state.activeProfileId = target.id;
      target.lastUsedAt = new Date().toISOString();
      this.save(state);
      try { fs.unlinkSync(this.paths.journal); } catch { /* doctor reports stale journals */ }
      return { target, changed: true, repairedFrom };
    });
  }

  remove(selector, { allowActive = false } = {}) {
    return withOperationLock(this.paths, () => {
      const state = this.load();
      const profile = this.resolve(selector, state);
      if (profile.id === state.activeProfileId && !allowActive) {
        throw new Error("cannot remove the active profile; switch to another profile first");
      }
      if (profile.id === state.activeProfileId) {
        const shared = this.inspectShared();
        if (shared && shared.fingerprint !== profile.fingerprint) {
          throw new Error("shared credential drift detected; refusing to remove active profile");
        }
        try { fs.unlinkSync(this.sharedAuthPath()); } catch (error) { if (error?.code !== "ENOENT") throw error; }
        state.activeProfileId = null;
      }
      const dir = path.dirname(this.authPath(profile.id));
      if (path.dirname(dir) !== this.paths.profiles) throw new Error("refusing unsafe profile removal path");
      fs.rmSync(dir, { recursive: true, force: false });
      state.profiles = state.profiles.filter((candidate) => candidate.id !== profile.id);
      this.save(state);
      return profile;
    });
  }

  rename(selector, label) {
    return withOperationLock(this.paths, () => {
      const state = this.load();
      const profile = this.resolve(selector, state);
      const nextLabel = sanitizeLabel(label);
      const collision = state.profiles.find((candidate) => candidate.id !== profile.id && candidate.label.toLowerCase() === nextLabel.toLowerCase());
      if (collision) throw new Error(`profile label is already in use: ${nextLabel}`);
      const previousLabel = profile.label;
      profile.label = nextLabel;
      this.save(state);
      return { profile, previousLabel };
    });
  }

  replaceProfileAuth(selector, authFile) {
    return withOperationLock(this.paths, () => {
      const state = this.load();
      const profile = this.resolve(selector, state);
      const { auth } = readAuthFile(authFile);
      const identity = inspectAuth(auth);
      if (identity.fingerprint !== profile.fingerprint) {
        throw new Error(`authenticated account does not match profile "${profile.label}"`);
      }
      atomicCopy(authFile, this.authPath(profile.id));
      profile.email = identity.email || profile.email;
      profile.planType = identity.planType || profile.planType;
      profile.authHealth = "ready";
      profile.lastAuthCheckedAt = new Date().toISOString();
      this.save(state);
      return { profile, identity };
    });
  }

  updateAuthHealth(selector, authHealth) {
    if (!["ready", "reauth-pending", "reauth-required", "temporarily-unavailable"].includes(authHealth)) {
      throw new Error(`unsupported profile auth health: ${authHealth}`);
    }
    return withOperationLock(this.paths, () => {
      const state = this.load();
      const profile = this.resolve(selector, state);
      profile.authHealth = authHealth;
      profile.lastAuthCheckedAt = new Date().toISOString();
      this.save(state);
      return profile;
    });
  }
}
