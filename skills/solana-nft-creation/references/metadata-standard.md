# NFT metadata standard (Metaplex)

Metadata has two halves:

1. **On-chain account** — small, fixed fields stored by the Token Metadata
   program. It cannot grow.
2. **Off-chain JSON** — the `uri` field points at a JSON document. Everything
   rich lives here.

If the JSON is unreachable, the NFT still exists but looks broken everywhere.

## On-chain fields

| Field | Limit | Set by | Notes |
|---|---|---|---|
| `name` | 32 bytes | `createNft` | UTF-8 bytes, not characters |
| `symbol` | 10 bytes | `createNft` | Uppercase ASCII recommended |
| `uri` | 200 bytes | `createNft` | Arweave URLs fit comfortably |
| `sellerFeeBasisPoints` | 0–10000 | `createNft` | 500 = 5% |
| `creators` | max 5 | `createNft` | Each has `address`, `verified`, `share` |
| `collection` | — | `createNft` | `{ key, verified }` |
| `isMutable` | — | `createNft` / `updateV1` | `false` is permanent |
| `updateAuthority` | — | `createNft` / `updateV1` | Controls future changes |
| `primarySaleHappened` | — | `updateV1` | Informational |
| `tokenStandard` | — | program | `NonFungible` for standard NFTs |

Name, symbol and URI are byte-limited. `"Привіт"` is 12 bytes; an emoji can be
4 bytes per character. Names like `"Lil Turtle #1"` are safe; a 40-character
sentence is not.

## Off-chain JSON

```json
{
  "name": "Lil Turtle #1",
  "symbol": "LIL",
  "description": "A small turtle with a big heart, wearing a hat.",
  "image": "https://arweave.net/abc123",
  "animation_url": "https://arweave.net/xyz789",
  "external_url": "https://lil-turtle.example",
  "attributes": [
    { "trait_type": "Background", "value": "Green" },
    { "trait_type": "Headdress", "value": "Hat" },
    { "trait_type": "Level", "value": 7, "display_type": "number" }
  ],
  "properties": {
    "files": [
      { "uri": "https://arweave.net/abc123", "type": "image/webp" },
      { "uri": "https://arweave.net/xyz789", "type": "video/mp4" }
    ],
    "category": "image"
  }
}
```

### Field rules

- **`name`** — unique per item. Include the edition number if it is a series.
- **`description`** — plain text. Explain the project, not the marketplace.
- **`image`** — direct file URL, https. No spaces, no redirects.
- **`animation_url`** — video, audio, HTML or 3D file. Marketplaces show it
  instead of the image when supported.
- **`external_url`** — project site. Do not point at a marketplace listing.
- **`attributes`** — array of `{ trait_type, value }`. Use the same trait names
  across the whole collection; marketplaces build filters from them.
- **`properties.files`** — every file that belongs to the item. Type must be a
  real MIME type.
- **`properties.category`** — `image`, `video`, `audio`, `vr`, `html`.

### Trait values

- Use strings for categories (`"Red"`, `"Hat"`) and numbers for numeric traits
  (`7`) with `"display_type": "number"`.
- Avoid `null`, empty strings, and objects.
- Do not rename traits between items: `Background` and `background` are two
  different filters.
- Keep rarity meaningful. If 1/1 items share a trait with 900 others, it is not
  a 1/1 trait.

## Content types

| Extension | MIME type |
|---|---|
| `.png` | `image/png` |
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.webp` | `image/webp` |
| `.avif` | `image/avif` |
| `.gif` | `image/gif` |
| `.svg` | `image/svg+xml` |
| `.mp4` | `video/mp4` |
| `.glb` | `model/gltf-binary` |

A wrong content type is a common reason an image shows as a download link
instead of artwork.

## Validation checklist

Before minting a batch, assert:

- [ ] `Buffer.byteLength(name) <= 32`
- [ ] `Buffer.byteLength(symbol) <= 10`
- [ ] `Buffer.byteLength(uri) <= 200`
- [ ] `0 <= sellerFeeBasisPoints <= 10000`
- [ ] every JSON document parses
- [ ] every `image` URL returns 200 with an image content type
- [ ] every `name` is unique
- [ ] `collection.key` is the intended collection mint

A script that checks these costs seconds; a broken mint costs SOL and trust.

## Common mistakes

| Mistake | Result |
|---|---|
| Uploading JSON before the image | `image` points at nothing |
| Using a marketplace page as `image` | Broken preview |
| Reusing one metadata URI for every item | All items look identical |
| Different trait names per item | Filters split into dozens of categories |
| `properties.files` missing | Some marketplaces cannot find the asset |
| JSON served as `text/plain` | Some clients refuse to parse it |
| Name over 32 bytes | Mint transaction fails |
| Royalty over 10000 bps | Instruction fails |

## Updates

Updating metadata replaces the whole JSON document referenced by the URI.
Off-chain JSON is immutable on Arweave, so "update" means: upload a new JSON,
then point the on-chain `uri` at it. Merge the old document first, or you will
silently drop traits and images.
