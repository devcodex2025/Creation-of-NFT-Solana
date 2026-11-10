import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import {
  keypairIdentity,
  sol,
  type GenericFile,
  type Umi,
  type UploaderInterface,
} from "@metaplex-foundation/umi";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { cluster, connection } from "./config";
import { loadSecretKey, repoRoot } from "./keypair";

export type StorageBackend = "irys" | "local";

export function getStorageBackend(): StorageBackend {
  const value = (process.env.STORAGE ?? "irys").trim().toLowerCase();
  if (value === "irys" || value === "arweave") return "irys";
  if (value === "local") return "local";
  throw new Error(
    `Unknown STORAGE "${value}". Use "irys" (Arweave, default) or "local" (dev-only, writes to ./uploads).`,
  );
}

function localUploadsDir(): string {
  return path.join(repoRoot, "uploads");
}

/**
 * Dev-only uploader: persists files to ./uploads and returns file:// URIs.
 * Useful for localnet tests and CI where no Arweave funding is available.
 * These URIs are NOT publicly resolvable — never use them for mainnet mints.
 */
function createLocalUploader(): UploaderInterface {
  const save = (fileName: string, bytes: Uint8Array): string => {
    const safeName = path
      .basename(fileName)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(-80);
    const unique = `${Date.now()}-${randomBytes(4).toString("hex")}-${safeName}`;
    const target = path.join(localUploadsDir(), unique);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return new URL(`file://${target.replace(/\\/g, "/")}`).toString();
  };

  return {
    upload: async (files: GenericFile[]) =>
      files.map((file) => save(file.fileName, file.buffer)),
    uploadJson: async <T>(json: T) =>
      save(
        "metadata.json",
        new TextEncoder().encode(JSON.stringify(json, null, 2)),
      ),
    getUploadPrice: async () => sol(0),
  };
}

export function createProjectUmi(keypairPath?: string): Umi {
  const umi = createUmi(connection);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(
    loadSecretKey(keypairPath),
  );

  umi.use(keypairIdentity(umiKeypair)).use(mplTokenMetadata());

  if (getStorageBackend() === "irys") {
    const defaultAddress =
      cluster === "mainnet-beta"
        ? "https://uploader.irys.xyz"
        : "https://devnet.irys.xyz";

    umi.use(
      irysUploader({
        address: process.env.IRYS_ADDRESS ?? defaultAddress,
      }),
    );
  } else {
    umi.uploader = createLocalUploader();
  }

  return umi;
}
