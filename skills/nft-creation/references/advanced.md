# Advanced: standards, drops and scale

Use this when the simple "collection + items" flow is not enough.

## Core in one page

Metaplex Core stores an NFT in a single asset account. Plugins (royalties,
freeze, attributes, collection, transfer rules) are attached to it. Compared to
Token Metadata:

| | Token Metadata | Core |
|---|---|---|
| Accounts per NFT | Mint + metadata + token account (+ edition) | One asset |
| Mint cost | Higher | Lower |
| Royalties | Stored, advisory | Royalty plugin, better enforcement |
| Ecosystem | Widest | Growing |
| SDK | Umi + mpl-token-metadata | Umi + mpl-core |

Core create (conceptual):

```ts
import { create } from "@metaplex-foundation/mpl-core";

await create(umi, {
  asset: generateSigner(umi),
  collection: collectionAddress,
  name: "Lil Turtle #1",
  uri: metadataUri,
  plugins: [
    { type: "Royalties", basisPoints: 500, creators: [...], ruleSet: { type: "None" } },
  ],
}).sendAndConfirm(umi);
```

Do not copy Core snippets into a Token Metadata collection. Pick one standard
per collection.

## Candy Machine

A Candy Machine is a minting contract: it holds config lines and guards, and
buyers mint from it without you signing each transaction.

Two generations exist:

- **Core Candy Machine** — mints Core assets, recommended for new drops.
- **Token Metadata Candy Machine (v3)** — mints Token Metadata NFTs, still
  widely used.

Conceptual flow:

1. Upload all metadata JSON to Arweave.
2. Create the collection.
3. Create the Candy Machine with the collection attached.
4. Insert config lines (name + URI per item).
5. Configure guards: price, start date, allowlist, mint limit, payment.
6. Test mint from a non-admin wallet.
7. Mint day: monitor, then withdraw and clean up.

Guards are where drops fail: a wrong start time, a mint limit of zero, or an
allowlist with the wrong Merkle root. Test each guard group on devnet.

## Compressed NFTs (Bubblegum)

A compressed NFT stores its data in a Merkle tree and costs a fraction of a
normal mint. Trade-offs:

- Reading requires a DAS-enabled RPC (`getAssetsByOwner`, etc.).
- Not every marketplace supports them.
- Tree setup and canopy size affect cost and proof size.

Use them for large, low-price drops (games, loyalty, tickets), not for a
premium 1/1 collection that must show up everywhere.

## Programmable NFTs (pNFT)

pNFTs attach transfer rules and can enforce royalties through Token
Authorization Rules. They require:

- a rule set account,
- extra accounts on transfer,
- wallet/marketplace support for the rules.

If royalties are a core part of the business model, evaluate pNFTs or Core
royalties rather than promising enforcement with standard NFTs.

## Batch minting

Rules that keep batches reliable:

- One mint needs several accounts; 5–10 mints per transaction is a realistic
  ceiling before hitting the 1232-byte limit.
- Every mint needs its own signer keypair. Generate and store them before
  sending, or you lose the ability to retry the same mint.
- Use a dedicated RPC and confirm with `finalized` before recording success.
- Persist progress after each batch; a retry must skip completed mints.
- Cap concurrency to what the RPC tolerates; handle `429` with backoff.

Pseudo-code:

```ts
for (const batch of chunks(items, 5)) {
  const results = await Promise.allSettled(
    batch.map((item) => mintOne(item)),
  );
  await saveProgress(results);
}
```

`Promise.all` over 5,000 mints is not a strategy; it is a rate-limit test.

## Reading NFT data at scale

- `fetchDigitalAsset` — one asset, exact and typed. Good for scripts.
- **DAS API** — `getAssetsByOwner`, `getAssetsByCollection`, search/filter.
  Available on Helius, Triton, QuickNode and other providers.
- **Metaplex APIs / indexers** — collection-level queries without running your
  own indexer.
- **Geyser / Yellowstone** — real-time streaming for marketplaces and bots.

For a collection page, do not loop `fetchDigitalAsset` over 10k mints. Use a
DAS query or your own index.

## Authority management

| Setup | When |
|---|---|
| Single hot wallet | Devnet and small experiments |
| Multisig (Squads) | Serious collections, treasury actions |
| Offline signer | Collection authority kept cold until verification |
| Burned authority | Final, trust-minimized collections |

Burning the update authority makes metadata permanent. Do it after reveal and
verification, never before.

## Versioning your mint

Keep, outside the chain:

- the exact commit of the mint scripts,
- metadata JSON for every item,
- Arweave IDs,
- mint addresses and signatures,
- the keypair or multisig used.

If something breaks in six months, this archive is the only way to reconstruct
what happened.

## Further reading

- Token Metadata: https://developers.metaplex.com/token-metadata
- Core: https://developers.metaplex.com/core
- Candy Machine: https://developers.metaplex.com/candy-machine
- Bubblegum: https://developers.metaplex.com/bubblegum
- Umi: https://developers.metaplex.com/umi
