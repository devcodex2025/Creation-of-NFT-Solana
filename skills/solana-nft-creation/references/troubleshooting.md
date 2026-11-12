# Troubleshooting Solana NFT mints

Work from the transaction logs outward. Most "NFT bugs" are one of: wrong
authority, unreachable URI, insufficient funds, or a local validator missing a
program.

## Read the error correctly

```bash
Error: Simulation failed.
Message: Transaction simulation failed: ...
Logs:
  ["Program metaqbxx... invoke [1]", ...]
```

- `custom program error: 0x4` — decode the code, do not guess.
- `Attempt to load a program that does not exist` — the validator does not
  have Token Metadata.
- `insufficient funds for rent` — balance too low.
- `blockhash not found` — retry with a fresh blockhash.

## Token Metadata errors

| Code | Name | Meaning / fix |
|---|---|---|
| `0x0` | `InstructionUnpackError` | Wrong program or corrupted instruction |
| `0x1` | `InstructionPackError` | Instruction data could not be serialized |
| `0x2` | `NotRentExempt` | Balance below the rent-exempt threshold |
| `0x4` | `Uninitialized` | Account was never initialized |
| `0x7` | `UpdateAuthorityIncorrect` | Signer is not the update authority |
| `0x8` | `UpdateAuthorityIsNotSigner` | Authority must sign the transaction |
| `0xB` | `NameTooLong` | Name over 32 bytes |
| `0xC` | `SymbolTooLong` | Symbol over 10 bytes |
| `0xD` | `UriTooLong` | URI over 200 bytes |
| `0x24` | `CreatorsTooLong` | More than 5 creators |
| `0x29` | `InvalidBasisPoints` | Royalty over 10000 bps |
| `0x3B` | `DataIsImmutable` | Metadata is immutable |
| `0x50` | `CollectionNotFound` | No collection set on the metadata |
| `0x51` | `InvalidCollectionUpdateAuthority` | Wrong collection authority |
| `0x68` | `NotAMemberOfCollection` | Item references a different collection |
| `0x69` | `NotVerifiedMemberOfCollection` | Verify the item first |
| `0x6A` | `NotACollectionParent` | Collection NFT lacks `isCollection` |
| `0x72` | `AlreadyVerified` | Treat as success |
| `0x73` | `AlreadyUnverified` | Nothing to do |
| `0xB7` | `InvalidUpdateArgs` | Update payload is not allowed |

The `verify` step failing with `0x4` almost always means: sign with the
collection's update authority, not the item's.

## Mint succeeds, marketplaces show nothing

1. Open the `uri` in a browser. If it fails, fix storage first.
2. Check `image` inside the JSON. Relative paths and marketplace pages are
   wrong.
3. Check `content-type` of both files.
4. Confirm collection verification:

```ts
const asset = await fetchDigitalAsset(umi, mint);
console.log(asset.metadata.collection);
```

5. Wait. Indexers cache; some take minutes. Force-refresh metadata in the
   marketplace if it offers that.
6. Check the token standard. A fungible or semi-fungible asset is not an NFT.

## Verification fails or reverts

- The collection NFT must have been created with `isCollection: true`.
- The item must reference the same collection mint.
- The authority must be the collection's update authority or a collection
  delegate.
- If the item is already verified, calling verify again may fail; treat
  "already verified" as success.

## Updates do not change the image

Updating the on-chain `uri` does not rewrite Arweave. You must:

1. upload a new JSON with the new `image`,
2. call `updateV1` with the new `uri`.

If you changed only the image file at the same URI (impossible on Arweave), the
old data still wins.

## Updates wipe attributes

The new JSON replaced the old one without merging. Fetch the old JSON, spread
its fields, then override the changed ones. See `code-recipes.md`.

## Local validator problems

| Symptom | Fix |
|---|---|
| `Attempt to load a program that does not exist` | Add `--clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| `Address already in use` | Another validator is running; use different `--rpc-port`, `--faucet-port`, `--gossip-port` and `--dynamic-port-range` |
| Ledger permission denied on Windows | Use a ledger path you own, or run the validator in WSL |
| Airdrop fails | Use the validator's faucet port or `solana airdrop` against it |
| Old data after redeploy | `--reset` and restart from a clean ledger |

## RPC problems

- `429 Too Many Requests`: use a dedicated RPC or back off with jitter.
- `Blockhash not found`: fetch a fresh blockhash per attempt.
- Websocket drops during confirmation: poll `getSignatureStatuses` instead.
- `Node is behind`: switch RPC; do not submit a mint against a lagging node.

## Wallet problems

- Wallet shows the NFT but not the image: storage, not the wallet.
- "Unverified" badge: collection verification missing.
- Cannot transfer: frozen account or pNFT rule set.
- Balance too low after several mints: rent adds up; check `npm run balance`.

## When to stop and ask

- The collection was created with the wrong key and you do not control it.
- Metadata is immutable and wrong.
- Real art was uploaded before a planned reveal.
- Funds were sent to the wrong address.

These are chain-level states. No script fixes them; plan the recovery
(rebrand, new collection, burn) instead of retrying transactions.
