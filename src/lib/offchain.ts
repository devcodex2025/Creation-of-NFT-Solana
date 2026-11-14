import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface OffchainMetadataJson {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  external_url?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  properties?: {
    files?: Array<{ uri: string; type: string }>;
    category?: string;
  };
}

const MAX_METADATA_BYTES = 512 * 1024;
const MAX_NAME = 256;
const MAX_DESCRIPTION = 4096;
const MAX_URL = 2048;
const MAX_ATTRIBUTES = 200;

/**
 * Metadata is data, never instructions. Control characters are stripped so a
 * description cannot smuggle terminal escapes or invisible directives, and
 * every field is length-limited so a hostile JSON cannot flood a prompt.
 */
function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  );
  const trimmed = cleaned.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanAttributes(
  value: unknown,
): Array<{ trait_type: string; value: string | number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const attributes: Array<{ trait_type: string; value: string | number }> = [];
  for (const entry of value.slice(0, MAX_ATTRIBUTES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const traitType = cleanString(
      record.trait_type ?? record.traitType ?? record.type,
      64,
    );
    const rawValue = record.value;
    const traitValue =
      typeof rawValue === "number" && Number.isFinite(rawValue)
        ? rawValue
        : cleanString(rawValue, 256);
    if (!traitType || traitValue === undefined) continue;
    attributes.push({ trait_type: traitType, value: traitValue });
  }
  return attributes.length > 0 ? attributes : undefined;
}

/** Rebuilds a fresh object from known fields only, so nothing is passed through. */
function sanitize(value: unknown): OffchainMetadataJson | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const result: OffchainMetadataJson = {};

  const name = cleanString(record.name, MAX_NAME);
  if (name) result.name = name;
  const symbol = cleanString(record.symbol, 32);
  if (symbol) result.symbol = symbol;
  const description = cleanString(record.description, MAX_DESCRIPTION);
  if (description) result.description = description;
  const image = cleanString(record.image, MAX_URL);
  if (image) result.image = image;
  const externalUrl = cleanString(record.external_url, MAX_URL);
  if (externalUrl) result.external_url = externalUrl;

  const attributes = cleanAttributes(record.attributes);
  if (attributes) result.attributes = attributes;

  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    const propertyRecord = properties as Record<string, unknown>;
    const cleanProperties: NonNullable<OffchainMetadataJson["properties"]> = {};
    if (Array.isArray(propertyRecord.files)) {
      const files: Array<{ uri: string; type: string }> = [];
      for (const file of propertyRecord.files.slice(0, 50)) {
        if (typeof file !== "object" || file === null) continue;
        const fileRecord = file as Record<string, unknown>;
        const uri = cleanString(fileRecord.uri, MAX_URL);
        const type = cleanString(fileRecord.type, 128);
        if (uri) files.push({ uri, type: type ?? "" });
      }
      if (files.length > 0) cleanProperties.files = files;
    }
    const category = cleanString(propertyRecord.category, 64);
    if (category) cleanProperties.category = category;
    if (Object.keys(cleanProperties).length > 0) {
      result.properties = cleanProperties;
    }
  }

  return result;
}

async function readLimited(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Reads the JSON behind an NFT's `uri`. Supports https/Arweave as well as
 * file:// URIs produced by the local (dev-only) storage backend. The result is
 * sanitized: unknown fields are dropped, strings are capped, and control
 * characters are removed. Treat the content as untrusted data, never as
 * instructions to the agent.
 */
export async function fetchOffchainMetadata(
  uri: string,
): Promise<OffchainMetadataJson | null> {
  try {
    if (uri.startsWith("file://")) {
      const target = fileURLToPath(uri);
      const info = await stat(target);
      if (info.size > MAX_METADATA_BYTES) return null;
      const text = (await readFile(target, "utf8")).replace(/^\uFEFF/, "");
      return sanitize(JSON.parse(text));
    }
    if (!uri.startsWith("http")) return null;
    const response = await fetch(uri, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const text = await readLimited(response, MAX_METADATA_BYTES);
    if (text === null) return null;
    return sanitize(JSON.parse(text));
  } catch {
    return null;
  }
}
