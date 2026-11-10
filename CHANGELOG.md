# Changelog

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
- Reusable `nft-creation` agent skill under `skills/nft-creation/`.
- Documentation: architecture, troubleshooting, launch checklist.

### Changed

- Every command now writes/reads `state/<cluster>.json` instead of hardcoded
  collection and NFT addresses.
- `update` preserves attributes, image and external URL when flags are omitted.
- Irys endpoint is selected from the cluster, so devnet never uploads to
  mainnet by mistake.

### Removed

- Hardcoded devnet addresses from the original scripts.
- Unused dependencies (`i`, `npm`, `@solana-developers/helpers`).
- Automatic airdrops on every command (the public devnet RPC faucet is closed;
  funding is now explicit).
