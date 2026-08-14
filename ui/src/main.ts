import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Profile = {
  id: string;
  label: string;
  active: boolean;
  status: string;
  avatarDataUrl?: string | null;
};

type ProfileResponse = {
  profiles: Profile[];
};

const root = document.querySelector<HTMLDivElement>("#app")!;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]!);
}

root.innerHTML = `
  <main class="app-shell">
    <div class="ambient" aria-hidden="true">
      <div class="ambient-orb ambient-orb--one"></div>
      <div class="ambient-orb ambient-orb--two"></div>
      <div class="ambient-orb ambient-orb--three"></div>
      <div class="ambient-grain"></div>
    </div>

    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>
        <img class="brand-icon" id="brand-icon" alt="" draggable="false" />
        <span data-tauri-drag-region>Codex Profile</span>
      </div>
      <div class="window-controls">
        <button class="window-control" id="minimize" type="button" aria-label="Minimize">
          <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 9.5h10" /></svg>
        </button>
        <button class="window-control window-control--close" id="close" type="button" aria-label="Close">
          <svg viewBox="0 0 18 18" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" /></svg>
        </button>
      </div>
    </header>

    <section class="selector" aria-labelledby="selector-title">
      <button class="refresh" id="refresh" type="button" aria-label="Refresh profiles" title="Refresh profiles">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.05 5.35M20 5v6h-6" /></svg>
      </button>
      <div class="heading-group">
        <h1 id="selector-title">Choose a profile</h1>
        <p>Switch between your Codex accounts</p>
      </div>
      <div class="profiles" id="profiles" aria-live="polite"></div>
      <div class="status" id="status" role="status" aria-live="polite"></div>
    </section>
  </main>
`;

const profilesElement = document.querySelector<HTMLDivElement>("#profiles")!;
const statusElement = document.querySelector<HTMLDivElement>("#status")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh")!;
const brandIcon = document.querySelector<HTMLImageElement>("#brand-icon")!;

let profiles: Profile[] = [];
let busyProfileId: string | null = null;
let addBusy = false;

function initials(label: string): string {
  return label.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function setStatus(message = "", kind: "neutral" | "error" = "neutral") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
  statusElement.classList.toggle("status--visible", Boolean(message));
}

const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function requestProfiles(): Promise<ProfileResponse> {
  let lastError: unknown = new Error("Codex Profile core did not become ready");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await invoke<ProfileResponse>("list_profiles");
    } catch (error) {
      lastError = error;
      if (!/state not managed/i.test(String(error))) throw error;
      await delay(125);
    }
  }
  throw lastError;
}

function profileMarkup(profile: Profile): string {
  const selected = profile.active ? " profile--selected" : "";
  const processing = busyProfileId === profile.id ? " profile--processing" : "";
  const image = profile.avatarDataUrl
    ? `<img src="${profile.avatarDataUrl}" alt="" draggable="false" />`
    : `<span class="avatar-fallback" aria-hidden="true">${escapeHtml(initials(profile.label))}</span>`;
  return `
    <button class="profile${selected}${processing}" type="button" data-profile-id="${escapeHtml(profile.id)}" aria-label="${escapeHtml(profile.label)}${profile.active ? ", current profile" : ""}" aria-current="${profile.active ? "true" : "false"}">
      <span class="avatar-wrap">
        <span class="avatar">${image}</span>
        ${profile.active ? `<span class="selected-indicator" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m4 8.2 2.5 2.5L12 5.4" /></svg></span>` : ""}
        ${busyProfileId === profile.id ? `<span class="progress-ring" aria-hidden="true"></span>` : ""}
      </span>
      <span class="profile-name">${escapeHtml(profile.label)}</span>
    </button>
  `;
}

function render() {
  const totalItems = profiles.length + 1;
  profilesElement.dataset.items = String(totalItems);
  profilesElement.classList.toggle("profiles--wrap", totalItems > 5);
  profilesElement.innerHTML = `${profiles.map(profileMarkup).join("")}
    <button class="profile profile--add${addBusy ? " profile--processing" : ""}" id="add-account" type="button" aria-label="Add account">
      <span class="avatar-wrap">
        <span class="avatar add-surface"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 7v18M7 16h18" /></svg></span>
        ${addBusy ? `<span class="progress-ring" aria-hidden="true"></span>` : ""}
      </span>
      <span class="profile-name">Add account</span>
    </button>`;

  profilesElement.querySelectorAll<HTMLButtonElement>("[data-profile-id]").forEach((button) => {
    button.addEventListener("click", () => switchProfile(button.dataset.profileId!));
  });
  document.querySelector<HTMLButtonElement>("#add-account")?.addEventListener("click", addAccount);
}

async function loadProfiles(showFeedback = false) {
  refreshButton.classList.add("refresh--busy");
  refreshButton.disabled = true;
  try {
    const response = await requestProfiles();
    profiles = response.profiles;
    render();
    if (showFeedback) {
      setStatus("Profiles refreshed");
      window.setTimeout(() => setStatus(), 1600);
    }
  } catch (error) {
    setStatus(String(error), "error");
  } finally {
    refreshButton.classList.remove("refresh--busy");
    refreshButton.disabled = false;
  }
}

async function loadBrandIcon() {
  try {
    brandIcon.src = await invoke<string>("brand_icon");
    brandIcon.classList.add("brand-icon--ready");
  } catch {
    brandIcon.remove();
  }
}

async function switchProfile(profileId: string) {
  if (busyProfileId || addBusy) return;
  const target = profiles.find((profile) => profile.id === profileId);
  if (!target || target.active) return;
  busyProfileId = profileId;
  setStatus();
  render();
  try {
    await invoke("switch_profile", { profileId });
    await loadProfiles();
  } catch (error) {
    setStatus(String(error), "error");
  } finally {
    busyProfileId = null;
    render();
  }
}

async function addAccount() {
  if (busyProfileId || addBusy) return;
  addBusy = true;
  setStatus();
  render();
  try {
    await invoke("add_account");
    await loadProfiles();
  } catch (error) {
    setStatus(String(error), "error");
  } finally {
    addBusy = false;
    render();
  }
}

document.querySelector<HTMLButtonElement>("#minimize")!.addEventListener("click", () => invoke("hide_selector"));
document.querySelector<HTMLButtonElement>("#close")!.addEventListener("click", () => invoke("hide_selector"));
refreshButton.addEventListener("click", () => loadProfiles(true));

void loadProfiles();
void loadBrandIcon();
