import { getString, parseArgs } from "../lib/args";
import { explorerAddressUrl } from "../lib/config";
import { summarizeAsset } from "../lib/asset";
import { readState } from "../lib/state";
import { createProjectUmi } from "../lib/umi";

const flags = parseArgs();
const state = readState();
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
const asset = await summarizeAsset(umi, mintAddress);

console.log(`\n🔎  ${asset.name} [${asset.symbol}]`);
console.log(`   Mint             : ${asset.mint}`);
console.log(`   Explorer         : ${explorerAddressUrl(asset.mint)}`);
console.log(`   URI              : ${asset.uri}`);
console.log(`   Image            : ${asset.image ?? "(metadata not reachable)"}`);
console.log(`   Description      : ${asset.description ?? ""}`);
console.log(`   Royalty          : ${asset.sellerFeeBasisPoints / 100}%`);
console.log(`   Mutable          : ${asset.isMutable}`);
console.log(`   Token standard   : ${asset.tokenStandard}`);
console.log(`   Update authority : ${asset.updateAuthority}`);
console.log(`   Collection       : ${asset.collection?.key ?? "(none)"}`);
console.log(`   Verified         : ${asset.collection?.verified ?? false}`);
console.log(`   Is collection    : ${asset.isCollection}`);

if (asset.attributes?.length) {
  console.log(`   Attributes:`);
  for (const attribute of asset.attributes) {
    console.log(`     • ${attribute.trait_type}: ${attribute.value}`);
  }
}
console.log("");
