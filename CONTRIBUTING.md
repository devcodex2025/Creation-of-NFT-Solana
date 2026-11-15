# Contributing

Thanks for helping make Solana NFT tooling better.

## Development setup

```bash
git clone https://github.com/devcodex2025/Creation-of-NFT-Solana
cd Creation-of-NFT-Solana
npm install
npm run balance
```

`npm run balance` opens the local browser bridge; connect Phantom, Solflare or
Backpack and it prints the wallet address. The CLI is browser-only: do not add a
keypair-file mode.

Copy `.env.example` to `.env` only when you need to override the devnet
defaults. Run a local validator that has the Token Metadata program, then fund
the connected wallet:

```bash
solana-test-validator --reset \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s

# in another terminal
SOLANA_CLUSTER=localnet npm run fund -- --amount 5
```

On Windows PowerShell:

```powershell
$env:SOLANA_CLUSTER="localnet"
npm run fund -- --amount 5
```

## Checks before opening a PR

```bash
npm run typecheck
npm run test:state
npm run test:labels
npm run test:security
npm run test:bridge
```

`test:e2e` needs a human at the keyboard and a browser wallet. It is skipped
unless `E2E_BROWSER=1`:

```bash
SOLANA_CLUSTER=localnet STORAGE=local RPC_URL=http://127.0.0.1:8899 E2E_BROWSER=1 npm run test:e2e
```

- Keep changes focused and typed.
- Never commit `.env`, `state/`, `uploads/`, or a wallet export.
- New commands go in `src/commands/` and must be wired into `package.json`.
- After changing dependencies, run `npm run pin:lock` so `package.json` and
  `package-lock.json` keep exact versions.
- If you change metadata limits or flags, update the README and the skill docs.
- Do not add a keypair path, `KEYPAIR_PATH`, or local secret loading. Signing is
  browser-only by design.

## Commit style

Short, imperative, scoped:

```
feat: add batch mint command
fix: preserve attributes when updating metadata
docs: explain collection verification
```

## Security

Do not open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).
