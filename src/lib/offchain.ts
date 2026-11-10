import { readFile } from "node:fs/promises";
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

/**
 * Reads the JSON behind an NFT's `uri`. Supports https/Arweave as well as
 * file:// URIs produced by the local (dev-only) storage backend.
 */
export async function fetchOffchainMetadata(
  uri: string,
): Promise<OffchainMetadataJson | null> {
  try {
    if (uri.startsWith("file://")) {
      return JSON.parse(
        await readFile(fileURLToPath(uri), "utf8"),
      ) as OffchainMetadataJson;
    }
    if (!uri.startsWith("http")) return null;
    const response = await fetch(uri, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as OffchainMetadataJson;
  } catch {
    return null;
  }
}
