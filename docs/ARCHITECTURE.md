# Architecture

## Goals

- One obvious place for each concern (config, uploads, metadata rules, state).
- Commands that are safe to re-run and never rely on hardcoded addresses.
- No accidental mainnet upload: the cluster decides storage and explorer links.

## Module map

```text
src/
├── commands/            CLI entry points; parse flags, orchestrate, print
└── lib/
    ├── args.ts          tiny `--flag value` parser
    ├── asset.ts         fetch + summarize a digital asset
    ├── browser-bridge.ts loopback server + page for Phantom/Solflare signing
    ├── config.ts        cluster, RPC URL, explorer URLs
    ├── keypair.ts       keypair discovery, loading, creation
    ├── metadata.ts      schema, limits, attributes, royalty parsing
    ├── offchain.ts      read NFT JSON over https or file://
    ├── state.ts         per-cluster address registry
    ├── tx.ts            send + finalized confirm, base58 signature
    ├── umi.ts           Umi instance, signer, metadata + storage plugins
    └── upload.ts        image content types and uploads
```

Commands are deliberately thin. If a rule matters (limits, verification,
royalty math), it lives in `lib/` and is used by every command.

## Runtime flow

```text
process.env + .env
      │
      ▼
config.ts ──► connection (web3.js)
      │
      ▼
umi.ts ──► Umi + keypairIdentity (or browser signer) + mplTokenMetadata + uploader
      │
      ├── create-collection.ts
      │      upload image → upload JSON → createNft(isCollection)
      │      → fetchDigitalAsset → state.collection
      │
      ├── create-nft.ts
      │      read collection from state → upload → createNft(collection)
      │      → verifyCollectionV1 → fetch → state.nfts[]
      │
      ├── verify-collection.ts
      │      read NFT + collection → verifyCollectionV1 → assert verified
      │
      ├── update-nft.ts
      │      fetch asset → merge off-chain JSON → upload
      │      → updateV1(data, isMutable) → assert
      │
      └── show-nft.ts
             fetchDigitalAsset + off-chain JSON → print summary
```

## State

`state/<cluster>.json` is the only mutable project state:

```json
{
  "cluster": "devnet",
  "wallet": "FHL1...",
  "collection": {
    "address": "FppU...",
    "name": "Lil Turtle Collection",
    "symbol": "LIL",
    "uri": "https://arweave.net/...",
    "signature": "5oZM...",
    "createdAt": "2026-11-10T19:25:05.760Z"
  },
  "nfts": [
    {
      "address": "3pDA...",
      "name": "Lil Turtle #1",
      "uri": "https://arweave.net/...",
      "signature": "5Mx8...",
      "collection": "FppU...",
      "verified": true,
      "createdAt": "2026-11-10T19:25:19.338Z"
    }
  ]
}
```

It is per cluster and gitignored. Deleting it never affects the chain; it only
loses the convenience of default addresses. Pass `--collection` / `--mint` to
work without state.

## Storage

`STORAGE=irys` (default) uploads through Irys to Arweave. The address is chosen
from `SOLANA_CLUSTER`:

| Cluster | Irys endpoint |
|---|---|
| `mainnet-beta` | `https://uploader.irys.xyz` |
| `devnet`, `testnet`, `localnet` | `https://devnet.irys.xyz` |

`STORAGE=local` exists for tests and offline development. It writes files to
`./uploads` and returns `file://` URIs. Those are not publicly resolvable and
must never be used for a real mint.

## Trust boundaries

- **Keypair** — read locally, never transmitted. Umi signs locally.
- **RPC** — untrusted; responses are confirmed with `finalized` commitment and
  re-fetched before being reported as success.
- **Storage** — Arweave is immutable. Once uploaded, a URI cannot be changed;
  minting a new URI is the only way to "update".
- **Metadata JSON** — fetched for display and merge only; never executed.

## Why Token Metadata

The repo uses Metaplex Token Metadata because it is the widest-supported NFT
standard on Solana (wallets, marketplaces, indexers). For new collections,
Metaplex Core is lighter and cheaper; the trade-off is ecosystem maturity.
See the skill's `advanced.md` for the decision matrix.
