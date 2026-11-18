import { build } from "esbuild";
import { mkdirSync, copyFileSync, cpSync, writeFileSync } from "node:fs";
import "./build-native.mjs";
mkdirSync("dist/desktop", { recursive: true });
mkdirSync("dist/ui", { recursive: true });
for (const file of ["main.mjs", "window.mjs", "preload.cjs"])
  copyFileSync(`src/desktop/${file}`, `dist/desktop/${file}`);
cpSync("src/bridge", "dist/bridge", { recursive: true });
await build({
  entryPoints: ["src/ui/main.tsx"],
  outfile: "dist/ui/app.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  minify: true,
  jsx: "automatic",
  loader: { ".css": "css", ".woff2": "file" },
  assetNames: "fonts/[name]",
});
for (const file of ["OFL-Inter.txt", "OFL-JetBrainsMono.txt"])
  copyFileSync(`src/ui/fonts/${file}`, `dist/ui/fonts/${file}`);
copyFileSync("src/ui/index.html", "dist/ui/index.html");
writeFileSync(
  "dist/runtime.json",
  JSON.stringify({ node: process.execPath }, null, 2),
);
console.log(
  "Built mesh bridge, native process container and collaboration note",
);
