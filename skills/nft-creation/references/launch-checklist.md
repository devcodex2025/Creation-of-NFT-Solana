# Launch checklist

A collection launch is a small production release. Work through the phases in
order; do not skip phase 0.

## Phase 0 — Decisions

- [ ] Supply: exact number, and what happens if it does not sell out.
- [ ] Price and mint mechanics (open mint, allowlist, raffle, free claim).
- [ ] Royalty: percentage and recipient wallet.
- [ ] Who holds the update authority: personal key, multisig, or burn.
- [ ] Immutability: when, if ever.
- [ ] Reveal: instant or delayed; where the placeholder art lives.
- [ ] Marketplace/indexer expectations: which venues must display it day one.
- [ ] Who answers support messages during the mint.

Write these down. Half the launch failures are decisions made twice.

## Phase 1 — Art and metadata

- [ ] Final artwork exported to spec.
- [ ] Metadata generated from a single source of truth.
- [ ] Names unique, traits stable and spelled consistently.
- [ ] Every JSON validates and every image URI returns 200.
- [ ] Contact sheet reviewed by a second person.
- [ ] Trait rarity table exported for the site and community.

## Phase 2 — Technical dry run

- [ ] Devnet run of the exact pipeline (same scripts, same storage backend).
- [ ] Collection created and confirmed.
- [ ] At least 10 items minted and verified.
- [ ] Update path tested on one item (name, image, traits).
- [ ] `show`/explorer output matches expectations.
- [ ] Wallet balance covers rent + uploads + retries.
- [ ] RPC checked under load; a dedicated provider is configured for mint day.

## Phase 3 — Storage

- [ ] Image uploads complete and paid.
- [ ] JSON uploads complete and reference the final images.
- [ ] URIs spot-checked from a different network.
- [ ] Pre-reveal art does not leak the final assets (if applicable).
- [ ] Upload log stored with IDs and costs.

## Phase 4 — Mint mechanics

For Candy Machine or Core Candy Machine:

- [ ] Guard groups and prices configured.
- [ ] Allowlist snapshotted and tested with a real wallet.
- [ ] Start time verified in the correct timezone.
- [ ] Withdraw authority and treasury set.
- [ ] One test mint from a non-admin wallet.

For a simple collection:

- [ ] Collection authority available during the mint window.
- [ ] Mint script can resume after a failure without duplicating items.
- [ ] Rate limits and retries configured on the RPC.

## Phase 5 — Communication

- [ ] Mint page live with supply, price, date, wallet support.
- [ ] FAQ: which wallets, which marketplaces, how to verify.
- [ ] Links tested on mobile.
- [ ] Support channel staffed.
- [ ] Terms and risk statement if the project makes financial claims.

## Phase 6 — Mint day

- [ ] Watch the first 10 mints end to end.
- [ ] Confirm items land verified in the collection.
- [ ] Monitor RPC errors and wallet failures.
- [ ] Publish progress updates at meaningful milestones, not spam.
- [ ] Stop and fix if metadata or verification is wrong; do not "fix later".

## Phase 7 — After mint

- [ ] Every item verified (query all, not a sample).
- [ ] Reveal executed if delayed; metadata URIs updated.
- [ ] Collection metadata final (banner, description, links).
- [ ] Secondary market listings appear correctly.
- [ ] Update authority moved to multisig or burned, as decided.
- [ ] Post-mortem: costs, failures, what to change next time.
- [ ] Archive scripts, metadata, and upload IDs in cold storage.

## Red flags

- No devnet dry run.
- Metadata generated in a spreadsheet with no validation.
- Uploading final art before the reveal date.
- Promising enforced royalties.
- A single personal wallet holding the update authority for a high-value
  collection.
- No plan for a partial sell-out.
- Minting from a public RPC with no fallback.
