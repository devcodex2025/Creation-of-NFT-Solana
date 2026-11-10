import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { repoRoot } from "./keypair";

export interface NftAttribute {
  trait_type: string;
  value: string | number;
}

export interface MetadataOverrides {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  external_url?: string;
  attributes?: NftAttribute[];
}

export interface OffchainMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  attributes: NftAttribute[];
  properties: {
    files: Array<{ uri: string; type: string }>;
    category: string;
  };
}

/** Metaplex on-chain limits (bytes for strings). */
export const LIMITS = {
  name: 32,
  symbol: 10,
  uri: 200,
  creators: 5,
} as const;

export function resolveAssetPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const fromCwd = path.resolve(process.cwd(), filePath);
  if (existsSync(fromCwd)) return fromCwd;
  return path.resolve(repoRoot, filePath);
}

export function readJsonFile<T>(filePath: string): T {
  const resolved = resolveAssetPath(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`JSON file not found: ${resolved}`);
  }
  try {
    return JSON.parse(
      readFileSync(resolved, "utf8").replace(/^\uFEFF/, ""),
    ) as T;
  } catch (error) {
    throw new Error(
      `Could not parse ${resolved} as JSON: ${(error as Error).message}`,
    );
  }
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function assertOnChainLimits(input: {
  name: string;
  symbol: string;
  uri?: string;
}): void {
  if (!input.name.trim()) throw new Error("NFT name is required.");
  if (byteLength(input.name) > LIMITS.name) {
    throw new Error(
      `Name "${input.name}" is ${byteLength(input.name)} bytes; Metaplex allows at most ${LIMITS.name} (roughly 32 ASCII characters).`,
    );
  }
  if (byteLength(input.symbol) > LIMITS.symbol) {
    throw new Error(
      `Symbol "${input.symbol}" is ${byteLength(input.symbol)} bytes; Metaplex allows at most ${LIMITS.symbol}.`,
    );
  }
  if (input.uri && byteLength(input.uri) > LIMITS.uri) {
    throw new Error(
      `Metadata URI is ${byteLength(input.uri)} bytes; Metaplex allows at most ${LIMITS.uri}.`,
    );
  }
}

export function normalizeAttributes(value: unknown): NftAttribute[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      'Attributes must be an array, e.g. [{"trait_type":"Background","value":"Red"}].',
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Attribute at index ${index} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const traitType = record.trait_type ?? record.traitType ?? record.type;
    const traitValue = record.value;
    if (typeof traitType !== "string" || traitType.trim() === "") {
      throw new Error(`Attribute at index ${index} is missing "trait_type".`);
    }
    if (
      typeof traitValue !== "string" &&
      typeof traitValue !== "number"
    ) {
      throw new Error(
        `Attribute "${traitType}" needs a string or number "value".`,
      );
    }
    return { trait_type: traitType.trim(), value: traitValue };
  });
}

export function parseAttributesInput(
  value: string | undefined,
): NftAttribute[] | undefined {
  if (!value) return undefined;
  try {
    return normalizeAttributes(JSON.parse(value));
  } catch (error) {
    throw new Error(
      `--attributes must be a JSON array, e.g. [{"trait_type":"Background","value":"Red"}]. ` +
        `Received: ${value}. Parse error: ${(error as Error).message}`,
    );
  }
}

/** 10000 basis points = 100%. */export function parseRoyaltyBps(value: number | string | undefined): number {
  if (value === undefined) return 0;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) {
    throw new Error(
      `Royalty must be an integer between 0 and 10000 basis points (500 = 5%). Received "${value}".`,
    );
  }
  return parsed;
}

export function buildOffchainMetadata(input: {
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  imageContentType: string;
  externalUrl?: string;
  attributes?: NftAttribute[];
}): OffchainMetadata {
  const metadata: OffchainMetadata = {
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    description: input.description,
    image: input.imageUri,
    attributes: input.attributes ?? [],
    properties: {
      files: [{ uri: input.imageUri, type: input.imageContentType }],
      category: "image",
    },
  };

  if (input.externalUrl) metadata.external_url = input.externalUrl;
  return metadata;
}

export function loadMetadataTemplate(
  filePath: string | undefined,
): MetadataOverrides {
  if (!filePath) return {};
  const parsed = readJsonFile<MetadataOverrides & Record<string, unknown>>(
    filePath,
  );
  return {
    name: parsed.name,
    symbol: parsed.symbol,
    description: parsed.description,
    image: parsed.image,
    external_url: parsed.external_url,
    attributes: parsed.attributes,
  };
}
