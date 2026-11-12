import {
  publicKey as umiPublicKey,
} from "@metaplex-foundation/umi";
import {
  fetchDigitalAsset,
  updateV1,
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
import {
  readState,
  updateCollectionRecord,
  updateNftRecord,
} from "../lib/state";
import { sendAndConfirm } from "../lib/tx";
import { uploadAsset, uploadMetadata } from "../lib/upload";
import { createProjectUmi } from "../lib/umi";
import { fetchOffchainMetadata } from "../lib/offchain";

const flags = parseArgs();
const state = readState();
const template = loadMetadataTemplate(getString(flags, "json"));

const mintAddress =
  getString(flags, "mint") ??
  getString(flags, "nft") ??
  state.nfts.at(-1)?.address;
if (!mintAddress) {
  throw new Error(
    "No NFT address. Pass --mint <address> or mint one first with `npm run create:nft`.",
  );
}

const umi = createProjectUmi(getString(flags, "keypair"));
const asset = await fetchDigitalAsset(umi, umiPublicKey(mintAddress));

if (asset.metadata.updateAuthority !== umi.identity.publicKey) {
  throw new Error(
    `Wallet ${umi.identity.publicKey} is not the update authority of ${mintAddress}. ` +
      `The update authority is ${asset.metadata.updateAuthority}.`,
  );
}

const existing = (await fetchOffchainMetadata(asset.metadata.uri)) ?? {};

const name =
  getString(flags, "name", template.name) ?? asset.metadata.name;
const symbol =
  getString(flags, "symbol", template.symbol) ?? asset.metadata.symbol;
const description =
  getString(flags, "description", template.description) ??
  existing.description ??
  "";
const imagePath = getString(flags, "image", template.image);
const externalUrl =
  getString(flags, "external-url", template.external_url) ??
  existing.external_url;
const attributesFile = getString(flags, "attributes-file");
const attributes = attributesFile
  ? normalizeAttributes(readJsonFile(attributesFile))
  : parseAttributesInput(getString(flags, "attributes")) ??
    normalizeAttributes(template.attributes ?? existing.attributes);
const royaltyBps = getString(flags, "royalty-bps") !== undefined
  ? parseRoyaltyBps(getString(flags, "royalty-bps"))
  : getString(flags, "royalty") !== undefined
    ? parseRoyaltyBps(Math.round(getNumber(flags, "royalty", 0) * 100))
    : asset.metadata.sellerFeeBasisPoints;
const makeImmutable = hasFlag(flags, "immutable");
const newAuthority = getString(flags, "new-authority");

assertOnChainLimits({ name, symbol });

console.log(`\n✏️  Updating NFT metadata`);
console.log(`   Cluster : ${cluster} (${rpcUrl})`);
console.log(`   Wallet  : ${umi.identity.publicKey}`);
console.log(`   Mint    : ${mintAddress}`);
console.log(`   Name    : ${name} [${symbol}]`);

let imageUri = existing.image;
let imageContentType =
  existing.properties?.files?.[0]?.type ?? "image/png";

if (imagePath) {
  console.log(`\n⬆️  Uploading new image ${imagePath}…`);
  const uploaded = await uploadAsset(umi, imagePath);
  imageUri = uploaded.uri;
  imageContentType = uploaded.contentType;
  console.log(`   ${imageUri}`);
}

if (!imageUri) {
  throw new Error(
    "Could not determine the current image URI. Pass --image <file> so the new metadata has an image.",
  );
}

const offchainMetadata = buildOffchainMetadata({
  name,
  symbol,
  description,
  imageUri,
  imageContentType,
  externalUrl,
  attributes,
});

console.log(`⬆️  Uploading metadata JSON…`);
const uri = await uploadMetadata(umi, offchainMetadata);
console.log(`   ${uri}`);
assertOnChainLimits({ name, symbol, uri });

console.log(`\n⛓️  Sending update transaction…`);
const signature = await sendAndConfirm(
  umi,
  updateV1(umi, {
    mint: umiPublicKey(mintAddress),
    authority: umi.identity,
    data: {
      name,
      symbol,
      uri,
      sellerFeeBasisPoints: royaltyBps,
      creators: asset.metadata.creators,
    },
    newUpdateAuthority: newAuthority
      ? umiPublicKey(newAuthority)
      : undefined,
    isMutable: makeImmutable ? false : true,
  }),
);

const updated = await fetchDigitalAsset(umi, umiPublicKey(mintAddress));
updateNftRecord(mintAddress, {
  name: updated.metadata.name,
  uri: updated.metadata.uri,
});
if (readState().collection?.address === mintAddress) {
  updateCollectionRecord({
    name: updated.metadata.name,
    uri: updated.metadata.uri,
  });
}

console.log(`\n✅ NFT updated`);
console.log(`   Name      : ${updated.metadata.name}`);
console.log(`   URI       : ${updated.metadata.uri}`);
console.log(`   Mutable   : ${updated.metadata.isMutable}`);
console.log(`   Royalty   : ${updated.metadata.sellerFeeBasisPoints / 100}%`);
if (newAuthority) {
  console.log(`   New update authority: ${updated.metadata.updateAuthority}`);
}
console.log(`   Signature : ${signature}`);
console.log(`   Explorer  : ${explorerAddressUrl(mintAddress)}`);
console.log(`   Tx        : ${explorerTxUrl(signature)}`);
if (makeImmutable) {
  console.log(
    "\n⚠️  This NFT is now immutable: its metadata can never be updated again.",
  );
}
console.log("");
