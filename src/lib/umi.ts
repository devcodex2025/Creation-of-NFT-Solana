import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import {
  generateSigner,
  keypairIdentity,
  publicKey as umiPublicKey,
  signerIdentity,
  sol,
  type GenericFile,
  type Signer,
  type Transaction as UmiTransaction,
  type Umi,
  type UploaderInterface,
} from "@metaplex-foundation/umi";
import {
  fromWeb3JsTransaction,
  toWeb3JsTransaction,
} from "@metaplex-foundation/umi-web3js-adapters";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";
import { VersionedTransaction } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { cluster, connection } from "./config";
import { loadSecretKey, repoRoot } from "./keypair";
import { connectBrowserWallet, type BrowserWallet, type RequestContext } from "./browser-bridge";

export type StorageBackend = "irys" | "local";

/** How the CLI gets signatures. */
export type SignerMode = "keypair" | "browser" | "readonly";

export function resolveSignerMode(value?: string): SignerMode {
  const mode = (value ?? "keypair").trim().toLowerCase();
  if (mode === "keypair" || mode === "file" || mode === "local") return "keypair";
  if (mode === "browser" || mode === "wallet" || mode === "phantom") return "browser";
  if (mode === "readonly" || mode === "read-only") return "readonly";
  throw new Error(
    `Unknown signer "${value}". Use "keypair" (local keypair file) or "browser" (Phantom, Solflare, Backpack).`,
  );
}

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

const METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export type BrowserAction =
  | "collection"
  | "nft"
  | "update"
  | "verify"
  | "batch"
  | "transaction";

export function describeTransaction(
  transaction: UmiTransaction,
  action: BrowserAction,
): RequestContext {
  // Delegation changes are the point of the batch approval, so they are named
  // before the create instruction that shares the same transaction.
  for (const instruction of transaction.message.instructions) {
    const programId = transaction.message.accounts[instruction.programIndex];
    if (programId !== METADATA_PROGRAM_ID) continue;
    const data = instruction.data;
    if (data[0] === 44) {
      return {
        label: "Approve collection delegation",
        detail: "Lets the temporary batch key verify items in this collection.",
      };
    }
    if (data[0] === 45) {
      return {
        label: "Revoke collection delegation",
        detail: "Removes the temporary batch key's permission.",
      };
    }
  }

  for (const instruction of transaction.message.instructions) {
    const programId = transaction.message.accounts[instruction.programIndex];
    if (programId !== METADATA_PROGRAM_ID) continue;
    const data = instruction.data;
    if (data[0] === 52 && data[1] === 1) {
      return {
        label: "Approve collection verification",
        detail: "Marks the NFT as a verified member of its collection on chain.",
      };
    }
    if (data[0] === 52 && data[1] === 0) {
      return {
        label: "Approve creator verification",
        detail: "Marks the wallet as a verified creator of these NFTs.",
      };
    }
    if (data[0] === 42) {
      return action === "collection"
        ? {
            label: "Approve collection creation",
            detail: "Creates the collection NFT and its metadata account.",
          }
        : {
            label: "Approve NFT mint",
            detail: "Creates the NFT and its metadata account.",
          };
    }
  }
  for (const instruction of transaction.message.instructions) {
    const programId = transaction.message.accounts[instruction.programIndex];
    if (programId !== SYSTEM_PROGRAM_ID) continue;
    const data = instruction.data;
    if (data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0) {
      if (action === "batch") {
        return {
          label: "Approve batch funding",
          detail: "Sends SOL to the temporary batch key for rent and uploads.",
        };
      }
      return {
        label: "Approve storage payment",
        detail: "Pays Irys for the Arweave upload.",
      };
    }
  }
  if (action === "update") {
    return {
      label: "Approve metadata update",
      detail: "Writes the new metadata to the NFT.",
    };
  }
  return {
    label: "Approve transaction",
    detail: "Signs a Solana transaction built by the CLI.",
  };
}
/**
 * Signs through the browser bridge. Umi passes the transaction, the wallet
 * signs the serialized bytes, and the signed transaction comes back with all
 * previously collected signatures intact.
 */
function createBrowserSigner(
  wallet: BrowserWallet,
  action: BrowserAction,
): Signer {
  const signTransaction = async (
    transaction: UmiTransaction,
  ): Promise<UmiTransaction> => {
    const bytes = toWeb3JsTransaction(transaction).serialize();
    const signedBytes = await wallet.signTransaction(
      bytes,
      describeTransaction(transaction, action),
    );
    return fromWeb3JsTransaction(VersionedTransaction.deserialize(signedBytes));
  };

  return {
    publicKey: umiPublicKey(wallet.publicKey),
    signMessage: (message) =>
      wallet.signMessage(message, {
        label: "Approve upload signature",
        detail: "Signs the Arweave upload so this file can be stored.",
      }),
    signTransaction,
    signAllTransactions: async (transactions) => {
      const signed: UmiTransaction[] = [];
      for (const transaction of transactions) {
        signed.push(await signTransaction(transaction));
      }
      return signed;
    },
  };
}

export interface ProjectUmiOptions {
  keypairPath?: string;
  signer?: SignerMode;
  browserAction?: BrowserAction;
}

export async function createProjectUmi(
  options: ProjectUmiOptions = {},
): Promise<Umi> {
  const umi = createUmi(connection);
  const mode = options.signer ?? "keypair";

  if (mode === "browser") {
    const wallet = await connectBrowserWallet();
    console.log(`\n🔗  Wallet connected: ${wallet.publicKey}`);
    console.log(`   Approve each transaction in the browser tab.`);
    umi.use(signerIdentity(createBrowserSigner(wallet, options.browserAction ?? "transaction")));
  } else if (mode === "readonly") {
    // Reads do not need a real wallet; a throwaway signer keeps umi happy.
    umi.use(signerIdentity(generateSigner(umi)));
  } else {
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(
      loadSecretKey(options.keypairPath),
    );
    umi.use(keypairIdentity(umiKeypair));
  }

  umi.use(mplTokenMetadata());

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
