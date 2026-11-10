---
name: nft-creation
description: Create professional NFT collections on Solana end to end with Metaplex — art and metadata standards, Arweave/Irys storage, collection verification, royalties, updates, launch checks and mint troubleshooting. Use when minting NFTs, launching an NFT collection, writing or fixing NFT metadata, verifying collection membership, updating NFT metadata, or debugging Solana NFT mint errors.
license: MIT
metadata:
  author: devcodex2025
  version: "1.0.0"
  homepage: https://github.com/devcodex2025/Creation-of-NFT-Solana
---

# Professional NFT creation on Solana

Build collections that look right, resolve everywhere, and can still be
maintained six months after mint. This skill covers the decisions and the code,
not just the happy path.

## When to use this skill

- Minting a collection plus items with Metaplex Token Metadata or Core.
- Writing metadata JSON that wallets and marketplaces actually display.
- Uploading art to Arweave without locking yourself out of updates.
- Verifying collection membership so items appear inside the collection.
- Changing metadata, royalties, or update authority safely.
- Diagnosing mint failures, missing images, or unverified items.

## Non-negotiables

1. **The image and JSON must be permanent.** Use Arweave (Irys or another
   uploader). IPFS without pinning, S3 buckets, and local files are not
   permanent and will break the NFT.
2. **The collection must be verified.** An item that merely references a
   collection is not in it. Call `verifyCollectionV1` (Token Metadata) or the
   Core collection verification instruction.
3. **Respect on-chain limits.** Name ≤ 32 bytes, symbol ≤ 10 bytes, URI ≤ 200
   bytes. A transaction that exceeds them fails on-chain.
4. **Know who holds the update authority.** It can rewrite metadata and
   royalties. For a serious collection, use a multisig or burn it deliberately.
5. **Immutability is one-way.** Never set `isMutable: false` until the metadata
   is final and verified.

## Choose the token standard first

| Need | Standard | Trade-offs |
|---|---|---|
| Maximum wallet/marketplace compatibility, simple collection, this repo's scripts | **Token Metadata** | Larger accounts, royalties are advisory |
| New collection, lower mint cost, built-in royalties and plugins | **Core** | Newer; fewer legacy integrations |
| 10k–1M cheap items, no per-item account | **Compressed NFT (Bubblegum)** | Needs a DAS-enabled RPC to read |
| Enforced royalties, programmatic transfer rules | **Programmable NFT (pNFT)** | More complex transfers; marketplace support varies |

Default to Token Metadata when the user has no strong preference and wants
predictable marketplace behavior. Choose Core for a new, cost-sensitive drop.
Do not mix standards in one collection.

## Workflow

### 1. Clarify the brief

Ask for, or decide:

- collection name and symbol,
- supply and mint schedule,
- royalty percentage and recipient,
- who keeps the update authority,
- whether metadata becomes immutable,
- where the art lives and whether it is generative or hand-made.

### 2. Prepare the art

- Square canvas, ideally 2000–3000 px.
- Export WebP or AVIF for size; PNG only when transparency matters.
- Keep the master files and the exact export used for minting.
- For generative sets: fixed layer order, documented trait names, no duplicate
  or empty layers, and a preview renderer.
- See `references/art-direction.md` for the professional checklist.

### 3. Write the metadata

Follow the schema in `references/metadata-standard.md`. Minimum viable item:

```json
{
  "name": "Lil Turtle #1",
  "symbol": "LIL",
  "description": "A small turtle with a big heart.",
  "image": "https://arweave.net/<image-id>",
  "attributes": [
    { "trait_type": "Background", "value": "Green" },
    { "trait_type": "Eyes", "value": "Sleepy" }
  ],
  "properties": {
    "files": [{ "uri": "https://arweave.net/<image-id>", "type": "image/webp" }],
    "category": "image"
  }
}
```

Rules that prevent 90% of broken NFTs:

- `name` and `symbol` stay within 32/10 bytes.
- `image` is the direct file URL, not a marketplace page.
- `attributes` values are strings or numbers; trait names are stable across the
  collection.
- JSON is valid and served with `content-type: application/json`.

### 4. Upload to Arweave

Upload the image first, then the JSON that references the image URI. Never
reverse the order. Use the cluster-appropriate Irys endpoint:

| Cluster | Endpoint |
|---|---|
| mainnet-beta | `https://uploader.irys.xyz` |
| devnet | `https://devnet.irys.xyz` |

Cost is small but non-zero; the wallet must hold SOL. Details and alternatives:
`references/storage.md`.

### 5. Create the collection NFT

The collection is itself an NFT with `isCollection: true`. Its mint address is
the collection address that items reference.

With the reference toolkit:

```bash
npm run create:collection -- \
  --name "Lil Turtle Collection" \
  --symbol LIL \
  --image assets/lil_turtle_collection.webp \
  --royalty 2.5
```

Raw Umi equivalent:

```ts
const collectionMint = generateSigner(umi);
await createNft(umi, {
  mint: collectionMint,
  name: "Lil Turtle Collection",
  symbol: "LIL",
  uri: metadataUri,
  sellerFeeBasisPoints: percentAmount(2.5),
  isCollection: true,
}).sendAndConfirm(umi);
```

### 6. Mint items into it

