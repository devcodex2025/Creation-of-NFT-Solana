# Storage: Arweave, Irys and what "permanent" really means

An NFT is a pointer. If the pointer rots, the NFT is an empty token with a
name. Choose storage before minting, not after.

## Options compared

| Storage | Permanence | Cost | NFT suitability |
|---|---|---|---|
| **Arweave (Irys)** | Pay once, permanent | ~$0.0001–0.01 per MB | Best default |
| IPFS + pinning | As long as someone pins | Recurring | Risky without a pinning contract |
| IPFS + Filecoin deal | Long-term, slow retrieval | Setup cost | Acceptable with a gateway |
| S3 / CDN | Until you stop paying | Recurring | Not acceptable for NFTs |
| On-chain data | Forever | Expensive | Only tiny assets |
| `file://` | Your laptop | Free | Tests only |

If a service can delete your file, it is not permanent.

## How Irys works

1. You upload bytes and metadata tags to the Irys bundler.
2. Irys batches the data into an Arweave transaction and pays the storage fee.
3. The file is addressed by a transaction ID: `https://arweave.net/<id>`.

Uploads cost SOL, priced by byte size. The wallet pays from its own balance, so
it needs a little more than the raw price (rent and fees).

### Endpoints

| Cluster | Bundler |
|---|---|
| mainnet-beta | `https://uploader.irys.xyz` |
| devnet | `https://devnet.irys.xyz` |

Never point a devnet mint at a mainnet upload, or vice versa. The reference
toolkit chooses the endpoint from `SOLANA_CLUSTER`.

### Umi setup

```ts
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";

const umi = createUmi("https://api.devnet.solana.com")
  .use(irysUploader({ address: "https://devnet.irys.xyz" }));
```

`createUmi(connection)` with a custom RPC may not infer the cluster, which is
why the address is passed explicitly.

## Upload pattern

```ts
import { createGenericFile } from "@metaplex-foundation/umi";
import { promises as fs } from "node:fs";

const buffer = await fs.readFile("art/1.webp");
const file = createGenericFile(buffer, "1.webp", {
  contentType: "image/webp",
});

const [imageUri] = await umi.uploader.upload([file]);

const metadataUri = await umi.uploader.uploadJson({
  name: "Lil Turtle #1",
  symbol: "LIL",
  description: "A small turtle with a big heart.",
  image: imageUri,
  attributes: [{ trait_type: "Background", value: "Green" }],
  properties: {
    files: [{ uri: imageUri, type: "image/webp" }],
    category: "image",
  },
});

console.log({ imageUri, metadataUri });
```

Upload the image first. The JSON embeds the image URI, so the order is not
optional.

## Costs

Arweave pricing is roughly linear in bytes:

| File | Size | Approx. cost |
|---|---|---|
| 1 KB JSON | 1 KB | ~0.000001 SOL |
| 500 KB WebP | 500 KB | ~0.0002 SOL |
| 5 MB MP4 | 5 MB | ~0.002 SOL |

Multiply by supply. A 10k collection with 300 KB images is a few SOL in storage
— budget it before announcing a free mint.

Prices vary with the Arweave token price and Irys overhead. Always check with
`umi.uploader.getUploadPrice` on a real file before a large run.

## Permanence and updates

Arweave data cannot be edited or deleted. That has two consequences:

1. Metadata updates work by uploading a **new** JSON and pointing the on-chain
   `uri` at it. The old JSON remains, unreferenced.
2. A mistake (wrong image, leaked URL) is permanent in storage. You can change
   what the token points at, not what was published.

For sensitive pre-reveal art, do not upload the real art early. Upload a
placeholder, then update the URI at reveal.

## Content types

Set the MIME type correctly when creating the generic file, and repeat it in
`properties.files[].type`. Some gateways and marketplaces use the tag, others
use the JSON.

## Gateways

`https://arweave.net/<id>` is the canonical gateway. Alternatives:

- `https://gateway.irys.xyz/<id>`
- `https://<your-gateway>/<id>`

Use `arweave.net` in metadata: it is the most widely indexed.

## Verification

After uploading, fetch the URI once from a clean client and confirm:

- HTTP 200,
- correct `content-type`,
- the image renders,
- the JSON parses.

A 200 from your local cache is not proof. Use a different network or a gateway
you did not just upload through.

## Alternatives

- **Metaplex Core + Irys** — same storage rules, smaller on-chain footprint.
- **Shadow Drive** — Solana-native storage, different trust model; check
  current status before committing.
- **NFT.Storage / Pinata** — IPFS pinning; fine only with a long-term pinning
  agreement.
- **Turbo (Arweave)** — another bundler; same permanence model, different
  payment flow.

## Local development

For tests, the toolkit supports `STORAGE=local`, which writes to `./uploads`
and returns `file://` URIs. These never leave your machine. They are useful for
asserting the mint flow; they are not metadata you can ship.
