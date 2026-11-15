import {
  createGenericFile,
  createGenericFileFromJson,
  generateSigner,
  percentAmount,
  publicKey as umiPublicKey,
  some,
  transactionBuilder,
  type GenericFile,
  type PublicKey,
  type Signer,
  type Umi,
} from "@metaplex-foundation/umi";
import {
  createNft,
  fetchDigitalAsset,
  findMetadataPda,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import { setComputeUnitPrice } from "@metaplex-foundation/mpl-toolbox";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey as Web3PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { getNumber, getString, hasFlag, parseArgs } from "../lib/args";
import {
  cluster,
  connection,
  explorerAddressUrl,
  lamportsPerSol,
  rpcUrl,
} from "../lib/config";
import {
  LIMITS,
  assertOnChainLimits,
  buildOffchainMetadata,
  byteLength,
  normalizeAttributes,
  type NftAttribute,
} from "../lib/metadata";
import {
  readBatchItems,
  readState,
  resetBatchItem,
  saveBatchItem,
  saveCollection,
  saveNft,
  setWallet,
  stateFile,
} from "../lib/state";
import { retryRpc, sendAndConfirm, type SignedTransactionRecord } from "../lib/tx";
import { contentTypeFor } from "../lib/upload";
import { createProjectUmi, getStorageBackend, resolveSignerMode } from "../lib/umi";

/**
 * Batch creation uses only the connected browser wallet: it uploads the art
 * and metadata, creates the collection, and mints every item with the wallet
 * as both update authority and token owner. No temporary key ever owns an NFT.
 */

interface ManifestCollection {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  royalty?: number;
  address?: string;
}

interface BatchItem {
  name: string;
  image: string;
  description?: string;
  attributesFile?: string;
}

interface Manifest {
  collection?: ManifestCollection;
  items: BatchItem[];
}

interface PreparedItem extends BatchItem {
  attributes: NftAttribute[];
}

const RENT_SIZES = { mint: 82, token: 165, metadata: 679, edition: 282 };
const FALLBACK_RENT_PER_ITEM = 0.012;

function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function readManifest(file: string): { base: string; manifest: Manifest } {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) throw new Error(`Manifest not found: ${resolved}`);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  const base = path.dirname(resolved);

  const rawItems = Array.isArray(parsed)
    ? parsed
    : (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(rawItems)) {
    throw new Error(
      'Manifest must be a JSON array of items, or an object with an "items" array.',
    );
  }

  const rawCollection =
    !Array.isArray(parsed) && parsed && typeof parsed === "object"
      ? (parsed as { collection?: unknown }).collection
      : undefined;
  const collection =
    rawCollection && typeof rawCollection === "object"
      ? (rawCollection as ManifestCollection)
      : undefined;

  const items = rawItems.map((entry, index) => {
    const item = entry as Partial<BatchItem>;
    if (typeof item.name !== "string" || !item.name.trim()) {
      throw new Error(`Item ${index + 1} needs a "name".`);
    }
    if (typeof item.image !== "string" || !item.image.trim()) {
      throw new Error(`Item "${item.name}" needs an "image" path.`);
    }
    return {
      name: item.name.trim(),
      image: resolveFrom(base, item.image),
      description: item.description,
      attributesFile: item.attributesFile
        ? resolveFrom(base, item.attributesFile)
        : undefined,
    };
  });

  return {
    base,
    manifest: {
      collection: collection
        ? {
            ...collection,
            image: collection.image
              ? resolveFrom(base, collection.image)
              : undefined,
          }
        : undefined,
      items,
    },
  };
}

