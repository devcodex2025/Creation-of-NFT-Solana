# Security audit, 2026-11-14

Scope: the toolkit in `src/`, the browser bridge, the installable skill in
`skills/solana-nft-creation/`, and the dependency tree in `package-lock.json`.

This report follows the security improvement roadmap: protect keys, require
explicit transaction approval, remove unverified remote code, update
dependencies, and classify every finding as a confirmed vulnerability, a false
positive, or an accepted risk.

## Summary

| Area | Before | After |
|---|---|---|
| `npm audit` | 0 critical, 12 high, 12 moderate, 16 low | 0 critical, 0 high, 20 moderate, 15 low |
| Keypair files | Implicit read of the Solana CLI wallet | Only the project keypair, or a wallet the user names |
| Signing prompt | Action label only | Recipient, amount, fee, programs, full operation list |
| External metadata | Parsed and passed through | Size-capped, shape-validated, control characters stripped |
| `npx` tools | Floating versions | `npx skills@1.8.1`, `npx esrun@3.2.30` |
| Abandoned `bigint-buffer` | CVE-2025-3194 reachable | Replaced by `vendor/bigint-buffer` |

## Confirmed vulnerabilities, fixed

### 1. Implicit read of another wallet file (High)

`src/lib/keypair.ts` fell back to `~/.config/solana/id.json` when no project
keypair existed. A user who ran the toolkit in a fresh clone could pay from, and
sign with, a wallet they never named.

Fix: the Solana CLI wallet is no longer a candidate. It is read only through an
explicit `--keypair` or `KEYPAIR_PATH`, and the error message explains how to
name it. The toolkit also warns when a keypair file is readable by other local
users and writes new keypairs with mode `0600`.

### 2. Approval did not state what the transaction does (High)

The browser page showed a label such as "Approve NFT mint" but not the recipient,
the amount, the fee, or the complete operation list. A compromised or buggy
caller could have hidden a transfer inside a transaction labelled as a mint.

Fix: `src/lib/approval.ts` decodes the compiled transaction and produces:

- the recipient and amount for system transfers,
- the estimated network fee (5,000 lamports per signature plus any compute-budget
  priority fee),
- the programs called,
- every operation, in order,
- a warning when a program is not recognised.

The browser page and the terminal print the same facts. The page renders them
with `textContent`, so decoded data cannot inject markup.

### 3. Floating versions of external tools (Medium)

Documentation used `npx skills` and `npx esrun` without a version, so a future
release of either package would run with the user's wallet.

Fix: every documented command pins `skills@1.8.1` and `esrun@3.2.30`; `esrun` is
also pinned exactly in `devDependencies`.

### 4. Prompt injection through NFT metadata (Medium)

`fetchOffchainMetadata` parsed arbitrary JSON from a URI with no size limit and
no shape validation. An NFT description could contain instructions aimed at an
agent, terminal escapes, or a multi-megabyte payload.

Fix:

- responses are capped at 512 KB, by declared length and by streaming byte count,
- only known fields are copied into a fresh object,
- strings are trimmed, length-limited, and stripped of control characters,
- attributes and files are capped,
- the skill documentation states that metadata is data, never instructions.

`npm run test:security` covers the sanitizer, including a prototype-pollution
payload and an oversized file.

### 5. Vulnerable dependency versions (High)

`npm audit` initially reported 40 findings, including high-severity advisories in
`axios@1.11.0`, `form-data@4.0.4`, `lodash@4.17.21`, `ws@8.18.0`, `picomatch`,
`tmp`, and `bigint-buffer@1.1.5`.

Fixes:

- `npm audit fix` updated axios to 1.21.1, form-data to 4.0.6, lodash to 4.18.1,
  picomatch to 2.3.2, tmp to 0.2.7, and ws to 8.23.0 / 7.5.14.
- An npm override forces `ws@8.23.0` inside `@ethersproject/providers`, which
  pins 8.18.0 exactly.
- `bigint-buffer` has no fixed release. It is replaced by
  `vendor/bigint-buffer@1.1.6`, a pure-JavaScript implementation that uses native
  `BigInt`, never reads past the input, and rejects values that do not fit. The
  `file:` dependency deduplicates for every consumer, including
  `@solana/spl-token`.
- The Metaplex packages were aligned to `1.6.0`. The partial upgrade from
  `npm audit fix` had mixed 1.2.0 and 1.6.0 packages and broke imports; the
  aligned set type-checks and runs.

