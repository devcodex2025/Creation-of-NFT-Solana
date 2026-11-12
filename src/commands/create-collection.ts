import { generateSigner, percentAmount } from "@metaplex-foundation/umi";
import {
  createNft,
  fetchDigitalAsset,
} from "@metaplex-foundation/mpl-token-metadata";
import { getNumber, getString, parseArgs } from "../lib/args";
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
import { saveCollection, setWallet } from "../lib/state";
import { sendAndConfirm } from "../lib/tx";
import { uploadAsset, uploadMetadata } from "../lib/upload";
import { createProjectUmi, getStorageBackend } from "../lib/umi";

const flags = parseArgs();
const template = loadMetadataTemplate(getString(flags, "json"));

const name = getString(flags, "name", template.name) ?? "Lil Turtle Collection";
const symbol = getString(flags, "symbol", template.symbol) ?? "LIL";
const description =
  getString(flags, "description", template.description) ??
  "A collection of cute lil turtle NFTs.";
const image = getString(flags, "image", template.image) ??
  "assets/lil_turtle_collection.webp";
const externalUrl = getString(flags, "external-url", template.external_url);
const royaltyBps = getString(flags, "royalty-bps") !== undefined
  ? parseRoyaltyBps(getString(flags, "royalty-bps"))
  : parseRoyaltyBps(Math.round(getNumber(flags, "royalty", 0) * 100));
const attributesFile = getString(flags, "attributes-file");
const attributes = attributesFile
  ? normalizeAttributes(readJsonFile(attributesFile))
  : parseAttributesInput(getString(flags, "attributes")) ??
    normalizeAttributes(template.attributes);

assertOnChainLimits({ name, symbol });

const umi = createProjectUmi(getString(flags, "keypair"));
const wallet = umi.identity.publicKey;

console.log(`\n🪙  Creating collection NFT`);
console.log(`   Cluster : ${cluster} (${rpcUrl})`);
console.log(`   Wallet  : ${wallet}`);
console.log(`   Storage : ${getStorageBackend() === "irys" ? "Irys → Arweave" : "local (dev only)"}`);
console.log(`   Name    : ${name} [${symbol}]`);

setWallet(wallet);
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

const collectionMint = generateSigner(umi);

console.log(`\n⛓️  Minting collection on-chain…`);
const signature = await sendAndConfirm(
  umi,
  createNft(umi, {
    mint: collectionMint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints: percentAmount(royaltyBps / 100),
    isCollection: true,
  }),
);

// Confirm the collection actually landed on-chain before recording it.
const asset = await fetchDigitalAsset(umi, collectionMint.publicKey);
if (asset.metadata.collectionDetails.__option !== "Some") {
  throw new Error(
    "Transaction confirmed but the mint is not marked as a collection. Check the cluster and RPC.",
  );
}

saveCollection({
  address: collectionMint.publicKey,
  name: asset.metadata.name,
  symbol: asset.metadata.symbol,
  uri: asset.metadata.uri,
  signature,
  createdAt: new Date().toISOString(),
});

console.log(`\n✅ Collection created`);
console.log(`   Mint      : ${collectionMint.publicKey}`);
console.log(`   Signature : ${signature}`);
console.log(`   Explorer  : ${explorerAddressUrl(collectionMint.publicKey)}`);
console.log(`   Tx        : ${explorerTxUrl(signature)}`);
console.log(
  `\nNext: npm run create:nft -- --name "Lil Turtle" --image assets/lil_turtle.avif`,
);
console.log(`(The collection address is read from state/${cluster}.json.)\n`);
