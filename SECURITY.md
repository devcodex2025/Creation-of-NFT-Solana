# Security

This toolkit signs transactions that move real SOL and create assets that cannot
be deleted. The design assumes the machine is trusted, the network is not, and
NFT metadata is hostile.

## Keys

- The toolkit never asks for a seed phrase or a private key. Signing happens in
  Phantom, Solflare or Backpack through the loopback bridge; the key never enters
  the CLI process.
- There is no keypair-file mode. The CLI does not read `keypair.json`,
  `KEYPAIR_PATH`, or `~/.config/solana/id.json`.
- The CLI receives only the wallet's public key and the signatures the wallet
  returns.
- Read-only commands (`show`, `--signer readonly`) never open the bridge.
- `.env`, `state/`, and `uploads/` are gitignored. Never commit them or paste a
  secret key into an issue.
- Treat the update authority as a production secret. If it leaks, an attacker
  can change your metadata, royalties, and collection membership.

## Security assessment

`skillspector scan skills/solana-nft-creation --no-llm` (NVIDIA SkillSpector
v2.12.0, 2026-11-15) reports **0/100, LOW, SAFE, 0 issues, 100% coverage** for
the installable skill. The skill package has no executable code and no
dependencies.

The reference CLI's dependency tree has one known low advisory
(`elliptic@6.6.1` through the Irys bundler, no fixed release); see the
dependency notes below. That dependency is not part of the installed skill.

## Transaction approval

Every signature goes through a human in the wallet extension. There is no
background or automatic signing mode.

- The browser page and the terminal print the same facts before each signature:
  the recipient, the amount, the estimated network fee (base fee plus any
  priority fee), the programs called, and the full operation list.
- The facts are decoded from the transaction bytes, not from a separate
  description, so the wallet prompt cannot claim an action the bytes do not
  perform.
- A transaction that calls a program the toolkit does not recognise is labelled
  as such in the page and the terminal.
- Browser signing needs a person at the keyboard. An agent cannot approve on
  the user's behalf.
- A batch does not fund a temporary key and does not delegate collection
  verification. The wallet is the owner and the update authority of every item;
  each item's mint and verification share one transaction.

## Crash safety and state

- A mint address and the signed transaction bytes are written to
  `state/<cluster>.json` before broadcast.
- State is written through a temporary file and renamed, so a crash cannot leave
  truncated JSON.
- On resume, the CLI checks the recorded signature: confirmed means the item is
  kept, in-flight means the same bytes are re-sent, expired means the mint is
  recreated. A recorded address is never reused blindly.
- A corrupt state file is reported, not replaced; it may be the only record of
  minted items.

## Local wallet bridge

The browser bridge is the only mode that opens a listening socket. It exists so
a key can stay inside Phantom, Solflare or Backpack instead of a file on disk.

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
`npm run test:state` covers the write-ahead log and atomic state writes.

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
- No remote bootstrap scripts, and no downloaded payload is piped into a shell
  at runtime. Installation is `npm ci` from the registry, nothing else.
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
- Back up the wallet (hardware wallet or extension recovery, stored offline).
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
