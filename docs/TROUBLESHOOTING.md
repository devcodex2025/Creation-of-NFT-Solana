# Troubleshooting

## Environment

### `No keypair found`

The CLI looks in `KEYPAIR_PATH`, `./keypair.json`, then
`~/.config/solana/id.json`. Create one:

```bash
npm run keypair
```

If you already have a keypair elsewhere, point to it:

```bash
KEYPAIR_PATH=/absolute/path/id.json npm run balance
```

### `410 Gone` when running `npm run fund`

The public devnet RPC faucet is closed. `fund` is only reliable on a local
validator. For devnet use [faucet.solana.com](https://faucet.solana.com), or run
a local validator (free, unlimited):

```bash
solana-test-validator --reset \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
SOLANA_CLUSTER=localnet npm run fund -- --amount 5
```

### `Attempt to load a program that does not exist`

The validator does not have the Metaplex Token Metadata program. Start it with:

```bash
solana-test-validator --reset \
  --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
```

### `429` or `Too Many Requests` from the RPC

Use a dedicated RPC (Helius, QuickNode, Triton) and set `RPC_URL` in `.env`.

## Minting

### `insufficient funds for rent`

The wallet needs roughly `0.015–0.03 SOL` per NFT plus fees. Check with
`npm run balance`; fund it before retrying.

### `Name "..." is N bytes; Metaplex allows at most 32`

The on-chain name is limited to 32 UTF-8 bytes, not characters. Emoji and
Cyrillic characters use 2+ bytes. Shorten the name.

### `Collection verification transaction confirmed, but the NFT is still unverified`

The wallet is not the update authority of the collection. Either:

- run `verify` with the collection authority keypair, or
- create the collection from the same wallet.

### `Transaction simulation failed: ... custom program error: 0x...`

Convert the hex error with the
[Token Metadata error list](https://developers.metaplex.com/token-metadata/errors).
The most common ones:

| Code | Meaning | Fix |
|---|---|---|
| `0x0` | Invalid instruction | Usually a mismatched program version |
| `0x1` | Invalid account | Wrong mint/collection address |
| `0x4` | Invalid authority | Wrong update authority |
| `0x6` | Invalid owner | Mint not owned by the Token program |

### Mint succeeded, but the marketplace shows no image

The metadata URI must be publicly reachable. Check it in a browser. With
`STORAGE=local` the URI is `file://…` and only works on your machine — that is
expected for tests.

## Updating

### `Wallet ... is not the update authority`

Only the update authority can call `updateV1`. Use the original wallet, or ask
the current authority to sign. The error prints the current authority.

### Attributes disappeared after an update

Fixed in 2.0.0: the command merges the previous off-chain JSON. If the old URI
is unreachable, pass `--attributes` or `--json` explicitly.

### I want to make the NFT immutable

```bash
npm run update -- --mint <address> --immutable
```

This is permanent. There is no way to reverse it.

## Storage

### Irys upload is slow or fails

- Confirm the wallet has devnet/mainnet SOL.
- Check `IRYS_ADDRESS` if you run your own bundler.
- Retry: uploads are idempotent at the file level, but a new transaction is
  created each time.
- For local tests use `STORAGE=local`.

### The image uploads but the JSON does not

`uploadJson` also costs a (tiny) amount on Irys. Top up the wallet. With Irys
devnet, the funding transaction needs a minimum amount for rent; a wallet with
less than ~0.001 SOL can fail even though the price is lower.

## Windows notes

- PowerShell strips inner quotes from `--attributes '[...]'`. Prefer a JSON
  template file: `--json metadata/nft.example.json`.
- Use `solana-test-validator.exe` from the Agave release, or run it in WSL.
- If the ledger directory is on a restricted path, pass `--ledger` to a
  user-writable folder.
