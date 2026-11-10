import { publicKey, type Umi } from "@metaplex-foundation/umi";
import { fetchDigitalAsset } from "@metaplex-foundation/mpl-token-metadata";
import { fetchOffchainMetadata } from "./offchain";

const TOKEN_STANDARDS = [
  "NonFungible",
  "FungibleAsset",
  "Fungible",
  "NonFungibleEdition",
  "ProgrammableNonFungible",
  "ProgrammableNonFungibleEdition",
] as const;

export interface AssetSummary {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  updateAuthority: string;
  sellerFeeBasisPoints: number;
  isMutable: boolean;
  primarySaleHappened: boolean;
  tokenStandard: string;
  collection: {
    key: string;
    verified: boolean;
  } | null;
  isCollection: boolean;
  image: string | null;
  description: string | null;
  attributes: Array<{ trait_type: string; value: string | number }> | null;
}

export async function summarizeAsset(
  umi: Umi,
  mint: string,
): Promise<AssetSummary> {
  const asset = await fetchDigitalAsset(umi, publicKey(mint));
  const metadata = asset.metadata;
  const offchain = await fetchOffchainMetadata(metadata.uri);

  const collection =
    metadata.collection.__option === "Some"
      ? {
          key: metadata.collection.value.key,
          verified: metadata.collection.value.verified,
        }
      : null;

  return {
    mint: asset.publicKey,
    name: metadata.name,
    symbol: metadata.symbol,
    uri: metadata.uri,
    updateAuthority: metadata.updateAuthority,
    sellerFeeBasisPoints: metadata.sellerFeeBasisPoints,
    isMutable: metadata.isMutable,
    primarySaleHappened: metadata.primarySaleHappened,
    tokenStandard:
      metadata.tokenStandard.__option === "Some"
        ? TOKEN_STANDARDS[Number(metadata.tokenStandard.value)] ??
          String(metadata.tokenStandard.value)
        : "Unknown",
    collection,
    isCollection: metadata.collectionDetails.__option === "Some",
    image: offchain?.image ?? null,
    description: offchain?.description ?? null,
    attributes: offchain?.attributes ?? null,
  };
}