```ts
const mint = generateSigner(umi);
await createNft(umi, {
  mint,
  name: "Lil Turtle #1",
  symbol: "LIL",
  uri: itemMetadataUri,
  sellerFeeBasisPoints: percentAmount(5),
  collection: { key: collectionMint.publicKey, verified: false },
}).sendAndConfirm(umi);
```

Then verify:

```ts
await verifyCollectionV1(umi, {
  metadata: findMetadataPda(umi, { mint: mint.publicKey }),
  collectionMint: collectionMint.publicKey,
  authority: umi.identity,
}).sendAndConfirm(umi);
```

Verification must be signed by the collection's update authority. Minting and
verification can be one transaction group, but verifying after the mint is
easier to debug.

### 7. Confirm, then hand off

- Re-fetch the asset and assert `collection.verified === true`.
- Open the metadata URI in a clean browser.
- Check the item on a marketplace or explorer.
- Decide the long-term authority: keep, move to a multisig, or make immutable.
- Record mint addresses and transaction signatures.

## On-chain limits

| Field | Limit | Notes |
|---|---|---|
| Name | 32 bytes | UTF-8, so emoji/Cyrillic cost more |
| Symbol | 10 bytes | Uppercase ASCII is safest |
| URI | 200 bytes | Arweave URLs are ~43–60 chars |
| Creators | 5 | Verified creator flags matter for royalties |
| Royalty | 0–10000 bps | 500 = 5% |

Validate before sending. A failed mint still costs a fee and wastes a mint
keypair.

## Royalties, honestly

Token Metadata royalties are stored on-chain but **not enforced by the
protocol**. Marketplaces choose whether to pay them. Programmable NFTs and
Core royalty rules provide stronger enforcement, with more integration
friction. Set a realistic percentage (2.5–7.5% is common), state it in the
metadata, and do not promise enforcement you cannot guarantee.

## Cost planning

Approximate mainnet costs per item:

| Item | Cost |
|---|---|
| Mint + metadata + token account rent | 0.015–0.025 SOL |
| Transaction fees | < 0.00001 SOL |
| Arweave upload (20 KB image + 1 KB JSON) | ~0.00005–0.0002 SOL |
| Update transaction | fees only |

Rent is locked, not spent. It returns only if the accounts are closed or the
NFT is burned. Budget 10–20% extra for retries and failed transactions.

## Launch checklist (short)

- [ ] Art exported at final resolution and compressed.
- [ ] Metadata generated, unique names, no missing traits.
- [ ] Every JSON URI resolves publicly.
- [ ] Collection created and confirmed.
- [ ] Items minted and `verified: true`.
- [ ] Royalty and creator addresses double-checked.
- [ ] Update authority secured (multisig or offline key).
- [ ] Test mint on devnet with the exact same pipeline.
- [ ] Support/FAQ page explains wallets and marketplaces.
- [ ] Post-mint plan: reveal, metadata freeze, secondary market.

Full version: `references/launch-checklist.md`.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `0x7` / `UpdateAuthorityIncorrect` | Wrong signer for update or collection | Sign with the authority that owns the collection |
| Item shows outside collection | Never verified | `verifyCollectionV1` |
| Image missing | URI unreachable or wrong content type | Check in a browser; re-upload |
| `0xB` / `NameTooLong` | UTF-8 byte limit | Shorten to ≤ 32 bytes |
| `Account does not exist` | Mint/metadata not created yet | Wait for confirmation, re-fetch |
| `insufficient funds for rent` | Wallet too low | Fund ~0.03 SOL per item |
| Metadata update wiped traits | Replaced JSON without merging | Merge existing off-chain JSON first |
| Marketplace shows old data | Indexer cache | Wait, refresh metadata, check URI |

More: `references/troubleshooting.md`.

## Safety

- Never ask for or handle a seed phrase. Work with a keypair file or a wallet
  adapter.
- Do not print secret keys. Do not commit `.env` or keypair files.
- Simulate on devnet before mainnet, with the same metadata and storage.
- For high-value collections, move the update authority to a multisig before
  announcing the mint.

## Reference implementation

This skill is maintained alongside a working TypeScript toolkit:

```bash
git clone https://github.com/devcodex2025/Creation-of-NFT-Solana
cd Creation-of-NFT-Solana
npm install
cp .env.example .env
npm run keypair
```

| Command | Purpose |
|---|---|
| `npm run create:collection` | Create the collection NFT |
| `npm run create:nft` | Mint and verify an item |
| `npm run verify` | Verify an existing item |
| `npm run update` | Update metadata, royalty, authority |
| `npm run show` | Inspect on-chain and off-chain data |

The toolkit stores addresses in `state/<cluster>.json`, validates limits, and
supports devnet, mainnet and a local validator. Install it as a skill with
`npx skills add https://github.com/devcodex2025/Creation-of-NFT-Solana`.

## References

- `references/metadata-standard.md` — full schema, limits, examples.
- `references/collections.md` — collection model and verification.
- `references/storage.md` — Arweave, Irys, content types, costs.
- `references/art-direction.md` — professional art and trait checklist.
- `references/launch-checklist.md` — pre-mint to post-mint.
- `references/troubleshooting.md` — error-by-error fixes.
- `references/advanced.md` — Core, Candy Machine, compressed NFTs, batching.
- `references/code-recipes.md` — copy-paste Umi snippets.
