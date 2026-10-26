import { createHash } from "node:crypto";
import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { VERSION } from "./version";
const hex = /^[a-f0-9]{64}$/;
/** Called once per loaded health producer. Source checkout has no installed bundle identity. */
export function installedRuntimeBundleId(entrypoint: string): string | null {
  try {
    const entry = realpathSync(entrypoint), root = realpathSync(resolve(dirname(entry), ".."));
    const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    if (manifest?.schemaVersion !== 2 || manifest.appVersion !== VERSION || manifest.platform !== process.platform
      || manifest.arch !== process.arch || manifest.entrypoint !== "app/cli.js"
      || entry !== realpathSync(resolve(root, manifest.entrypoint)) || !hex.test(manifest.bundleId)
      || !Array.isArray(manifest.files) || !manifest.files.length) return null;
    const actual: string[] = [];
    const visit = (directory: string) => {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        const absolute = resolve(directory, file.name), name = relative(root, absolute).split(sep).join("/");
        if (name === "manifest.json") continue;
        if (file.isDirectory()) visit(absolute); else actual.push(name);
      }
    };
    visit(root);
    if (JSON.stringify(actual.sort()) !== JSON.stringify(manifest.files.map((f: { path: string }) => f.path))) return null;
    const hash = createHash("sha256"); let previous = ""; let found = false;
    for (const file of manifest.files) {
      if (typeof file.path !== "string" || file.path <= previous || file.path.includes("\\") || file.path === "manifest.json"
        || file.path.split("/").some((s: string) => !s || s === "." || s === "..")
        || !Number.isSafeInteger(file.size) || file.size < 0 || !hex.test(file.sha256)) return null;
      previous = file.path;
      const absolute = realpathSync(resolve(root, file.path));
      if (!absolute.startsWith(root + sep)) return null;
      const data = readFileSync(absolute);
      if (data.length !== file.size || createHash("sha256").update(data).digest("hex") !== file.sha256) return null;
      hash.update(file.path).update("\0").update(String(file.size)).update("\0").update(file.sha256).update("\0");
      if (file.path === manifest.entrypoint) found = true;
    }
    return found && hash.digest("hex") === manifest.bundleId ? manifest.bundleId : null;
  } catch { return null; }
}
