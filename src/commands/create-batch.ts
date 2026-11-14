import {
  createGenericFile,
  createGenericFileFromJson,
  createSignerFromKeypair,
  generateSigner,
  keypairIdentity,
  lamports,
  percentAmount,
  publicKey as umiPublicKey,
  signerIdentity,
  sol,
  some,
  transactionBuilder,
  type GenericFile,
  type PublicKey,
  type Signer,
  type TransactionBuilder,
  type Umi,
} from "@metaplex-foundation/umi";
import {
  MetadataDelegateRole,
  TokenStandard,
  createNft,
  delegateCollectionV1,
  fetchDigitalAsset,
  findMetadataDelegateRecordPda,
  findMetadataPda,
  revokeCollectionV1,
  updateMetadataAccountV2,
  verifyCollectionV1,
  verifyCreatorV1,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  setComputeUnitPrice,
  transferSol,
} from "@metaplex-foundation/mpl-toolbox";
import { toWeb3JsTransaction } from "@metaplex-foundation/umi-web3js-adapters";
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
  saveBatchItem,
  saveCollection,
  saveNft,
  setWallet,
  stateFile,
} from "../lib/state";
import { sendAndConfirm } from "../lib/tx";
import { contentTypeFor } from "../lib/upload";
import {
  createProjectUmi,
  getStorageBackend,
  resolveSignerMode,
} from "../lib/umi";

