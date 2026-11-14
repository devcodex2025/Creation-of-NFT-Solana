import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const sections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function versionAt(key) {
  const entry = lock.packages[key];
  if (!entry) return null;
  if (typeof entry.version === "string") return entry.version;
  if (entry.link && typeof entry.resolved === "string") {
    const target = lock.packages[entry.resolved];
    if (target && typeof target.version === "string") return target.version;
  }
  return null;
}

function installedVersion(name, fromKey) {
  const candidates = [];
  if (!fromKey) {
    candidates.push(`node_modules/${name}`);
  } else {
    let base = fromKey;
    for (;;) {
      candidates.push(`${base}/node_modules/${name}`);
      const marker = base.lastIndexOf("/node_modules/");
      if (marker < 0) break;
      base = base.slice(0, marker);
    }
    candidates.push(`node_modules/${name}`);
  }

  for (const key of candidates) {
    const version = versionAt(key);
    if (version) return version;
  }

  for (const key of Object.keys(lock.packages)) {
    if (!key.endsWith(`/node_modules/${name}`)) continue;
    const version = versionAt(key);
    if (version) return version;
  }

  return null;
}

function pinSpec(name, spec, fromKey) {
  if (typeof spec !== "string") return spec;
  if (!/^[\^~]|^\*$|^latest$/.test(spec)) return spec;
  const version = installedVersion(name, fromKey);
  if (version) return version;
  const floor = spec.match(/^[\^~](\d[\w.+-]*)$/);
  return floor ? floor[1] : spec;
}

let pinned = 0;
let unresolved = 0;

for (const [key, entry] of Object.entries(lock.packages)) {
  for (const section of sections) {
    const deps = entry[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const next = pinSpec(name, spec, key);
      if (next === spec) {
        if (/^[\^~]|^\*$|^latest$/.test(spec)) unresolved += 1;
        continue;
      }
      deps[name] = next;
      pinned += 1;
    }
  }

  if (entry.engines && entry.engines.node === "*") {
    entry.engines.node = ">=0.0.0";
  }
}

for (const section of sections) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    const next = pinSpec(name, spec, "");
    if (next === spec) {
      if (/^[\^~]|^\*$|^latest$/.test(spec)) unresolved += 1;
      continue;
    }
    manifest[section][name] = next;
    pinned += 1;
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(
  `Pinned ${pinned} versions in package.json and package-lock.json` +
    (unresolved ? `; ${unresolved} could not be resolved` : ""),
);
if (unresolved) process.exitCode = 1;
