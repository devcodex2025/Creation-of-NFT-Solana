import { createGenericFile, type Umi } from "@metaplex-foundation/umi";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveAssetPath } from "./metadata";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".json": "application/json",
  ".html": "text/html",
};

export function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export interface UploadedAsset {
  uri: string;
  contentType: string;
  filePath: string;
}

export async function uploadAsset(
  umi: Umi,
  filePath: string,
): Promise<UploadedAsset> {
  const resolved = resolveAssetPath(filePath);
  const buffer = await fs.readFile(resolved);
  const fileName = path.basename(resolved);
  const contentType = contentTypeFor(resolved);

  const file = createGenericFile(buffer, fileName, { contentType });
  const [uri] = await umi.uploader.upload([file]);

  return { uri, contentType, filePath: resolved };
}

export async function uploadMetadata(
  umi: Umi,
  metadata: object,
): Promise<string> {
  return umi.uploader.uploadJson(metadata);
}
