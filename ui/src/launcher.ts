import { invoke } from "@tauri-apps/api/core";
import "./launcher.css";

const button = document.querySelector<HTMLButtonElement>("#launcher")!;
const icon = document.querySelector<HTMLImageElement>("#launcher-icon")!;

async function loadIcon() {
  try {
    icon.src = await invoke<string>("brand_icon");
  } catch {
    button.classList.add("launcher--icon-unavailable");
  }
}

button.addEventListener("click", async () => {
  button.classList.add("launcher--active");
  try {
    await invoke("open_selector");
  } finally {
    window.setTimeout(() => button.classList.remove("launcher--active"), 180);
  }
});

void loadIcon();