/** Attributes files may be a bare trait array or a full metadata JSON. */
function loadAttributes(file?: string): NftAttribute[] {
  if (!file) return [];
  if (!existsSync(file)) throw new Error(`Attributes file not found: ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (Array.isArray(parsed)) return normalizeAttributes(parsed);
  if (parsed && typeof parsed === "object") {
    const attributes = (parsed as { attributes?: unknown }).attributes;
    if (attributes !== undefined) return normalizeAttributes(attributes);
  }
  throw new Error(
    `Attributes file ${file} must be an array or an object with "attributes".`,
  );
}

function assertItemName(name: string): void {
  if (byteLength(name) > LIMITS.name) {
    throw new Error(
      `Item name "${name}" is ${byteLength(name)} bytes; Metaplex allows at most ${LIMITS.name}.`,
    );
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item"
  );
}

async function rentPerItemSol(): Promise<number> {
  try {
    const sizes = Object.values(RENT_SIZES);
    const rent = await Promise.all(
      sizes.map((size) => connection.getMinimumBalanceForRentExemption(size)),
    );
    return rent.reduce((sum, value) => sum + value, 0) / lamportsPerSol;
  } catch {
    return FALLBACK_RENT_PER_ITEM;
  }
}

/** Reads a collection and refuses to mint into one this wallet does not control. */
async function loadCollection(
  umi: Umi,
  wallet: Signer,
  address: PublicKey,
) {
  const asset = await retryRpc(() => fetchDigitalAsset(umi, address));
  if (asset.metadata.updateAuthority !== wallet.publicKey) {
    throw new Error(
      `Collection ${address} is controlled by ${asset.metadata.updateAuthority}, not ${wallet.publicKey}.`,
    );
  }
  if (asset.metadata.collectionDetails.__option !== "Some") {
    throw new Error(
      `${address} is an NFT but not a collection. Create it with create:collection or isCollection.`,
    );
  }
  return asset;
}

async function assertItemOwnership(
  umi: Umi,
  mint: PublicKey,
  collection: PublicKey,
  wallet: Signer,
) {
  const asset = await retryRpc(() => fetchDigitalAsset(umi, mint));
  const verified =
    asset.metadata.collection.__option === "Some" &&
    asset.metadata.collection.value.verified &&
    asset.metadata.collection.value.key === collection;
  if (!verified) {
    throw new Error(`Mint ${mint} is not verified into the collection.`);
  }

  const ata = getAssociatedTokenAddressSync(
    new Web3PublicKey(mint),
    new Web3PublicKey(wallet.publicKey),
  );
  const balance = await retryRpc(() =>
    connection.getTokenAccountBalance(ata),
  );
  if (balance.value.amount !== "1") {
    throw new Error(
      `Mint ${mint} was not delivered to ${wallet.publicKey}; check token ownership.`,
    );
  }
  return asset;
}

/**
 * A transaction can land while the process dies before the state write. The
 * mint address is recorded before signing, so a re-run can tell the two cases
 * apart: an account on chain means the item is done, a missing account means
 * the transaction never landed and the item can be minted again.
 */
/**
 * A transaction can land while the process dies before the state write. The
 * mint address and the signed bytes are recorded before signing, so a re-run
 * can tell three cases apart: confirmed, still in flight, and expired.
 */
async function recordedStatus(signature: string) {
  const response = await retryRpc(() =>
    connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    }),
  );
  return response.value[0] ?? null;
}

/**
 * Returns true when the recorded transaction is confirmed, false when its
 * blockhash expired and it can never land. An in-flight transaction is
 * re-broadcast with the same signature and awaited, so a fast re-run never
 * creates a second mint for an item that is still settling.
 */
async function settleRecorded(
  record: SignedTransactionRecord,
): Promise<boolean> {
  const current = await recordedStatus(record.signature);
  if (current?.err) {
    throw new Error(
      `Transaction ${record.signature} failed on chain: ${JSON.stringify(current.err)}`,
    );
  }
  if (
    current?.confirmationStatus === "confirmed" ||
    current?.confirmationStatus === "finalized"
  ) {
    return true;
  }

  const height = await retryRpc(() => connection.getBlockHeight("confirmed"));
  if (height > record.lastValidBlockHeight) {
    return false;
  }

  try {
    await connection.sendRawTransaction(
      Buffer.from(record.transaction, "base64"),
      { skipPreflight: true, maxRetries: 3 },
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/already been processed|already processed/i.test(text)) throw error;
  }

  try {
    await connection.confirmTransaction(
      {
        signature: record.signature,
        blockhash: record.blockhash,
        lastValidBlockHeight: record.lastValidBlockHeight,
      },
      "confirmed",
    );
    return true;
  } catch (error) {
    const after = await recordedStatus(record.signature);
    if (after?.err) {
      throw new Error(
        `Transaction ${record.signature} failed on chain: ${JSON.stringify(after.err)}`,
      );
    }
    if (
      after?.confirmationStatus === "confirmed" ||
      after?.confirmationStatus === "finalized"
    ) {
      return true;
    }
    const now = await retryRpc(() => connection.getBlockHeight("confirmed"));
    if (now > record.lastValidBlockHeight) return false;
    throw new Error(
      `Could not settle ${record.signature}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function reconcileBatch(
  umi: Umi,
  collection: PublicKey,
  wallet: Signer,
): Promise<void> {
  const minted = new Set(
    readState()
      .nfts.filter((nft) => nft.collection === collection)
      .map((nft) => nft.name),
  );
  const unfinished = readBatchItems(collection).filter(
    (item) => item.address && !minted.has(item.name),
  );

  for (const item of unfinished) {
    const address = umiPublicKey(item.address!);

    // If the signed bytes exist, settle the exact transaction first: a fast
    // re-run must not reset a mint that is still in flight.
    if (item.signed) {
      const landed = await settleRecorded(item.signed);
      if (!landed) {
        resetBatchItem(collection, item.name);
        console.log(
          `   Pending : ${item.name} expired, it will be minted again.`,
        );
        continue;
      }
    }

    const account = await retryRpc(() =>
      connection.getAccountInfo(new Web3PublicKey(address)),
    );
    if (!account) {
      // A confirmed signature with no mint account is inconsistent. Never
      // reset it silently: that is exactly how a duplicate would be created.
      throw new Error(
        `Pending mint ${item.name} has signature ${item.signed?.signature ?? item.signature}, but ${address} does not exist. Inspect the transaction before retrying.`,
      );
    }

    // Do not trust the local record: read the mint back from the chain.
    const asset = await assertItemOwnership(umi, address, collection, wallet);
    const signature = item.signed?.signature ?? item.signature ?? "";
    saveNft({
      address,
      name: item.name,
      uri: item.metadataUri ?? asset.metadata.uri,
      signature,
      collection,
      verified: true,
      createdAt: new Date().toISOString(),
    });
    saveBatchItem(collection, {
      name: item.name,
      address: item.address,
      status: "minted",
      signature,
      signed: null,
    });
    console.log(
      `   Recovered: ${item.name} was already minted at ${item.address}.`,
    );
  }
}

/**
 * Reuses a collection whose create transaction landed before the process died.
 * Only a `pending` record with a matching name and symbol is considered, and
 * the chain must confirm both the collection flag and the wallet authority.
 */
async function recoverPendingCollection(
  umi: Umi,
  wallet: Signer,
  name?: string,
  symbol?: string,
): Promise<PublicKey | null> {
  const pending = readState().collection;
  if (!pending || pending.status !== "pending") return null;
  if (name && pending.name !== name) return null;
  if (symbol && pending.symbol !== symbol) return null;

  const address = umiPublicKey(pending.address);
  if (pending.signed) {
    const landed = await settleRecorded(pending.signed);
    if (!landed) {
      console.log(
        `\nPrevious collection ${pending.address} expired. Creating a new one.`,
      );
      return null;
    }
  }

  const account = await retryRpc(() =>
    connection.getAccountInfo(new Web3PublicKey(address)),
  );
  if (!account) {
    if (pending.signed) {
      throw new Error(
        `Collection signature ${pending.signed.signature} is confirmed, but ${pending.address} does not exist. Inspect the transaction before retrying.`,
      );
    }
    console.log(
      `\nPrevious collection ${pending.address} never landed. Creating a new one.`,
    );
    return null;
  }

  const asset = await retryRpc(() => fetchDigitalAsset(umi, address));
  if (asset.metadata.updateAuthority !== wallet.publicKey) {
    throw new Error(
      `Collection ${pending.address} from the previous run is controlled by ${asset.metadata.updateAuthority}. Refusing to reuse it.`,
    );
  }
  if (asset.metadata.collectionDetails.__option !== "Some") {
    throw new Error(
      `Collection ${pending.address} from the previous run is not a collection. Refusing to reuse it.`,
    );
  }

  saveCollection({ ...pending, status: "minted", signed: null });
  console.log(`\nRecovered collection ${pending.address} from the previous run.`);
  return address;
}

async function main(): Promise<void> {
  const flags = parseArgs();
  const manifestFlag = getString(flags, "manifest");
  if (!manifestFlag) {
    throw new Error(
      "Pass --manifest <collection.json>. See the README for the format.",
    );
  }

  const mode = resolveSignerMode(
    getString(flags, "signer", process.env.SIGNER),
  );
  if (mode === "readonly") {
    throw new Error("create:batch needs browser signing. Use --signer browser.");
  }
  if (getStorageBackend() !== "irys") {
    throw new Error(
      "create:batch needs STORAGE=irys so the metadata stays permanent. Local file URIs cannot be minted on mainnet.",
    );
  }

  const { manifest } = readManifest(manifestFlag);
  const collectionConfig = manifest.collection ?? {};
  const collectionAddress = getString(
    flags,
    "collection",
    collectionConfig.address,
  );
  const name = getString(flags, "name", collectionConfig.name);
  const symbol = getString(flags, "symbol", collectionConfig.symbol);
  const description =
    getString(flags, "description", collectionConfig.description) ?? "";
  const image = getString(flags, "image", collectionConfig.image);
  const royalty = getNumber(
    flags,
    "royalty",
    collectionConfig.royalty ?? 5,
  );
  const royaltyBps = Math.round(royalty * 100);
  const priorityFee = getNumber(flags, "priority-fee", 0);
  const dryRun = hasFlag(flags, "dry-run");
  const limit = Math.max(
    0,
    Math.floor(getNumber(flags, "limit", manifest.items.length)),
  );

  if (!collectionAddress) {
    if (!name || !symbol || !image) {
      throw new Error(
        "To create a collection, pass --name, --symbol and --image (or put a collection block in the manifest). To add to an existing one, pass --collection.",
      );
    }
    if (!existsSync(image)) {
      throw new Error(`Collection image not found: ${image}`);
    }
    assertOnChainLimits({ name, symbol });
    if (royaltyBps < 0 || royaltyBps > 10_000) {
      throw new Error("Royalty must be between 0 and 100 percent.");
    }
  }

  // Validate everything before spending a lamport.
  const prepared: PreparedItem[] = manifest.items.map((item, index) => {
    assertItemName(item.name);
    if (!existsSync(item.image)) {
      throw new Error(`Item ${index + 1} image not found: ${item.image}`);
    }
    return { ...item, attributes: loadAttributes(item.attributesFile) };
  });
  if (prepared.length === 0) {
    throw new Error("The manifest has no items.");
  }

  // Item names are the resume key, so a duplicate would be silently skipped.
  const names = new Set<string>();
  for (const item of prepared) {
    if (names.has(item.name)) {
      throw new Error(
        `Duplicate item name "${item.name}". Names must be unique: they are how a re-run knows what is already minted.`,
      );
    }
    names.add(item.name);
  }

  const perItemRent = await rentPerItemSol();
  const planned = Math.min(prepared.length, limit);

  if (dryRun) {
    console.log("\nBatch dry run, nothing was uploaded or minted");
    console.log(`   Cluster    : ${cluster} (${rpcUrl})`);
    if (collectionAddress) {
      console.log(`   Collection : ${collectionAddress} (existing)`);
    } else {
      console.log(`   Collection : ${name} [${symbol}], ${royalty}% royalty`);
      console.log(`   Image      : ${image}`);
    }
    console.log(`   Items      : ${planned} of ${prepared.length}`);
    console.log(
      `   Rent (est.): ${(perItemRent * planned + (collectionAddress ? 0 : perItemRent)).toFixed(3)} SOL`,
    );
    console.log(
      "   Storage    : charged to your connected browser wallet through Irys",
    );
    console.log(`   State      : ${stateFile()}`);
    console.log("\nItems");
    prepared.slice(0, planned).forEach((item, index) => {
      console.log(
        `   ${String(index + 1).padStart(2)}. ${item.name} (${item.attributes.length} traits, ${byteLength(item.name)} bytes)`,
      );
    });
    console.log(
      "\nNo file was read from the network and no wallet was opened. Remove --dry-run to run it.",
    );
    return;
  }

  if (cluster === "mainnet-beta" && !hasFlag(flags, "mainnet")) {
    throw new Error(
      [
        "This is mainnet and the collection costs real SOL.",
        "Run the same manifest on devnet first, check the result, then repeat with --mainnet.",
        "Example: SOLANA_CLUSTER=devnet npx esrun@3.2.30 src/commands/create-batch.ts --manifest collection.json",
      ].join("\n"),
    );
  }

  const umi = await createProjectUmi({
    signer: "browser",
    browserAction: "batch",
  });
  const wallet: Signer = umi.identity;
  setWallet(wallet.publicKey);

  function withFee(builder: ReturnType<typeof transactionBuilder>) {
    if (priorityFee <= 0) return builder;
    return transactionBuilder()
      .add(
        setComputeUnitPrice(umi, {
          microLamports: Math.round(priorityFee),
        }),
      )
      .add(builder);
  }

  let collectionKey: PublicKey | null = collectionAddress
    ? umiPublicKey(collectionAddress)
    : null;
  let collectionSymbol: string;
  let itemRoyaltyBps = royaltyBps;

  // A collection that landed but was never recorded is reused, not recreated.
  if (!collectionKey) {
    collectionKey = await recoverPendingCollection(umi, wallet, name, symbol);
  }

  let collectionAsset: Awaited<ReturnType<typeof loadCollection>> | null = null;
  if (collectionKey) {
    // Validate before reconciling: never write state for a collection this
    // wallet does not control.
    collectionAsset = await loadCollection(umi, wallet, collectionKey);
    // A mint that landed but was never recorded is kept, not minted twice.
    await reconcileBatch(umi, collectionKey, wallet);
  }

  // Items already minted into this collection are skipped, so a failed run
  // resumes without paying for the same Arweave uploads twice.
  const done = new Set(
    collectionKey
      ? readState()
          .nfts.filter((nft) => nft.collection === collectionKey)
          .map((nft) => nft.name)
      : [],
  );
  const cached = new Map(
    (collectionKey ? readBatchItems(collectionKey) : []).map((item) => [
      item.name,
      item,
    ]),
  );
  const remaining = prepared.filter((item) => !done.has(item.name));
  const pending = remaining.slice(0, limit);
  const skipped = prepared.length - remaining.length;
  const deferred = remaining.length - pending.length;

  console.log("\nBatch creation");
  console.log(`   Cluster    : ${cluster} (${rpcUrl})`);
  console.log(`   Wallet     : ${wallet.publicKey}`);
  console.log(`   Items      : ${pending.length} to mint, ${skipped} already done`);
  if (deferred > 0) {
    console.log(`   Deferred   : ${deferred} beyond --limit, run again for them`);
  }
  console.log(`   State      : ${stateFile()}`);
  console.log(
    `   Approvals  : browser wallet upload signatures plus one transaction per item`,
  );

  if (pending.length === 0) {
    console.log("\nNothing to do. Every item in the manifest is already minted.");
    return;
  }

  let minted = 0;

  try {
    if (collectionKey && collectionAsset) {
      collectionSymbol = collectionAsset.metadata.symbol;
      itemRoyaltyBps = collectionAsset.metadata.sellerFeeBasisPoints;
      saveCollection({
        address: collectionKey,
        name: collectionAsset.metadata.name,
        symbol: collectionAsset.metadata.symbol,
        uri: collectionAsset.metadata.uri,
        signature: stateSignature(collectionKey),
        createdAt: new Date().toISOString(),
      });
      console.log(`\nAdding to collection ${collectionKey}`);
    } else {
      console.log(`\nUploading collection image ${path.basename(image!)}`);
      const imageFile = await fileFor(image!);
      const [imageUri] = await umi.uploader.upload([imageFile]);
      const metadata = buildOffchainMetadata({
        name: name!,
        symbol: symbol!,
        description,
        imageUri,
        imageContentType: imageFile.contentType ?? "image/webp",
      });
      const uri = await umi.uploader.uploadJson(metadata);
      assertOnChainLimits({ name: name!, symbol: symbol!, uri });

      const collectionMint = generateSigner(umi);
      const address = collectionMint.publicKey;
      collectionKey = address;
      collectionSymbol = symbol!;
      const createdAt = new Date().toISOString();

      // Record the intent before signing. If this process dies after the
      // collection lands, the next run reuses this address instead of creating
      // a second collection.
      saveCollection({
        address,
        name: name!,
        symbol: symbol!,
        uri,
        signature: "",
        createdAt,
        status: "pending",
        signed: null,
      });

      console.log(`\nCreating collection ${address}`);
      const signature = await sendAndConfirm(
        umi,
        withFee(
          createNft(umi, {
            mint: collectionMint,
            name: name!,
            symbol: symbol!,
            uri,
            sellerFeeBasisPoints: percentAmount(royaltyBps / 100),
            updateAuthority: wallet.publicKey,
            tokenOwner: wallet.publicKey,
            creators: some([
              { address: wallet.publicKey, verified: true, share: 100 },
            ]),
            isCollection: true,
          }),
        ),
        {
          onSigned: (record) =>
            saveCollection({
              address,
              name: name!,
              symbol: symbol!,
              uri,
              signature: record.signature,
              createdAt,
              status: "pending",
              signed: record,
            }),
        },
      );

      saveCollection({
        address,
        name: name!,
        symbol: symbol!,
        uri,
        signature,
        createdAt,
        status: "minted",
        signed: null,
      });
      console.log(`   Collection : ${collectionKey}`);
      console.log(`   Explorer   : ${explorerAddressUrl(collectionKey)}`);
    }

    // Two uploads instead of two per item: one bundle of art, one of JSON.
    const needImage = pending.filter((item) => !cached.get(item.name)?.imageUri);
    if (needImage.length > 0) {
      console.log(
        `\nUploading ${needImage.length} images in one bundle. This is the Arweave payment.`,
      );
      const files = await Promise.all(needImage.map((item) => fileFor(item.image)));
      const uris = await umi.uploader.upload(files);
      needImage.forEach((item, index) => {
        saveBatchItem(collectionKey!, {
          name: item.name,
          imageUri: uris[index],
        });
        const entry = cached.get(item.name) ?? { name: item.name };
        entry.imageUri = uris[index];
        cached.set(item.name, entry);
      });
      console.log(`   ${needImage.length} images stored`);
    }

    const needMetadata = pending.filter(
      (item) => !cached.get(item.name)?.metadataUri,
    );
    if (needMetadata.length > 0) {
      console.log(
        `\nUploading ${needMetadata.length} metadata files in one bundle.`,
      );
      const files: GenericFile[] = needMetadata.map((item) => {
        const imageUri = cached.get(item.name)?.imageUri;
        if (!imageUri) {
          throw new Error(`Missing image URI for ${item.name}. Re-run the batch.`);
        }
        const metadata = buildOffchainMetadata({
          name: item.name,
          symbol: collectionSymbol,
          description: item.description ?? description,
          imageUri,
          imageContentType: contentTypeFor(item.image),
          attributes: item.attributes,
        });
        return createGenericFileFromJson(
          metadata,
          `${slug(item.name)}.json`,
        );
      });
      const uris = await umi.uploader.upload(files);
      needMetadata.forEach((item, index) => {
        assertOnChainLimits({
          name: item.name,
          symbol: collectionSymbol,
          uri: uris[index],
        });
        saveBatchItem(collectionKey!, {
          name: item.name,
          metadataUri: uris[index],
        });
        const entry = cached.get(item.name) ?? { name: item.name };
        entry.metadataUri = uris[index];
        cached.set(item.name, entry);
      });
      console.log(`   ${needMetadata.length} metadata files stored`);
    }

    let index = 0;
    for (const item of pending) {
      index += 1;
      const imageUri = cached.get(item.name)?.imageUri;
      const metadataUri = cached.get(item.name)?.metadataUri;
      if (!imageUri || !metadataUri) {
        throw new Error(`Uploads for ${item.name} are incomplete. Re-run.`);
      }

      console.log(`\n[${index}/${pending.length}] ${item.name}`);
      const mint = generateSigner(umi);
      const itemMetadata = findMetadataPda(umi, { mint: mint.publicKey });
      const create = createNft(umi, {
        mint,
        name: item.name,
        symbol: collectionSymbol,
        uri: metadataUri,
        sellerFeeBasisPoints: percentAmount(itemRoyaltyBps / 100),
        updateAuthority: wallet.publicKey,
        tokenOwner: wallet.publicKey,
        creators: some([
          { address: wallet.publicKey, verified: true, share: 100 },
        ]),
        collection: { key: collectionKey, verified: false },
      });
      const verify = verifyCollectionV1(umi, {
        metadata: itemMetadata,
        collectionMint: collectionKey,
        authority: wallet,
      });

      // Record the address before signing, so a crash after broadcast can be
      // reconciled instead of minting the same item twice.
      saveBatchItem(collectionKey, {
        name: item.name,
        address: mint.publicKey,
        status: "pending",
        signed: null,
      });

      // Mint and verify in one transaction. The wallet owns the token and is
      // the update authority, so no temporary key or authority handoff exists.
      const signature = await sendAndConfirm(
        umi,
        withFee(transactionBuilder().add(create).add(verify)),
        {
          onSigned: (record) =>
            saveBatchItem(collectionKey!, {
              name: item.name,
              address: mint.publicKey,
              status: "pending",
              signed: record,
            }),
        },
      );

      await assertItemOwnership(umi, mint.publicKey, collectionKey, wallet);

      saveNft({
        address: mint.publicKey,
        name: item.name,
        uri: metadataUri,
        signature,
        collection: collectionKey,
        verified: true,
        createdAt: new Date().toISOString(),
      });
      saveBatchItem(collectionKey, {
        name: item.name,
        address: mint.publicKey,
        signature,
        status: "minted",
        signed: null,
      });
      minted += 1;
      console.log(`   Mint      : ${mint.publicKey}`);
      console.log(`   Explorer  : ${explorerAddressUrl(mint.publicKey)}`);
      // Public devnet RPC rate-limits bursts. A short gap keeps a larger run
      // under the limit; `sendAndConfirm` retries anything that still gets 429.
      if (index < pending.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Read one mint back so the run ends on chain state, not on a log line.
    const sample = readState().nfts.find(
      (nft) => nft.collection === collectionKey,
    );
    if (sample) {
      const asset = await retryRpc(() =>
        fetchDigitalAsset(umi, umiPublicKey(sample.address)),
      );
      const verified =
        asset.metadata.collection.__option === "Some" &&
        asset.metadata.collection.value.verified;
      if (!verified) {
        throw new Error(
          `Mint ${sample.address} is on chain but not verified. Run npm run verify.`,
        );
      }
      console.log("\nOn-chain check: collection membership is verified.");
    }

    console.log(`\nBatch complete: ${minted} minted`);
    console.log(`   Collection : ${explorerAddressUrl(collectionKey!)}`);
    console.log(`   State      : ${stateFile()}`);
  } catch (error) {
    console.error(
      [
        `\nStopped after ${minted} of ${pending.length} items.`,
        "Uploads that already succeeded are cached in state.",
        "Pending mints are reconciled on the next run: an item that landed is kept, one that did not is minted again.",
        collectionKey
          ? `Resume with: npx esrun@3.2.30 src/commands/create-batch.ts --manifest ${manifestFlag} --collection ${collectionKey}`
          : `Resume with: npx esrun@3.2.30 src/commands/create-batch.ts --manifest ${manifestFlag} --collection <address printed above>`,
      ].join("\n"),
    );
    throw error;
  }
}

/** Keep the previous collection signature when adding to an existing one. */
function stateSignature(address: string): string {
  const collection = readState().collection;
  return collection && collection.address === address ? collection.signature : "";
}

async function fileFor(filePath: string): Promise<GenericFile> {
  const buffer = await readFile(filePath);
  return createGenericFile(buffer, path.basename(filePath), {
    contentType: contentTypeFor(filePath),
  });
}

await main();
