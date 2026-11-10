# Contributing

Thanks for helping make Solana NFT tooling better.

## Development setup

```bash
git clone https://github.com/devcodex2025/Creation-of-NFT-Solana
cd Creation-of-NFT-Solana
npm install
cp .env.example .env
npm run keypair
```

Run a local validator that has the Token Metadata program, then fund the wallet:

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
SOLANA_CLUSTER=localnet STORAGE=local RPC_URL=http://127.0.0.1:8899 npm run test:e2e
```

- Keep changes focused and typed.
- Never commit `keypair.json`, `.env`, `state/`, or `uploads/`.
- New commands go in `src/commands/` and must be wired into `package.json`.
- If you change metadata limits or flags, update the README and the skill docs.

## Commit style

Short, imperative, scoped:

```
feat: add batch mint command
fix: preserve attributes when updating metadata
docs: explain collection verification
```

## Security

Do not open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).
