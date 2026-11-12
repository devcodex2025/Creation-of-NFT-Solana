/**
 * Minimal `--flag value` argument parser. No dependency needed for a handful
 * of CLIs, and it keeps the scripts readable.
 */
export type Flags = Record<string, string | boolean>;

export function parseArgs(argv: string[] = process.argv.slice(2)): Flags {
  const flags: Flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=");
    const key = rawKey.trim();
    if (!key) continue;

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
      continue;
    }

    flags[key] = true;
  }

  warnIfFlagsWereSwallowed(flags, argv);
  return flags;
}

/**
 * Windows PowerShell 7 with npm 11 eats the first `--` and treats `--flag` as
 * npm config, so `npm run create:nft -- --name X` reaches the script with no
 * flags at all and silently falls back to defaults. Say so instead of minting
 * something the caller did not ask for.
 */
function warnIfFlagsWereSwallowed(flags: Flags, argv: string[]): void {
  if (Object.keys(flags).length > 0) return;
  if (argv.length === 0) return;
  if (!process.env.npm_lifecycle_event) return;

  console.warn(
    [
      "",
      "⚠️  No --flags reached this script, so defaults are in use.",
      "   Windows PowerShell 7 + npm 11 strips --flags from `npm run`.",
      "   Add an extra separator:  npm run <script> -- -- --name \"...\"",
      "   Or call the script directly:  npx esrun src/commands/<file>.ts --name \"...\"",
      "",
    ].join("\n"),
  );
}

export function getString(
  flags: Flags,
  key: string,
  fallback?: string,
): string | undefined {
  const value = flags[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return fallback;
}

export function getRequiredString(flags: Flags, key: string): string {
  const value = getString(flags, key);
  if (!value) throw new Error(`Missing required argument --${key}`);
  return value;
}

export function getNumber(
  flags: Flags,
  key: string,
  fallback: number,
): number {
  const value = getString(flags, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Argument --${key} must be a number, received "${value}"`);
  }
  return parsed;
}

export function hasFlag(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}
