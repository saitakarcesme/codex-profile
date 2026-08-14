import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src-tauri", "resources", "core");

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const name of ["bin", "src"]) fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
fs.copyFileSync(path.join(root, "package.json"), path.join(target, "package.json"));
