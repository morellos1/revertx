import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// One set of bundles, two packages. `extension/` is the Chrome package;
// `extension/dist/` is generated. `extension-firefox/` is a generated copy
// with the manifest block Firefox needs.
const watchMode = process.argv.includes("--watch");
const root = process.cwd();
const extDir = path.join(root, "extension");
const outDir = path.join(extDir, "dist");
const firefoxDir = path.join(root, "extension-firefox");

const entryPoints = {
  content: "src/content/main.ts",
  interceptor: "src/content/interceptor.ts",
  popup: "src/popup/popup.ts",
};

const config = {
  entryPoints,
  bundle: true,
  format: "iife",
  outdir: outDir,
  target: ["chrome120", "firefox128"],
  sourcemap: false,
  logLevel: "info",
  // Unminified: both stores want reviewable code.
  minify: false,
};

// The Firefox manifest is the Chrome one plus the block Firefox requires
// for a manifest_version 3 add-on: a stable id (signing and updates key on
// it; never change it) and the first version that runs the interceptor's
// MAIN-world content script. Nothing else differs: the `chrome.*` namespace,
// `action`, `storage` and the content_scripts keys all read the same.
const firefoxManifest = (chrome) => ({
  ...chrome,
  browser_specific_settings: {
    gecko: {
      id: "{21f2b618-63c1-4d5f-a269-a3c07b6f120b}",
      strict_min_version: "142.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
});

async function assembleFirefox() {
  await rm(firefoxDir, { recursive: true, force: true });
  await mkdir(firefoxDir, { recursive: true });
  for (const entry of ["dist", "icons", "popup.html"]) {
    await cp(path.join(extDir, entry), path.join(firefoxDir, entry), { recursive: true });
  }
  const chrome = JSON.parse(await readFile(path.join(extDir, "manifest.json"), "utf8"));
  await writeFile(
    path.join(firefoxDir, "manifest.json"),
    JSON.stringify(firefoxManifest(chrome), null, 2) + "\n",
  );
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const copyCss = async () => {
  await cp(path.join(root, "src", "styles", "popup.css"), path.join(outDir, "popup.css"));
  await cp(path.join(root, "src", "styles", "content.css"), path.join(outDir, "content.css"));
};
await copyCss();

if (watchMode) {
  // esbuild watches only the TS entry points; without this a CSS edit
  // under watch serves the stale copy from watch start.
  const { watch: fsWatch } = await import("node:fs");
  for (const name of ["popup.css", "content.css"]) {
    fsWatch(path.join(root, "src", "styles", name), () => {
      copyCss().then(() => console.log(`copied ${name}`), console.error);
    });
  }
  await (await context(config)).watch();
  console.log("watching (Chrome package only)...");
} else {
  await build(config);
  await assembleFirefox();
  console.log("built extension/ and extension-firefox/");
}