## False positives

| Finding | Why it is not a vulnerability |
|---|---|
| `SECURITY.md:51` — `curl \| sh` | The line says the toolkit has no remote bootstrap script and does not use `curl \| sh`. It is a statement of absence, not an instruction. |
| `SKILL.md:340` — `insufficient funds for rent` | This is a troubleshooting table row about funding a wallet. It does not grant autonomy or ask the agent to run anything. |
| `references/code-recipes.md:305` — retry guidance | The text says to retry only idempotent reads and sends with a fresh blockhash, and explicitly not to retry a mint without checking whether the first attempt landed. |
| Secrets sent over the browser bridge | The bridge sends unsigned transaction bytes to the page and receives signatures. It never sends a private key or seed phrase. Request facts are display-only strings decoded from the transaction. |
| Secrets written to logs | No code path prints the secret half. Errors include addresses and signatures, not key material. The secret byte array is zeroed after the signer copies it. |
| Skill reads other skills' `SKILL.md` files | The skill reads only its own references and the toolkit source. There is no code that scans other skill directories. |
| `@metaplex-foundation/umi-uploader-irys` "fix" = downgrade to 0.9.2 | The advisory chain was `bigint-buffer` and `ws`, not the uploader API. Replacing the dependency and overriding `ws` removes the finding without a breaking downgrade. |

## Accepted risks

| Finding | Severity | Reasoning |
|---|---|---|
| `esbuild@0.24.2` via `esrun` | Moderate | Dev-only runner. The advisory affects `esbuild serve`; the toolkit never starts a dev server and does not expose one to a network. Fixing it requires `esrun@0.0.1`, a breaking downgrade. |
| `@solana/web3.js@1.99.0` via `jayson` / `uuid` / `stream-json` | Moderate | No fixed 1.x release exists; 2.x and 3.x are breaking rewrites of the RPC layer. The impact is a denial of service in the RPC client, and the user chooses `RPC_URL`. No key or fund exposure. |
| `@ethersproject/*@5.8.0` via Irys | Low | The Irys bundler carries ethers v5 for Arweave signing. Low-severity advisories, no confidentiality or integrity impact on the toolkit's keys. |
| `@irys/*` and Metaplex `umi-*` moderates | Low / Moderate | Transitive from the same `web3.js` and ethers chains. No direct vulnerable code path in the toolkit. |
| Temporary batch key in memory | Accepted design | The key exists for one run, can only verify items into the collection while delegated, and is revoked and swept at the end. A crash loses only the remaining rent. Documented in README and SKILL.md. |

## Verification performed

- `npx tsc --noEmit` passes.
- `npm run test:labels` passes 17 cases, including recipient, amount, fee,
  transfer operation, and unknown-program warnings.
- `npm run test:bridge` passes the loopback, token, Host, timeout, and shutdown
  checks.
- `npm run test:security` passes the bigint shim and metadata sanitizer checks.
- A real `createNft` transaction built against devnet was decoded by the approval
  layer: two signatures, `~0.00001 SOL` fee, Token Metadata program, operations
  "Create NFT" and "Mint token to the owner".
- `show-nft` against devnet item `F3XZnED8WDLYSfFhGr2J5FUQHH8Z2nWbubYpHRAEzvnj`
  works after the Metaplex upgrade and returns sanitized off-chain data.
- A live Phantom run created collection
  `AASPbqHYjzjPrGKfo8NobjaGHTPbSZn6gK6mEaHB3Sxm` with 24/24 verified items
  before this audit. That run exercised the bridge, the temporary key, the
  delegation, the sweep, and the revocation with a real extension.
- `npm audit` now reports 0 critical and 0 high findings.

## Limitations

- GitHub Actions is still blocked by the account's billing lock, so CI did not
  run these changes. All checks above were run locally.
- Real Phantom/Solflare extensions cannot be driven by the automated tests. The
  bridge is covered by a scripted Wallet Standard wallet; the live run is the
  real-extension evidence.
- SkillSpector and an LLM-based scanner were not available in this environment.
  The review was manual, file by file, plus `npm audit`.
- `test:e2e` needs `solana-test-validator`, which is not installed here.

## How to re-check

```bash
npm ci
npm audit
npx tsc --noEmit
npm run test:labels
npm run test:bridge
npm run test:security
```

Read `SECURITY.md` before a mainnet launch.
