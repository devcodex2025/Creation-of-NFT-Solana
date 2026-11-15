import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import {
  generateSigner,
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
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys/web";
import { VersionedTransaction } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { cluster, connection } from "./config";
import { repoRoot } from "./paths";
import { connectBrowserWallet, type BrowserWallet, type RequestContext } from "./browser-bridge";
import { describeTransaction, type BrowserAction } from "./approval";

export type { BrowserAction } from "./approval";
export { describeTransaction } from "./approval";

export type StorageBackend = "irys" | "local";

/** How the CLI gets signatures. Keypair signing was removed. */
export type SignerMode = "browser" | "readonly";

export function resolveSignerMode(value?: string): SignerMode {
  const mode = (value ?? "browser").trim().toLowerCase();
  if (
    mode === "browser" ||
    mode === "wallet" ||
    mode === "phantom" ||
    mode === "solflare" ||
    mode === "backpack"
  ) {
    return "browser";
  }
  if (mode === "readonly" || mode === "read-only" || mode === "read") {
    return "readonly";
  }
  if (mode === "keypair" || mode === "file" || mode === "local") {
    throw new Error(
      'Keypair signing was removed. Use --signer browser, or --signer readonly for read-only commands.',
    );
  }
  throw new Error(
    `Unknown signer "${value}". Use "browser" (Phantom, Solflare, Backpack) or "readonly".`,
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

function createReadOnlyUploader(): UploaderInterface {
  const fail = async (): Promise<never> => {
    throw new Error("Read-only mode cannot upload files.");
  };
  return {
    upload: fail,
    uploadJson: fail,
    getUploadPrice: async () => sol(0),
  };
}

/** Prints the same facts the browser page shows, so the terminal and the
 * wallet prompt cannot disagree. */
function printApproval(context: RequestContext): void {
  console.log(`\n   Approval: ${context.label}`);
  for (const fact of context.facts ?? []) {
    console.log(`     ${`${fact.label}:`.padEnd(13)} ${fact.value}`);
  }
  if (context.operations && context.operations.length > 0) {
    console.log("     Operations:");
    for (const operation of context.operations) {
      console.log(`       - ${operation}`);
    }
  }
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
    const web3 = toWeb3JsTransaction(transaction);
    const bytes = web3.serialize();
    const context = describeTransaction(
      transaction,
      action,
      web3.message.header.numRequiredSignatures,
    );
    printApproval(context);
    const signedBytes = await wallet.signTransaction(bytes, context);
    return fromWeb3JsTransaction(VersionedTransaction.deserialize(signedBytes));
  };

  return {
    publicKey: umiPublicKey(wallet.publicKey),
    signMessage: (message) =>
      wallet.signMessage(message, {
        label: "Approve upload signature",
        detail: "Signs the Arweave upload so this file can be stored.",
        facts: [
          {
            label: "Payload",
            value: "Upload signature only. No transaction, no fee.",
          },
        ],
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
  signer?: SignerMode;
  browserAction?: BrowserAction;
}

export async function createProjectUmi(
  options: ProjectUmiOptions = {},
): Promise<Umi> {
  const umi = createUmi(connection);
  const mode = options.signer ?? "browser";

  if (mode === "browser") {
    const wallet = await connectBrowserWallet();
    console.log(`\n🔗  Wallet connected: ${wallet.publicKey}`);
    console.log(`   Approve each transaction in the browser tab.`);
    umi.use(
      signerIdentity(
        createBrowserSigner(wallet, options.browserAction ?? "transaction"),
      ),
    );
  } else {
    // Reads do not need a real wallet; a throwaway signer keeps umi happy.
    umi.use(signerIdentity(generateSigner(umi)));
  }

  umi.use(mplTokenMetadata());

  if (getStorageBackend() === "local") {
    umi.uploader = createLocalUploader();
  } else if (mode === "browser") {
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
    umi.uploader = createReadOnlyUploader();
  }

  return umi;
}
