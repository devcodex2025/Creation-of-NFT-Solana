# Collections and verification

A collection groups NFTs so marketplaces can show them as one project. It is
not a folder and not a token mint shared by items — it is another NFT whose
mint address is referenced by every item.

## The model

```text
Collection NFT (its own mint, isCollection: true)
│  update authority = creator wallet / multisig
│
├── Item #1  collection = { key: <collection mint>, verified: true }
├── Item #2  collection = { key: <collection mint>, verified: true }
└── Item #3  collection = { key: <collection mint>, verified: false }  ← outside the collection
```

Both parts matter:

1. the item stores `collection.key`,
2. the collection's update authority signs a verification transaction.

Without the signature, the item is only pointing at the collection. Most
marketplaces ignore it.

## Create the collection

```ts
const collectionMint = generateSigner(umi);

await createNft(umi, {
  mint: collectionMint,
  name: "Lil Turtle Collection",
  symbol: "LIL",
  uri: collectionMetadataUri,
  sellerFeeBasisPoints: percentAmount(2.5),
  isCollection: true,
}).sendAndConfirm(umi);
```

`isCollection: true` sets `collectionDetails` on the collection's metadata
account. That flag is what tells indexers this NFT is a collection.

## Mint an item into it

```ts
const mint = generateSigner(umi);

await createNft(umi, {
  mint,
  name: "Lil Turtle #1",
  symbol: "LIL",
  uri: itemUri,
  sellerFeeBasisPoints: percentAmount(5),
  collection: {
    key: collectionMint.publicKey,
    verified: false,
  },
}).sendAndConfirm(umi);
```

## Verify membership

```ts
import {
  findMetadataPda,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";

await verifyCollectionV1(umi, {
  metadata: findMetadataPda(umi, { mint: mint.publicKey }),
  collectionMint: collectionMint.publicKey,
  authority: umi.identity,
}).sendAndConfirm(umi);
```

Requirements:

- `authority` must be the collection's update authority (or an approved
  collection delegate).
- the metadata account must be the item's, not the collection's.

Verify the result instead of trusting the transaction:

```ts
const asset = await fetchDigitalAsset(umi, mint.publicKey);
const verified =
  asset.metadata.collection.__option === "Some" &&
  asset.metadata.collection.value.verified;
```

## Authority model

| Role | Can do |
|---|---|
| Collection update authority | Verify/unverify items, update collection metadata, change authorities |
| Item update authority | Update that item's metadata and royalty, transfer authority |
| Collection authority record | Delegated verification without the main key |

The item's update authority does **not** need to match the collection's. But
the collection's authority must sign verification, so the minter needs it (or a
delegate) at mint time.

For a large drop, use a collection delegate or a server-side signer with the
collection authority; do not ship the collection key to a client.

## Collection size

Optionally record the intended size on the collection:

```ts
import { setCollectionSize } from "@metaplex-foundation/mpl-token-metadata";

await setCollectionSize(umi, {
  collectionMetadata: findMetadataPda(umi, { mint: collectionMint.publicKey }),
  collectionAuthority: umi.identity,
  collectionMint: collectionMint.publicKey,
  setCollectionSizeArgs: { size: 1000 },
}).sendAndConfirm(umi);
```

Size is informational for most marketplaces. It does not cap mints; you can
still mint more items.

## Verify in bulk

For 10k items, verification is one instruction per item. Batch 5–10 per
transaction, respect the 1232-byte limit, and confirm after each batch. Avoid
`Promise.all` over thousands of transactions on a public RPC; it will rate
limit and produce partial state.

Pattern:

```ts
for (const batch of chunks(mints, 8)) {
  let tx = transactionBuilder();
  for (const mint of batch) {
    tx = tx.add(
      verifyCollectionV1(umi, {
        metadata: findMetadataPda(umi, { mint }),
        collectionMint: collectionMint.publicKey,
        authority: umi.identity,
      }),
    );
  }
  await tx.sendAndConfirm(umi);
}
```

Re-check every item after the run. Store which ones succeeded; retries should
skip already-verified items.

## Unverified items

You can unverify an item with `unverifyCollectionV1` (same accounts). This is
rarely useful; it removes the item from the collection display without
destroying it.

## Multiple collections

One wallet can own many collections. Keep a mapping in your own database or
state file; the chain does not provide a reverse index from wallet to
collections. Marketplaces/indexers do their own indexing.

## Core collections

Metaplex Core uses a `Collection` plugin instead of a metadata field: the
collection asset carries the plugin, and items are created with a `Collection`
plugin that the collection authority approves. The concept is identical — the
collection authority approves — but the instruction names differ. Do not mix
Core and Token Metadata items in one collection.
