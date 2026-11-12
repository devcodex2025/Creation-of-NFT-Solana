import {
  generateSigner,
  percentAmount,
  publicKey as umiPublicKey,
} from "@metaplex-foundation/umi";
import {
  createNft,
  fetchDigitalAsset,
  findMetadataPda,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  getNumber,
  getString,
  hasFlag,
  parseArgs,
} from "../lib/args";
import { cluster, explorerAddressUrl, explorerTxUrl, rpcUrl } from "../lib/config";
import {
  assertOnChainLimits,
  buildOffchainMetadata,
  loadMetadataTemplate,
  normalizeAttributes,
  parseAttributesInput,
  parseRoyaltyBps,
  readJsonFile,
} from "../lib/metadata";
import { readState, saveNft, setWallet } from "../lib/state";
import { sendAndConfirm } from "../lib/tx";
import { uploadAsset, uploadMetadata } from "../lib/upload";
import { createProjectUmi, getStorageBackend, resolveSignerMode } from "../lib/umi";

const flags = parseArgs();
const template = loadMetadataTemplate(getString(flags, "json"));
const state = readState();

const name = getString(flags, "name", template.name);
if (!name) {
  throw new Error(
    'Missing --name. Example: npm run create:nft -- --name "Lil Turtle #1" --image assets/lil_turtle.avif',
  );
}

const collectionAddress =
  getString(flags, "collection") ?? state.collection?.address;
if (!collectionAddress) {
  throw new Error(
    "No collection address. Create one first with `npm run create:collection`, " +
      "or pass --collection <mint address>.",
  );
}

const symbol =
  getString(flags, "symbol", template.symbol) ??
  state.collection?.symbol ??
  "LIL";
const description =
  getString(flags, "description", template.description) ?? "";
const image =
  getString(flags, "image", template.image) ?? "assets/lil_turtle.avif";
const externalUrl = getString(flags, "external-url", template.external_url);
const attributesFile = getString(flags, "attributes-file");
const attributes = attributesFile
  ? normalizeAttributes(readJsonFile(attributesFile))
  : parseAttributesInput(getString(flags, "attributes")) ??
    normalizeAttributes(template.attributes);
const royaltyBps = getString(flags, "royalty-bps") !== undefined
  ? parseRoyaltyBps(getString(flags, "royalty-bps"))
  : parseRoyaltyBps(Math.round(getNumber(flags, "royalty", 0) * 100));
const shouldVerify = !hasFlag(flags, "skip-verify");

assertOnChainLimits({ name, symbol });

const umi = await createProjectUmi({
  keypairPath: getString(flags, "keypair"),
  signer: resolveSignerMode(getString(flags, "signer", process.env.SIGNER)),
});

// Preflight: never mint against a collection that does not exist on this
// cluster (a common failure after switching clusters or resetting a validator).
const collectionKey = umiPublicKey(collectionAddress);
const collectionAsset = await fetchDigitalAsset(umi, collectionKey).catch(
  () => null,
);

if (!collectionAsset) {
  throw new Error(
    `Collection ${collectionAddress} was not found on ${cluster}. ` +
      "Create it first or pass the right --collection address.",
  );
}

if (collectionAsset.metadata.collectionDetails.__option !== "Some") {
  throw new Error(
    `${collectionAddress} is an NFT but not a collection parent. ` +
      "Create it with `npm run create:collection` (isCollection: true).",
  );
}

if (
  shouldVerify &&
  collectionAsset.metadata.updateAuthority !== umi.identity.publicKey
) {
  throw new Error(
    `Wallet ${umi.identity.publicKey} is not the update authority of collection ${collectionAddress}. ` +
      `The authority is ${collectionAsset.metadata.updateAuthority}. ` +
      "Mint with the authority wallet, pass --skip-verify and verify later, or use a collection you control.",
  );
}

console.log(`\n🖼️  Minting NFT into collection`);
console.log(`   Cluster    : ${cluster} (${rpcUrl})`);
console.log(`   Wallet     : ${umi.identity.publicKey}`);
console.log(`   Collection : ${collectionAddress}`);
console.log(`   Storage    : ${getStorageBackend() === "irys" ? "Irys → Arweave" : "local (dev only)"}`);
console.log(`   Name       : ${name} [${symbol}]`);

setWallet(umi.identity.publicKey);

console.log(`\n⬆️  Uploading image ${image}…`);
const uploadedImage = await uploadAsset(umi, image);
console.log(`   ${uploadedImage.uri}`);

const offchainMetadata = buildOffchainMetadata({
  name,
  symbol,
  description,
  imageUri: uploadedImage.uri,
  imageContentType: uploadedImage.contentType,
  externalUrl,
  attributes,
});

console.log(`⬆️  Uploading metadata JSON…`);
const uri = await uploadMetadata(umi, offchainMetadata);
console.log(`   ${uri}`);
assertOnChainLimits({ name, symbol, uri });

const mint = generateSigner(umi);

console.log(`\n⛓️  Sending mint transaction…`);
const signature = await sendAndConfirm(
  umi,
  createNft(umi, {
    mint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints: percentAmount(royaltyBps / 100),
    updateAuthority: umi.identity.publicKey,
    collection: {
      key: umiPublicKey(collectionAddress),
      verified: false,
    },
  }),
);

let asset = await fetchDigitalAsset(umi, mint.publicKey);
let verified = false;

if (shouldVerify) {
  console.log(`\n🔏  Verifying collection membership…`);
  const verifySignature = await sendAndConfirm(
    umi,
    verifyCollectionV1(umi, {
      metadata: findMetadataPda(umi, { mint: mint.publicKey }),
      collectionMint: umiPublicKey(collectionAddress),
      authority: umi.identity,
    }),
  );
  console.log(`   Verification tx: ${verifySignature}`);

  asset = await fetchDigitalAsset(umi, mint.publicKey);
  verified = asset.metadata.collection.__option === "Some" &&
    asset.metadata.collection.value.verified;

  if (!verified) {
    throw new Error(
      "Collection verification transaction confirmed, but the NFT is still unverified. " +
        `Check that the wallet ${umi.identity.publicKey} is the update authority of ${collectionAddress}.`,
    );
  }
}

saveNft({
  address: mint.publicKey,
  name: asset.metadata.name,
  uri: asset.metadata.uri,
  signature,
  collection: collectionAddress,
  verified,
  createdAt: new Date().toISOString(),
});

console.log(`\n✅ NFT minted${verified ? " and verified" : ""}`);
console.log(`   Mint      : ${mint.publicKey}`);
console.log(`   Signature : ${signature}`);
console.log(`   Explorer  : ${explorerAddressUrl(mint.publicKey)}`);
console.log(`   Tx        : ${explorerTxUrl(signature)}`);
console.log(`   Metadata  : ${uri}\n`);
