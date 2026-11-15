# Security audit, 2026-11-14

Scope: the toolkit in `src/`, the browser bridge, the installable skill in
`skills/solana-nft-creation/`, and the dependency tree in `package-lock.json`.

> **Update, 2026-11-15:** the keypair and temporary-key design described in this
> report was removed. The toolkit is browser-only now: the key stays in the
> wallet extension, the wallet owns every item, and `state/` records a mint
> before broadcast so a crash cannot duplicate it. See `SECURITY.md`. The
> findings below are the record of the 2026-11-14 audit.

This report follows the security improvement roadmap: protect keys, require
explicit transaction approval, remove unverified remote code, update
dependencies, and classify every finding as a confirmed vulnerability, a false
positive, or an accepted risk.

## Summary

| Area | Before | After |
|---|---|---|
| `npm audit` | 0 critical, 12 high, 12 moderate, 16 low | 0 critical, 0 high, 16 moderate, 16 low |
| Keypair files (removed 2026-11-15) | Implicit read of the Solana CLI wallet | No keypair mode; the key stays in the wallet extension |
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
name it. The toolkit restricts a keypair file readable by other local users to
mode `0600` and writes new keypairs with that mode. Superseded on 2026-11-15:
the keypair mode was removed entirely; see `SECURITY.md`.

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

Documentation originally named the runner packages without a version, so a
future release would run with the user's wallet.

Fix: every documented command pins `skills@1.8.1` and `esrun@3.2.30`; `esrun` is
also pinned exactly in `devDependencies`.

### 4. Prompt injection through NFT metadata (Medium)

`fetchOffchainMetadata` parsed arbitrary JSON from a URI without a byte budget
and without shape validation. An NFT description could contain instructions
aimed at an agent, terminal escapes, or a multi-megabyte payload.

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
- An npm override moves `csv-parse` to `7.0.3`, which clears CVE-2026-85063 in
  the Irys upload path.
- An npm override moves `esbuild` to `0.28.2`. `esrun` only bundles local
  scripts and never starts a development server.

## False positives

| Finding | Why it is not a vulnerability |
|---|---|
| `SKILL.md:340` — `insufficient funds for rent` | This is a troubleshooting table row about funding a wallet. It does not grant autonomy or ask the agent to run anything. |
| `references/code-recipes.md:305` — retry guidance | The text says to retry only idempotent reads and sends with a fresh blockhash, and to confirm whether the first attempt landed before retrying a mint. |
| Secrets sent over the browser bridge | The bridge sends unsigned transaction bytes to the page and receives signatures. It never sends a private key or seed phrase. Request facts are display-only strings decoded from the transaction. |
| Secrets written to logs | No code path prints the secret half. Errors include addresses and signatures, not key material. The secret byte array is zeroed after the signer copies it. |
| Skill reads other skills' `SKILL.md` files | The skill reads only its own references and the toolkit source. There is no code that scans other skill directories. |
| `@metaplex-foundation/umi-uploader-irys` "fix" = downgrade to 0.9.2 | The advisory chain was `bigint-buffer` and `ws`, not the uploader API. Replacing the dependency and overriding `ws` removes the finding without a breaking downgrade. |

## Accepted risks

| Finding | Severity | Reasoning |
|---|---|---|
| `@solana/web3.js@1.99.0` via `jayson` / `uuid` / `stream-json` | Moderate | No fixed 1.x release exists; 2.x and 3.x are breaking rewrites of the RPC layer. The impact is a denial of service in the RPC client, and the user chooses `RPC_URL`. No key or fund exposure. |
| `@ethersproject/*@5.8.0` via Irys | Low | The Irys bundler carries ethers v5 for Arweave signing. Its `elliptic@6.6.1` path has CVE-2025-14505, and no fixed upstream release exists. The toolkit's Solana signing uses ed25519, not this secp256k1 path. |
| `@irys/*` and Metaplex `umi-*` moderates | Low / Moderate | Transitive from the same `web3.js` and ethers chains. No direct vulnerable code path in the toolkit. |
| Temporary batch key in memory (removed 2026-11-15) | Removed | The browser-only release removed the temp key, delegation and sweep. The wallet owns every item and signs each mint; `state/` reconciles in-flight transactions by signature. |

## Verification performed

- `npm run typecheck` passes.
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
- Historical (before the browser-only release): a live Phantom run created
  collection `AASPbqHYjzjPrGKfo8NobjaGHTPbSZn6gK6mEaHB3Sxm` with 24/24 verified
  items. That run exercised the bridge, the temporary key, the delegation, the
  sweep, and the revocation with a real extension.
- `npm audit` now reports 0 critical and 0 high findings.
- `skillspector scan <repository> --no-llm` reports 1 low finding: the
  `elliptic@6.6.1` advisory reached through the Irys bundler. There are no high
  or medium findings.
- Browser-only skill, 2026-11-15: `skillspector scan
  skills/solana-nft-creation --no-llm` (v2.12.0) reports 0/100 LOW, 0 issues,
  100% coverage. The repository scan still reaches the same single low
  `elliptic` advisory in the CLI dependency tree, not in the skill package.
- GitHub Actions: run `43647919047` passed on the release commit; run
  `43648375649` passed every step after the workflow gained the label, bridge,
  security and audit checks.
- Browser-only release: `typecheck`, `test:state` (15 cases), `test:labels`
  (17), `test:security` (15) and `test:bridge` (26) pass; `test:e2e` is manual
  and skips without `E2E_BROWSER=1`.

## Limitations

- CI now runs the same checks on every push and pull request: typecheck, labels,
  bridge, security, and `npm audit --audit-level=high`. Run `43647919047` passed
  on the release commit and run `43648375649` passed with the expanded workflow.
  The earlier billing lock is resolved.
- Real Phantom/Solflare extensions cannot be driven by the automated tests. The
  bridge is covered by a scripted Wallet Standard wallet; the live run is the
  real-extension evidence.
- SkillSpector runs with `--no-llm` for a deterministic release check. The one
  remaining low finding is a transitive `elliptic@6.6.1` advisory with no fixed
  upstream release; the code path belongs to the Irys bundler, not the Solana
  ed25519 signing flow.
- `test:e2e` needs `solana-test-validator`, which is not installed here.

## How to re-check

```bash
npm ci
npm audit
npm run typecheck
npm run test:labels
npm run test:bridge
npm run test:security
```

Read `SECURITY.md` before a mainnet launch.
