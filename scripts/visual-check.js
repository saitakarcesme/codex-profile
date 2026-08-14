import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "artifacts", "visual");
const edge = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!edge || !fs.existsSync(edge)) throw new Error("Microsoft Edge was not found for visual verification");

fs.mkdirSync(outputRoot, { recursive: true });
const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({ executablePath: edge, headless: true });
try {
  for (const scale of [1, 1.25, 1.5]) {
    const context = await browser.newContext({
      viewport: { width: 720, height: 420 },
      deviceScaleFactor: scale,
      reducedMotion: "no-preference",
    });
    await context.addInitScript(() => {
      window.__TAURI_INTERNALS__ = {
        invoke: async (command) => {
          if (command === "brand_icon") throw new Error("Brand icon intentionally omitted from synthetic visual fixture");
          if (command === "list_profiles") {
            return {
              profiles: [
                { id: "11111111-1111-4111-8111-111111111111", label: "Personal", username: "ibrahimsait", name: "Ibrahim Sait", active: true, status: "ready" },
                { id: "22222222-2222-4222-8222-222222222222", label: "Secondary", username: "secondary-user", name: "Secondary User", active: false, status: "ready" },
                { id: "33333333-3333-4333-8333-333333333333", label: "Fallback", username: null, name: "Display name", active: false, status: "ready" },
              ],
            };
          }
          return null;
        },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      };
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add account" }).waitFor();
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      profileCount: document.querySelectorAll(".profile").length,
    }));
    if (overflow.width !== 0 || overflow.height !== 0 || overflow.profileCount !== 4) {
      throw new Error(`visual layout failed at ${scale}x: ${JSON.stringify(overflow)}`);
    }
    await page.screenshot({ path: path.join(outputRoot, `selector-${String(scale).replace(".", "-")}x.png`) });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

process.stdout.write(`Visual checks passed at 100%, 125%, and 150% raster scales: ${outputRoot}\n`);
