# Changelog

## 2.1.1 — 2026-11-12

### Fixed

- The browser wallet page only read `window.phantom` and `window.solflare` and
  required those legacy objects to expose Wallet Standard features, so it could
  report "No Solana wallet found" with Phantom installed. It now performs
  Wallet Standard discovery (`wallet-standard:app-ready` and
  `wallet-standard:register-wallet`) and renders one connect button per
  discovered wallet.
- The CLI prints the bridge URL when it opens the page, so the tab can be
  opened in the browser profile that holds the extension.
- The account-change handler stops polling instead of signing with a different
  account than the CLI expects.

## 2.1.0 — 2026-11-12

### Changed

- Skill renamed from `nft-creation` to `solana-nft-creation`, so the name says
  what it does and which chain it targets. The directory and every install URL
  moved with it.
- Pinned URLs point at `v2.1.0`.

No functional changes to the CLI or the bridge.

## 2.0.1 — 2026-11-12

### Changed

- Skill metadata `version` now tracks the repository release instead of
  staying at 1.0.0.
- Install and clone instructions point at `v2.0.1`.

No functional changes since 2.0.0.

## 2.0.0 — 2026-11-10

### Added

- Structured `src/lib` + `src/commands` layout with a typed configuration layer.
- Environment-driven cluster/RPC/storage configuration (`.env.example`).
- Idempotent keypair handling (`npm run keypair`), balance and funding commands.
- `show` command that reads on-chain metadata, collection verification and
  off-chain JSON.
- Automatic collection verification after minting (`--skip-verify` to opt out).
- Metadata templates (`metadata/*.example.json`) and validation for Metaplex
  name/symbol/URI limits and royalty ranges.
- End-to-end test against a local validator (`npm run test:e2e`).
- `--signer browser`: sign with Phantom, Solflare or Backpack through a
  temporary page on `127.0.0.1`, so the key never leaves the extension.
- `npm run test:bridge`: token, Host, CSP and shutdown checks for that bridge.
- Reusable `nft-creation` agent skill under `skills/nft-creation/`.
- Documentation: architecture, troubleshooting, launch checklist.

### Changed

- Every command now writes/reads `state/<cluster>.json` instead of hardcoded
  collection and NFT addresses.
- `update` preserves attributes, image and external URL when flags are omitted.
- Every command accepts `--keypair <path>`; an explicit path that does not exist
  is an error instead of a silent fallback to another wallet.
- `createProjectUmi` is async and takes `{ keypairPath, signer }` with
  `keypair`, `browser` and `readonly` modes.
- Irys endpoint is selected from the cluster, so devnet never uploads to
  mainnet by mistake.

### Removed

- Hardcoded devnet addresses from the original scripts.
- Unused dependencies (`i`, `npm`, `@solana-developers/helpers`).
- Automatic airdrops on every command (the public devnet RPC faucet is closed;
  funding is now explicit).
