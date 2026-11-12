# Security

## Keys

- The toolkit never asks for a seed phrase. It reads a Solana keypair JSON from
  `KEYPAIR_PATH`, `./keypair.json`, or `~/.config/solana/id.json`.
- `keypair.json`, `.env`, `state/`, and `uploads/` are gitignored. Never commit
  them or paste a secret key into an issue.
- Treat the update authority as a production secret. If it leaks, an attacker
  can change your metadata, royalties, and collection membership.

## Mainnet checklist

- Use a dedicated mint wallet, not your personal wallet.
- Simulate on devnet with the same metadata and storage first.
- Back up the keypair offline (hardware wallet or encrypted backup).
- Consider moving the update authority to a multisig (Squads) before a large
  mint.
- Verify the metadata URI resolves and the image loads from a fresh browser.
- Decide whether the collection should be immutable before you make it so:
  immutability cannot be undone.

## Reporting a vulnerability

Open a private security advisory on GitHub:
https://github.com/devcodex2025/Creation-of-NFT-Solana/security/advisories

Please do not disclose a vulnerability publicly before it is fixed.

## Supply chain

- No `postinstall`, `prepare` or other lifecycle scripts. `npm ci` installs
  exactly what `package-lock.json` pins.
- No remote bootstrap scripts, no `curl | sh`, no downloads at runtime.
- The toolkit never opens a network connection except to the configured RPC
  endpoint, the Irys uploader, and the metadata URI it is asked to read.
- Releases are tagged. The install instructions pin a tag, not `main`.

## Maintainer

Maintained by `@devcodex2025`. Security reports go to the advisory link above,
or by email to karbivskij@gmail.com for anything that cannot be filed publicly.
