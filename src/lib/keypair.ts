import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

// `__dirname` is unreliable under some TS runners (esrun bundles modules into
// a virtual path), so anchor the project root to the working directory.
export const repoRoot = findRepoRoot(process.cwd());

export const defaultKeypairPath = path.join(repoRoot, "keypair.json");

export const solanaCliKeypairPath = path.join(
  homedir(),
  ".config",
  "solana",
  "id.json",
);

export function resolveKeypairPath(explicit?: string): string {
  // An explicitly requested wallet must exist. Falling back to a different
  // keypair here would silently pay fees from the wrong account.
  const requested = explicit ?? process.env.KEYPAIR_PATH;
  if (requested) {
    const resolved = path.resolve(requested);
    if (existsSync(resolved)) return resolved;
    throw new Error(
      [
        `Keypair not found at ${resolved}.`,
        "Check --keypair or KEYPAIR_PATH.",
        "Refusing to fall back to another wallet, because that would pay from a different account.",
      ].join("\n"),
    );
  }

  const candidates = [defaultKeypairPath, solanaCliKeypairPath];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    [
      "No keypair found.",
      `Looked in: ${candidates.join(", ")}`,
      "Create one with `npm run keypair` (writes keypair.json in the project root),",
      "or set KEYPAIR_PATH in .env to point at an existing Solana keypair.",
    ].join("\n"),
  );
}

export function loadSecretKey(keypairPath?: string): Uint8Array {
  const resolved = resolveKeypairPath(keypairPath);
  const raw = readFileSync(resolved, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${resolved} is not valid JSON. A Solana keypair is a JSON array of 64 bytes, ` +
        "as produced by `solana-keygen new` or `npm run keypair`.",
    );
  }

  if (!Array.isArray(parsed) || parsed.some((byte) => typeof byte !== "number")) {
    throw new Error(
      `${resolved} must contain a JSON array of numbers (the 64-byte secret key).`,
    );
  }

  const secretKey = Uint8Array.from(parsed as number[]);
  if (secretKey.length !== 64) {
    throw new Error(
      `${resolved} contains ${secretKey.length} bytes; a Solana secret key must be 64 bytes.`,
    );
  }

  return secretKey;
}

export function loadKeypair(keypairPath?: string): Keypair {
  return Keypair.fromSecretKey(loadSecretKey(keypairPath));
}

export interface CreatedKeypair {
  keypairPath: string;
  publicKey: string;
}

export function createKeypairFile(
  keypairPath: string = defaultKeypairPath,
): CreatedKeypair {
  const resolved = path.resolve(keypairPath);
  if (existsSync(resolved)) {
    throw new Error(
      `Refusing to overwrite ${resolved}. Delete it first if you really want a new keypair.`,
    );
  }

  const keypair = Keypair.generate();
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(
    resolved,
    JSON.stringify(Array.from(keypair.secretKey)),
    { mode: 0o600 },
  );

  return {
    keypairPath: resolved,
    publicKey: keypair.publicKey.toBase58(),
  };
}
