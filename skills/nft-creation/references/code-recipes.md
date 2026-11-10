# Code recipes (Umi + Token Metadata)

These are complete, minimal snippets for the current Umi SDK
(`@metaplex-foundation/umi` 1.x and `@metaplex-foundation/mpl-token-metadata`
3.x). They intentionally avoid framework code so they can be dropped into a
script, a backend job, or an agent tool.

## 0. Setup

```ts
import { readFileSync } from "node:fs";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey,
} from "@metaplex-foundation/umi";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";

const secret = JSON.parse(readFileSync("keypair.json", "utf8")) as number[];

const umi = createUmi("https://api.devnet.solana.com")
  .use(mplTokenMetadata())
  .use(irysUploader({ address: "https://devnet.irys.xyz" }));

umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(secret))));
```

For mainnet, change the RPC and the Irys address to
`https://uploader.irys.xyz`. Never mix devnet and mainnet in one pipeline.

## 1. Upload an image and its metadata

```ts
import { createGenericFile } from "@metaplex-foundation/umi";
import { readFile } from "node:fs/promises";

export async function uploadNft(
  imagePath: string,
  metadata: Record<string, unknown>,
) {
  const buffer = await readFile(imagePath);
  const file = createGenericFile(buffer, "image.webp", {
    contentType: "image/webp",
  });

  const [imageUri] = await umi.uploader.upload([file]);

  const json = {
    name: metadata.name,
    symbol: "LIL",
    description: metadata.description,
    image: imageUri,
    attributes: metadata.attributes ?? [],
    properties: {
      files: [{ uri: imageUri, type: "image/webp" }],
      category: "image",
    },
  };

  const uri = await umi.uploader.uploadJson(json);
  return { imageUri, uri };
}
```

## 2. Create a collection

```ts
import { createNft } from "@metaplex-foundation/mpl-token-metadata";

export async function createCollection(uri: string) {
  const collectionMint = generateSigner(umi);

  await createNft(umi, {
    mint: collectionMint,
    name: "Lil Turtle Collection",
    symbol: "LIL",
    uri,
    sellerFeeBasisPoints: percentAmount(2.5),
    isCollection: true,
  }).sendAndConfirm(umi, { send: { commitment: "finalized" } });

  return collectionMint.publicKey;
}
```

## 3. Mint an item and verify it

```ts
import {
  createNft,
  findMetadataPda,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";

export async function mintItem(uri: string, collection: string) {
  const mint = generateSigner(umi);

  await createNft(umi, {
    mint,
    name: "Lil Turtle #1",
    symbol: "LIL",
    uri,
    sellerFeeBasisPoints: percentAmount(5),
    collection: { key: publicKey(collection), verified: false },
  }).sendAndConfirm(umi, { send: { commitment: "finalized" } });

  await verifyCollectionV1(umi, {
    metadata: findMetadataPda(umi, { mint: mint.publicKey }),
    collectionMint: publicKey(collection),
    authority: umi.identity,
  }).sendAndConfirm(umi);

  return mint.publicKey;
}
```

If the collection authority is a different signer, pass it as `authority` and
make sure the wallet pays for the transaction.

## 4. Fetch and assert

```ts
import { fetchDigitalAsset } from "@metaplex-foundation/mpl-token-metadata";

const asset = await fetchDigitalAsset(umi, mint);

const isCollection =
  asset.metadata.collectionDetails.__option === "Some";

const verified =
  asset.metadata.collection.__option === "Some" &&
  asset.metadata.collection.value.verified;

console.log({
  name: asset.metadata.name,
  uri: asset.metadata.uri,
  isCollection,
  verified,
  royalty: asset.metadata.sellerFeeBasisPoints / 100,
});
```

Never report success from the transaction alone. Re-fetch the account.

## 5. Update metadata without losing traits

```ts
import {
  fetchDigitalAsset,
  updateV1,
} from "@metaplex-foundation/mpl-token-metadata";

const asset = await fetchDigitalAsset(umi, mint);
const existing = await fetch(asset.metadata.uri).then((r) => r.json());

const newImageUri = "https://arweave.net/new-image-id";

const uri = await umi.uploader.uploadJson({
  ...existing,
  name: "Lil Turtle in Hat",
  description: "A small turtle with a big heart, in hat!",
  image: newImageUri,
  properties: {
    ...existing.properties,
    files: [{ uri: newImageUri, type: "image/avif" }],
  },
});

await updateV1(umi, {
  mint,
  authority: umi.identity,
  data: {
    name: "Lil Turtle in Hat",
    symbol: asset.metadata.symbol,
    uri,
    sellerFeeBasisPoints: asset.metadata.sellerFeeBasisPoints,
    creators: asset.metadata.creators,
  },
}).sendAndConfirm(umi);
```

The `data` object only accepts name, symbol, URI, royalty and creators.
Spreading the whole metadata account into it is unnecessary and can confuse
type checking.

## 6. Change royalty, authority or immutability

```ts
// Royalty to 7.5%
await updateV1(umi, {
  mint,
  authority: umi.identity,
  data: {
    name: asset.metadata.name,
    symbol: asset.metadata.symbol,
    uri: asset.metadata.uri,
    sellerFeeBasisPoints: 750,
    creators: asset.metadata.creators,
  },
}).sendAndConfirm(umi);

// Transfer update authority
await updateV1(umi, {
  mint,
  authority: umi.identity,
  newUpdateAuthority: publicKey("NEW_AUTHORITY_ADDRESS"),
}).sendAndConfirm(umi);

// Make immutable — permanent
await updateV1(umi, {
  mint,
  authority: umi.identity,
  isMutable: false,
}).sendAndConfirm(umi);
```

Once immutable, no field can change, including royalties and the URI. Verify
the metadata before this call.

## 7. Set the collection size

```ts
import {
  findMetadataPda,
  setCollectionSize,
} from "@metaplex-foundation/mpl-token-metadata";

await setCollectionSize(umi, {
  collectionMetadata: findMetadataPda(umi, {
    mint: collectionMint,
  }),
  collectionAuthority: umi.identity,
  collectionMint,
  setCollectionSizeArgs: { size: 1000 },
}).sendAndConfirm(umi);
```

## 8. Batch verify

```ts
import { transactionBuilder } from "@metaplex-foundation/umi";
import {
  findMetadataPda,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );
}

for (const batch of chunk(mints, 8)) {
  let tx = transactionBuilder();
  for (const mint of batch) {
    tx = tx.add(
      verifyCollectionV1(umi, {
        metadata: findMetadataPda(umi, { mint }),
        collectionMint: collectionMint,
        authority: umi.identity,
      }),
    );
  }
  await tx.sendAndConfirm(umi);
  console.log(`verified ${batch.length}`);
}
```

If a batch exceeds the transaction size, reduce the batch size. For large
runs, persist per-item status and skip already-verified items on retry.

## 9. Validate before sending

```ts
function assertMetadata(name: string, symbol: string, uri: string) {
  const bytes = (value: string) => Buffer.byteLength(value, "utf8");
  if (bytes(name) > 32) throw new Error(`name is ${bytes(name)} bytes`);
  if (bytes(symbol) > 10) throw new Error(`symbol is ${bytes(symbol)} bytes`);
  if (bytes(uri) > 200) throw new Error(`uri is ${bytes(uri)} bytes`);
}
```

## 10. Retry with backoff

```ts
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = 500 * 2 ** attempt + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
```

Retry only idempotent reads and transaction sends with a fresh blockhash. Do
not retry a mint without checking whether the first attempt landed.
