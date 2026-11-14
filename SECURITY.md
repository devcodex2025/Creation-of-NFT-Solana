# Security

This toolkit signs transactions that move real SOL and create assets that cannot
be deleted. The design assumes the machine is trusted, the network is not, and
NFT metadata is hostile.

## Keys

- The toolkit never asks for a seed phrase. It reads a Solana keypair JSON from
  `--keypair`, `KEYPAIR_PATH`, or `./keypair.json`.
- Another application's wallet file, including `~/.config/solana/id.json`, is
  read only when the user names it. There is no implicit fallback to it, so a
  run cannot pay from a wallet the user did not choose.
- An explicit `--keypair` or `KEYPAIR_PATH` that does not exist is an error. The
  toolkit never falls back to a different wallet.
- On Linux and macOS the CLI warns when the keypair file is readable by other
  users and tells the user to run `chmod 600`. New keypairs are written with
  mode `0600`.
- Secret bytes are copied into the signer and then zeroed in the caller. A
  JavaScript string cannot be wiped, so the JSON text is never stored, printed
  or sent anywhere.
- `keypair.json`, `.env`, `state/`, and `uploads/` are gitignored. Never commit
  them or paste a secret key into an issue.
- Treat the update authority as a production secret. If it leaks, an attacker
  can change your metadata, royalties, and collection membership.

## Transaction approval

Every signature goes through a human or through a key the user supplied. There
is no background or automatic signing mode.

- The browser page and the terminal print the same facts before each signature:
  the recipient, the amount, the estimated network fee (base fee plus any
  priority fee), the programs called, and the full operation list.
- The facts are decoded from the transaction bytes, not from a separate
  description, so the wallet prompt cannot claim an action the bytes do not
  perform.
- A transaction that calls a program the toolkit does not recognise is labelled
  as such in the page and the terminal.
- `--signer browser` needs a person at the keyboard. An agent cannot approve on
  the user's behalf.
- The batch mode funds a temporary key in memory, delegates collection
  verification to it, and revokes the delegation at the end. The permanent
  wallet stays the update authority of every item and the owner of the
  collection.

## Local wallet bridge

`--signer browser` is the only mode that opens a listening socket. It exists so a
key can stay inside Phantom, Solflare or Backpack instead of a file on disk.

- Binds to `127.0.0.1` on an OS-assigned port; never `0.0.0.0`.
- One 32-byte random token per run, compared in constant time.
- Rejects any request whose `Host` header is not the loopback origin, so a
  malicious site cannot reach it through DNS rebinding.
- The page is served with `default-src 'none'`, `X-Frame-Options: DENY`, and
  `Cache-Control: no-store`. No external script, style, or font is loaded.
- One pending request at a time. The server closes on completion, rejection, or
  after three minutes, and closes keep-alive sockets so the CLI exits.
- The bridge carries unsigned transaction bytes to the page and signatures back.
  It never receives a private key or seed phrase. Request metadata (labels,
  recipient, amounts, operations) is data for display only.

`npm run test:bridge` asserts these properties without needing a wallet.

## Untrusted metadata

NFT metadata and any JSON fetched from a URI are data, not instructions.

- Responses are capped at 512 KB, including the declared `Content-Length` and a
  streaming byte count.
- Only known fields are copied into a fresh object. Unknown fields, including
  `__proto__` and other prototype keys, are dropped.
- Strings are trimmed, length-limited, and stripped of control characters that
  could hide terminal escapes or invisible directives.
- The agent documentation states that content from a name, description,
  attribute or external URL must never change a command, recipient or amount.

## Supply chain

- No `postinstall`, `prepare` or other lifecycle scripts. `npm ci` installs
  exactly what `package-lock.json` pins.
- No remote bootstrap scripts, no `curl | sh`, no downloads at runtime. The
  `curl | sh` mention in earlier documentation was a statement that the toolkit
  does not do this, not an instruction to run one.
- External tools are pinned in the docs: `npx skills@1.8.1` and
  `npx esrun@3.2.30`. `esrun` is also pinned exactly in `devDependencies`.
- The toolkit never opens an outbound network connection except to the
  configured RPC endpoint, the Irys uploader, and the metadata URI it is asked to
  read. The only listening socket is the loopback bridge above.
- Releases are tagged. The install instructions pin a tag, not `main`.

### Dependency notes

- `bigint-buffer` is abandoned and CVE-2025-3194 has no upstream fix. The
  registry package is replaced by a local pure-JavaScript implementation in
  `vendor/bigint-buffer` (version `1.1.6`) through a `file:` dependency. It uses
  native `BigInt`, never reads past the input, and rejects values that do not fit
  instead of overflowing.
- `@ethersproject/providers` pins `ws@8.18.0`, which is affected by
  GHSA-58qx-3vcg-4xpx and GHSA-96hv-2xvq-fx4p. An npm override forces `ws@8.23.0`
  inside that package.
- `npm audit` is part of the release check. `docs/SECURITY-AUDIT.md` records the
  findings, their classification, and the accepted risks.

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

## Maintainer

Maintained by `@devcodex2025`. Security reports go to the advisory link above,
or by email to karbivskij@gmail.com for anything that cannot be filed publicly.
