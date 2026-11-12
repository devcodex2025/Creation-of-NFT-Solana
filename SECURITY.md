# Security

## Keys

- The toolkit never asks for a seed phrase. It reads a Solana keypair JSON from
  `KEYPAIR_PATH`, `./keypair.json`, or `~/.config/solana/id.json`.
- `keypair.json`, `.env`, `state/`, and `uploads/` are gitignored. Never commit
  them or paste a secret key into an issue.
- Treat the update authority as a production secret. If it leaks, an attacker
  can change your metadata, royalties, and collection membership.

## Local wallet bridge

`--signer browser` is the only mode that opens a listening socket. It exists so a
key can stay inside Phantom, Solflare or Backpack instead of a file on disk.

- Binds to `127.0.0.1` on an OS-assigned port; never `0.0.0.0`.
- One 32-byte random token per run, compared in constant time.
- Rejects any request whose `Host` header is not the loopback origin, so a
  malicious site cannot reach it through DNS rebinding.
- The page is served with `default-src 'none'`, `X-Frame-Options: DENY`, and
  `Cache-Control: no-store`. No external script, style, or font is loaded.
- One pending request at a time. The server closes when the command ends, on
  rejection, or after three minutes.
- The CLI never receives the private key; it receives signatures only.

`npm run test:bridge` asserts these properties without needing a wallet.

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
- The toolkit never opens an outbound network connection except to the
  configured RPC endpoint, the Irys uploader, and the metadata URI it is asked to
  read. The only listening socket is the loopback bridge above.
- Releases are tagged. The install instructions pin a tag, not `main`.

## Maintainer

Maintained by `@devcodex2025`. Security reports go to the advisory link above,
or by email to karbivskij@gmail.com for anything that cannot be filed publicly.
