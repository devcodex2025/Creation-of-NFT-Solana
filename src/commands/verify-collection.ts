import { publicKey as umiPublicKey } from "@metaplex-foundation/umi";
import {
  findMetadataPda,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import { getString, parseArgs } from "../lib/args";
import { cluster, explorerAddressUrl, explorerTxUrl, rpcUrl } from "../lib/config";
import { summarizeAsset } from "../lib/asset";
import { readState, updateNftRecord } from "../lib/state";
import { sendAndConfirm } from "../lib/tx";
import { createProjectUmi } from "../lib/umi";

const flags = parseArgs();
const state = readState();

const collectionAddress =
  getString(flags, "collection") ?? state.collection?.address;
if (!collectionAddress) {
  throw new Error(
    "No collection address. Pass --collection <mint> or create a collection first.",
  );
}

const nftAddress =
  getString(flags, "nft") ??
  getString(flags, "mint") ??
  state.nfts.at(-1)?.address;
if (!nftAddress) {
  throw new Error(
    "No NFT address. Pass --nft <mint> or mint an NFT first with `npm run create:nft`.",
  );
}

const umi = createProjectUmi(getString(flags, "keypair"));

console.log(`\n🔏  Verifying collection membership`);
console.log(`   Cluster    : ${cluster} (${rpcUrl})`);
console.log(`   Wallet     : ${umi.identity.publicKey}`);
console.log(`   Collection : ${collectionAddress}`);
console.log(`   NFT        : ${nftAddress}`);

const before = await summarizeAsset(umi, nftAddress);
if (before.collection?.verified) {
  console.log(`\n✅ Already verified — nothing to do.`);
  console.log(`   Explorer: ${explorerAddressUrl(nftAddress)}\n`);
  process.exit(0);
}

if (before.collection?.key !== collectionAddress) {
  throw new Error(
    `NFT ${nftAddress} points at collection ${before.collection?.key ?? "(none)"}, ` +
      `not ${collectionAddress}. Use the collection recorded on the NFT.`,
  );
}

const signature = await sendAndConfirm(
  umi,
  verifyCollectionV1(umi, {
    metadata: findMetadataPda(umi, { mint: umiPublicKey(nftAddress) }),
    collectionMint: umiPublicKey(collectionAddress),
    authority: umi.identity,
  }),
);

const after = await summarizeAsset(umi, nftAddress);
if (!after.collection?.verified) {
  throw new Error(
    "Verification transaction confirmed but the NFT is still unverified. " +
      `Make sure ${umi.identity.publicKey} is the update authority of the collection.`,
  );
}

updateNftRecord(nftAddress, { verified: true });

console.log(`\n✅ Collection verified`);
console.log(`   Signature : ${signature}`);
console.log(`   Explorer  : ${explorerAddressUrl(nftAddress)}`);
console.log(`   Tx        : ${explorerTxUrl(signature)}\n`);
