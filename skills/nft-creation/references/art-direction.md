# Art direction for professional NFT collections

Code can only make a good collection look correct. This file is the checklist
that separates a collection people save from one they scroll past.

## Technical spec

| Property | Recommendation | Why |
|---|---|---|
| Canvas | Square, 2000×2000 or 3000×3000 | Marketplaces crop to square |
| Format | WebP (or AVIF), PNG for transparency/1:1 | 5–10× smaller than PNG |
| File size | 200–800 KB | Large files load slowly in wallets |
| Color | sRGB | Predictable on every device |
| Metadata | `properties.files` points at the same file | Some clients ignore `image` |
| Naming | `001.webp`, `002.webp`, zero-padded | Sorts correctly in any tool |

Never upscale a 512×512 image to 3000×3000. Mint at the resolution you actually
have, or regenerate at higher resolution.

## Generative collections

### Layers

- Fixed order: background → body → clothing → eyes → headwear → accessory.
- No layer may cover a signature trait unless intended.
- Every layer has a transparent canvas at the final size.
- Name files with the trait and weight: `03_hat_beanie.png`,
  `04_eyes_sleepy.png`.

### Traits

- One spelling per trait, everywhere. `Background` ≠ `background` ≠ `BG`.
- Decide rarity before generating; do not let randomness decide the brand.
- Keep the number of traits between 5 and 12. More becomes noise.
- Include at least one rare, story-driving trait. Rarity without narrative is
  just a percentage.
- Avoid traits that cannot be seen at thumbnail size (a 3 px pin).

### QA before upload

- Render a contact sheet of 50 random items.
- Check for empty or duplicate layers.
- Check that every combination still looks like the same collection.
- Confirm no item has two mutually exclusive traits.
- Verify trait counts from the metadata, not from the generator UI.

## 1/1 and hand-made art

- Show the full artwork, not a crop of a larger scene.
- Keep a consistent border or framing rule across the set.
- Do not mix photography, 3D renders, and illustration unless the concept is
  deliberately collage.
- Prepare a high-resolution master and a compressed mint file; keep both.

## Motion and audio

- `animation_url` supports MP4, WebM, MP3, WAV, GLB/GLTF, and HTML.
- Keep video under ~30 s and 10 MB unless the concept requires more.
- Provide a still `image` poster; wallets show it before the video loads.
- For 3D, test in at least two viewers; GLB is the safest format.

## Brand surface

The collection page is part of the product:

- Banner: 1500×500, safe area in the center.
- Avatar/logo: 512×512, readable at 64 px.
- Description: one sentence about what it is, one about why it exists.
- Links: site, X/Twitter, Discord. No dead links at mint.
- Royalty and supply stated in plain language.

## Naming

- Collection: short, searchable, no numbers unless meaningful.
- Items: `Collection #001` for series; a real title for 1/1s.
- Avoid unicode lookalikes and trailing spaces; they break filters and search.

## Accessibility

- Do not encode meaning in color alone.
- Keep text in art large enough to read at 400 px.
- Add alt text on the project site; metadata JSON has no alt field.
- Test the preview with a color-blind simulator.

## The final check

Open the collection on a phone, on a laptop, and in a wallet extension. If the
art, name, and description are not understandable in three seconds, fix the
art direction before touching the mint script.