/**
 * Batch creation keeps wallet approvals down to three (fund, delegate, revoke)
 * by moving uploads and mints to a temporary key that lives in memory only.
 * Uploads go out as two bundles, and each mint and its verification share one
 * transaction, so a collection of 24 items costs 24 mint transactions instead
 * of 72 signatures.
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "item";
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
    throw new Error("create:batch needs a signer. Use browser or keypair.");
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
  const limit = Math.max(0, Math.floor(getNumber(flags, "limit", manifest.items.length)));

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
      throw new Error(
        `Item ${index + 1} image not found: ${item.image}`,
      );
    }
    return { ...item, attributes: loadAttributes(item.attributesFile) };
  });
  if (prepared.length === 0) {
    throw new Error("The manifest has no items.");
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
      "   Storage    : charged to the temporary key, usually a few thousandths of a SOL",
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
        "Example: SOLANA_CLUSTER=devnet npm run create:batch -- --manifest collection.json",
      ].join("\n"),
    );
  }

  const umi: Umi = await createProjectUmi({
    keypairPath: getString(flags, "keypair"),
    signer: mode,
    browserAction: "batch",
  });
  const wallet: Signer = umi.identity;
  setWallet(wallet.publicKey);

  const useTemporaryKey = mode === "browser";
  const temporaryKeypair = umi.eddsa.generateKeypair();
  const temporary: Signer = createSignerFromKeypair(umi, temporaryKeypair);
  const session = useTemporaryKey ? temporary : wallet;

  function useWallet(): void {
    umi.use(signerIdentity(wallet));
  }

  function useSession(): void {
    if (useTemporaryKey) umi.use(keypairIdentity(temporaryKeypair));
    else useWallet();
  }

  function withFee(builder: TransactionBuilder): TransactionBuilder {
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
  let delegated = false;
  let revoked = false;

  /**
   * Collection verification is authorised by a `Collection` metadata delegate,
   * not by the legacy `CollectionAuthorityRecord`. `verifyCollectionV1` looks up
   * a `MetadataDelegateRecord` PDA, so the delegate has to be created with
   * `delegateCollectionV1`.
   */
  function delegateRecord() {
    if (!collectionKey) throw new Error("No collection to delegate.");
    return findMetadataDelegateRecordPda(umi, {
      mint: collectionKey,
      delegateRole: MetadataDelegateRole.Collection,
      updateAuthority: wallet.publicKey,
      delegate: session.publicKey,
    })[0];
  }

  async function revokeDelegation(): Promise<void> {
    if (!useTemporaryKey || !delegated || revoked || !collectionKey) return;
    const record = delegateRecord();
    useWallet();
    await sendAndConfirm(
      umi,
      withFee(
        revokeCollectionV1(umi, {
          delegateRecord: record,
          delegate: session.publicKey,
          mint: collectionKey,
          authority: wallet,
          tokenStandard: TokenStandard.NonFungible,
        }),
      ),
    );
    revoked = true;
    delegated = false;
    console.log("   Batch authority revoked.");
  }

  /**
   * The wallet is the item creator, so only the wallet can mark that creator as
   * verified. Twenty items fit in one transaction, which keeps the extra
   * approvals to one per twenty items.
   */
  async function verifyItemCreators(address: PublicKey): Promise<void> {
    const addresses = readState()
      .nfts.filter((nft) => nft.collection === address)
      .map((nft) => nft.address);
    if (addresses.length === 0) {
      console.log("No minted items in state for this collection.");
      return;
    }
    const chunkSize = 20;
    for (let start = 0; start < addresses.length; start += chunkSize) {
      const chunk = addresses.slice(start, start + chunkSize);
      let builder = transactionBuilder();
      for (const mint of chunk) {
        builder = builder.add(
          verifyCreatorV1(umi, {
            metadata: findMetadataPda(umi, { mint: umiPublicKey(mint) }),
            authority: wallet,
          }),
        );
      }
      console.log(
        `\nVerifying the creator on ${chunk.length} items. Approve in the browser.`,
      );
      await sendAndConfirm(umi, withFee(builder));
    }
    console.log("   Creator verified on every item.");
  }

  async function sweep(): Promise<void> {
    if (!useTemporaryKey) return;
    useSession();
    const balance = await umi.rpc.getBalance(session.publicKey);
    if (balance.basisPoints === 0n) return;

    const withAmount = (amount: bigint) =>
      transactionBuilder().add(
        transferSol(umi, {
          source: temporary,
          destination: wallet.publicKey,
          amount: lamports(amount),
        }),
      );

    // The batch key has to end at zero, or the runtime rejects the transfer
    // for leaving a non rent-exempt account behind.
    let fee = 5_000n;
    try {
      const probe = await withAmount(0n).setLatestBlockhash(umi);
      const quote = await connection.getFeeForMessage(
        toWeb3JsTransaction(probe.build(umi)).message,
        "confirmed",
      );
      if (quote.value !== null) fee = BigInt(quote.value);
    } catch {
      // Keep the base fee if the fee quote is unavailable.
    }

    if (balance.basisPoints <= fee) {
      console.log(
        `   Batch key keeps ${balance.basisPoints} lamports, below the network fee.`,
      );
      return;
    }

    const amount = balance.basisPoints - fee;
    await sendAndConfirm(umi, withAmount(amount));
    console.log(
      `   Returned ${(Number(amount) / lamportsPerSol).toFixed(4)} SOL to the wallet.`,
    );
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
  const pending = prepared
    .filter((item) => !done.has(item.name))
    .slice(0, limit);
  const skipped = prepared.length - pending.length;

  console.log("\nBatch creation");
  console.log(`   Cluster    : ${cluster} (${rpcUrl})`);
  console.log(`   Wallet     : ${wallet.publicKey}`);
  if (useTemporaryKey) {
    console.log(`   Batch key  : ${session.publicKey} (memory only)`);
  }
  console.log(`   Items      : ${pending.length} to mint, ${skipped} already done`);
  console.log(`   State      : ${stateFile()}`);
  if (useTemporaryKey) {
    console.log(
      `   Approvals  : ${collectionAddress ? 2 : 3} in the browser wallet`,
    );
    if (hasFlag(flags, "verify-creators")) {
      console.log(
        `   Creators   : plus one approval per 20 items to verify the creator`,
      );
    }
  }

  const creatorFlag = useTemporaryKey && hasFlag(flags, "verify-creators");

  if (pending.length === 0) {
    console.log("\nNothing to do. Every item in the manifest is already minted.");
    if (!creatorFlag || !collectionKey) return;
    useWallet();
    await verifyItemCreators(collectionKey);
    return;
  }

  const fundFlag = getNumber(flags, "fund", 0);
  const funding =
    fundFlag > 0
      ? fundFlag
      : Math.round((0.05 + pending.length * 0.016) * 1000) / 1000;
  let minted = 0;
  let completed = false;

  try {
    if (useTemporaryKey) {
      useWallet();
      console.log(
        `\n[1/3] Funding the batch key with ${funding} SOL. Approve in the browser.`,
      );
      await sendAndConfirm(
        umi,
        withFee(
          transactionBuilder().add(
            transferSol(umi, {
              source: wallet,
              destination: session.publicKey,
              amount: sol(funding),
            }),
          ),
        ),
      );
    }

    // Uploads are paid by the batch key, so the collection image goes out
    // before the wallet signs anything else.
    useSession();

    let collectionSymbol: string;
    let itemRoyaltyBps = royaltyBps;
    if (collectionKey) {
      const asset = await fetchDigitalAsset(umi, collectionKey);
      if (asset.metadata.updateAuthority !== wallet.publicKey) {
        throw new Error(
          `Collection ${collectionKey} is controlled by ${asset.metadata.updateAuthority}, not ${wallet.publicKey}.`,
        );
      }
      if (asset.metadata.collectionDetails.__option !== "Some") {
        throw new Error(
          `${collectionKey} is an NFT but not a collection. Create it with create:collection or isCollection.`,
        );
      }
      collectionSymbol = asset.metadata.symbol;
      itemRoyaltyBps = asset.metadata.sellerFeeBasisPoints;
      saveCollection({
        address: collectionKey,
        name: asset.metadata.name,
        symbol: asset.metadata.symbol,
        uri: asset.metadata.uri,
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
      collectionKey = collectionMint.publicKey;
      collectionSymbol = symbol!;

      // The wallet creates the collection, which lets it mark itself as a
      // verified creator, and delegates collection verification to the batch
      // key in the same transaction. That is one approval for both steps.
      useWallet();
      console.log(
        `\n[2/3] Creating collection ${collectionKey} and delegating verification. Approve in the browser.`,
      );
      const signature = await sendAndConfirm(
        umi,
        withFee(
          useTemporaryKey
            ? transactionBuilder()
                .add(
                  createNft(umi, {
                    mint: collectionMint,
                    name: name!,
                    symbol: symbol!,
                    uri,
                    sellerFeeBasisPoints: percentAmount(royaltyBps / 100),
                    updateAuthority: wallet.publicKey,
                    creators: some([
                      { address: wallet.publicKey, verified: true, share: 100 },
                    ]),
                    isCollection: true,
                  }),
                )
                .add(
                  delegateCollectionV1(umi, {
                    delegateRecord: delegateRecord(),
                    delegate: session.publicKey,
                    mint: collectionKey,
                    authority: wallet,
                    tokenStandard: TokenStandard.NonFungible,
                  }),
                )
            : createNft(umi, {
                mint: collectionMint,
                name: name!,
                symbol: symbol!,
                uri,
                sellerFeeBasisPoints: percentAmount(royaltyBps / 100),
                updateAuthority: wallet.publicKey,
                creators: some([
                  { address: wallet.publicKey, verified: true, share: 100 },
                ]),
                isCollection: true,
              }),
        ),
      );
      if (useTemporaryKey) delegated = true;

      saveCollection({
        address: collectionKey,
        name: name!,
        symbol: symbol!,
        uri,
        signature,
        createdAt: new Date().toISOString(),
      });
      console.log(`   Collection : ${collectionKey}`);
      console.log(`   Explorer   : ${explorerAddressUrl(collectionKey)}`);
    }

    // An existing collection only needs the delegate, not a create.
    if (useTemporaryKey && !delegated) {
      useWallet();
      console.log(
        "\n[1/2] Delegating collection verification to the batch key. Approve in the browser.",
      );
      await sendAndConfirm(
        umi,
        withFee(
          delegateCollectionV1(umi, {
            delegateRecord: delegateRecord(),
            delegate: session.publicKey,
            mint: collectionKey!,
            authority: wallet,
            tokenStandard: TokenStandard.NonFungible,
          }),
        ),
      );
      delegated = true;
    }

    useSession();

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
        updateAuthority: useTemporaryKey ? session.publicKey : wallet.publicKey,
        creators: some([
          {
            address: wallet.publicKey,
            verified: !useTemporaryKey,
            share: 100,
          },
        ]),
        collection: { key: collectionKey, verified: false },
      });
      const verify = verifyCollectionV1(
        umi,
        useTemporaryKey
          ? {
              metadata: itemMetadata,
              collectionMint: collectionKey,
              delegateRecord: delegateRecord(),
              authority: session,
            }
          : {
              metadata: itemMetadata,
              collectionMint: collectionKey,
              authority: wallet,
            },
      );
      // Mint, verify and hand the item to the wallet in one transaction, so a
      // batch of 24 costs 24 signatures instead of 72.
      const signature = await sendAndConfirm(
        umi,
        withFee(
          useTemporaryKey
            ? transactionBuilder()
                .add(create)
                .add(verify)
                .add(
                  updateMetadataAccountV2(umi, {
                    metadata: itemMetadata,
                    newUpdateAuthority: wallet.publicKey,
                  }),
                )
            : transactionBuilder().add(create).add(verify),
        ),
      );

      saveNft({
        address: mint.publicKey,
        name: item.name,
        uri: metadataUri,
        signature,
        collection: collectionKey,
        verified: true,
        createdAt: new Date().toISOString(),
      });
      saveBatchItem(collectionKey!, {
        name: item.name,
        address: mint.publicKey,
        signature,
      });
      minted += 1;
      console.log(`   Mint      : ${mint.publicKey}`);
      console.log(`   Explorer  : ${explorerAddressUrl(mint.publicKey)}`);
    }

    // Read one mint back so the run ends on chain state, not on a log line.
    const sample = readState().nfts.find(
      (nft) => nft.collection === collectionKey,
    );
    if (sample) {
      const asset = await fetchDigitalAsset(
        umi,
        umiPublicKey(sample.address),
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

    // The wallet is the item creator, so only the wallet can mark that creator
    // as verified.
    if (useTemporaryKey && hasFlag(flags, "verify-creators")) {
      useWallet();
      await verifyItemCreators(collectionKey!);
    }

    if (useTemporaryKey) {
      useWallet();
      console.log("\n[3/3] Revoking the batch key. Approve in the browser.");
      await revokeDelegation();
    }

    await sweep();

    completed = true;
    console.log(`\nBatch complete: ${minted} minted`);
    console.log(`   Collection : ${explorerAddressUrl(collectionKey!)}`);
    console.log(`   State      : ${stateFile()}`);
  } finally {
    try {
      await revokeDelegation();
    } catch (error) {
      console.error(
        `\nCould not revoke the batch authority. Revoke ${session.publicKey} manually from the collection update authority.`,
        error,
      );
    }
    try {
      await sweep();
    } catch (error) {
      console.error(
        `\nCould not return the batch key balance. Its address is ${session.publicKey}.`,
        error,
      );
    }
    if (!completed) {
      console.error(
        [
          `\nStopped after ${minted} of ${pending.length} items.`,
          "Uploads that already succeeded are cached in state.",
          collectionKey
            ? `Resume with: npm run create:batch -- --manifest ${manifestFlag} --collection ${collectionKey}`
            : `Resume with: npm run create:batch -- --manifest ${manifestFlag} --collection <address printed above>`,
        ].join("\n"),
      );
    }
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
