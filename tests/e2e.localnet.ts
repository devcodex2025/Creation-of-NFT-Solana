/**
 * End-to-end test against a local validator.
 *
 * Prerequisites:
 *   1. solana-test-validator with the Token Metadata program available:
 *        solana-test-validator --reset \
 *          --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
 *   2. A funded keypair in ./keypair.json:
 *        npm run fund -- --amount 5
 *
 * Run:
 *   npm run test:e2e
 *
 * Defaults to localnet + local storage so the test never spends real SOL.
 * Override with SOLANA_CLUSTER / RPC_URL / STORAGE if you know what you are doing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

process.env.SOLANA_CLUSTER ??= "localnet";
process.env.STORAGE ??= "local";
process.env.RPC_URL ??=
  process.env.SOLANA_CLUSTER === "localnet"
    ? "http://127.0.0.1:8899"
    : process.env.RPC_URL;

const runId = Date.now().toString(36);
process.env.STATE_DIR ??= `.tmp/state-${runId}`;

const repoRoot = process.cwd();
const esrunBin = path.join(repoRoot, "node_modules", "esrun", "bin.js");

function run(script: string, args: string[] = []): string {
  const result = spawnSync(
    process.execPath,
    [esrunBin, path.join("src", "commands", script), ...args],
    { cwd: repoRoot, env: process.env, encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${script} failed with exit code ${result.status}`);
  }

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runExpectingFailure(script: string, args: string[]): string {
  const result = spawnSync(
    process.execPath,
    [esrunBin, path.join("src", "commands", script), ...args],
    { cwd: repoRoot, env: process.env, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0, `${script} should have failed`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

if (process.env.SOLANA_CLUSTER === "mainnet-beta") {
  throw new Error("Refusing to run the e2e test against mainnet-beta.");
}

const { cluster } = await import("../src/lib/config");
const { createProjectUmi } = await import("../src/lib/umi");
const { summarizeAsset } = await import("../src/lib/asset");
const { readState } = await import("../src/lib/state");

const umi = await createProjectUmi();
const balance = await umi.rpc.getBalance(umi.identity.publicKey);

console.log(`\n🧪 E2E on ${cluster} as ${umi.identity.publicKey}`);
console.log(`   Balance: ${Number(balance.basisPoints) / 1e9} SOL\n`);

if (Number(balance.basisPoints) < 20_000_000) {
  throw new Error(
    "Wallet needs at least 0.02 SOL. Run `npm run fund -- --amount 5` (localnet) or fund it from a faucet.",
  );
}

console.log("1/7  create:collection");
const collectionOutput = run("create-collection.ts", [
  "--name",
  `E2E Collection ${runId}`,
  "--symbol",
  "E2E",
  "--description",
  "Collection created by the e2e test.",
  "--image",
  "assets/lil_turtle_collection.webp",
  "--royalty",
  "2.5",
]);
assert.match(collectionOutput, /Collection created/);

const afterCollection = readState();
assert.ok(afterCollection.collection, "collection should be persisted");
const collectionAddress = afterCollection.collection.address;
assert.ok(collectionAddress.length >= 32);

console.log("2/7  create:nft");
run("create-nft.ts", [
  "--json",
  "metadata/nft.example.json",
  "--name",
  `E2E Turtle ${runId}`,
  "--description",
  "Minted by the e2e test.",
  "--royalty",
  "5",
]);

const first = readState().nfts.at(-1);
assert.ok(first, "NFT should be persisted");
assert.equal(first.verified, true);
assert.equal(first.collection, collectionAddress);

const minted = await summarizeAsset(umi, first.address);
assert.equal(minted.name, `E2E Turtle ${runId}`);
assert.equal(minted.collection?.key, collectionAddress);
assert.equal(minted.collection?.verified, true);
assert.equal(minted.sellerFeeBasisPoints, 500);
assert.deepEqual(
  minted.attributes?.map((attribute) => attribute.trait_type),
  ["Background", "Headdress"],
);

console.log("3/7  update (keeps attributes and image)");
run("update-nft.ts", [
  "--mint",
  first.address,
  "--name",
  `E2E Turtle ${runId} Updated`,
  "--description",
  "Updated by the e2e test.",
]);

const updated = await summarizeAsset(umi, first.address);
assert.equal(updated.name, `E2E Turtle ${runId} Updated`);
assert.equal(updated.description, "Updated by the e2e test.");
assert.deepEqual(
  updated.attributes?.map((attribute) => attribute.trait_type),
  ["Background", "Headdress"],
  "attributes should survive an update",
);

console.log("4/7  verify (already verified is a no-op)");
const alreadyVerified = run("verify-collection.ts", [
  "--nft",
  first.address,
  "--collection",
  collectionAddress,
]);
assert.match(alreadyVerified, /Already verified/);

console.log("5/7  create:nft --skip-verify + verify");
run("create-nft.ts", [
  "--name",
  `E2E Unverified ${runId}`,
  "--image",
  "assets/lil_turtle.avif",
  "--skip-verify",
]);

const second = readState().nfts.at(-1);
assert.ok(second);
assert.equal(second.verified, false);

const unverified = await summarizeAsset(umi, second.address);
assert.equal(unverified.collection?.verified, false);

run("verify-collection.ts", [
  "--nft",
  second.address,
  "--collection",
  collectionAddress,
]);
const verified = await summarizeAsset(umi, second.address);
assert.equal(verified.collection?.verified, true);
assert.equal(readState().nfts.at(-1)?.verified, true);

console.log("6/7  show");
const shown = run("show-nft.ts", ["--mint", first.address]);
assert.match(shown, /Verified\s+: true/);
assert.match(shown, /Token standard\s+: NonFungible/);

console.log("7/7  validation guardrails");
const tooLong = runExpectingFailure("create-nft.ts", [
  "--name",
  "A name that is definitely longer than thirty-two bytes",
  "--image",
  "assets/lil_turtle.avif",
]);
assert.match(tooLong, /allows at most 32/);

const badRoyalty = runExpectingFailure("create-collection.ts", [
  "--name",
  "Bad royalty",
  "--royalty-bps",
  "20000",
]);
assert.match(badRoyalty, /between 0 and 10000/);

console.log(`\n✅ E2E passed`);
console.log(`   Collection: ${collectionAddress}`);
console.log(`   NFT 1     : ${first.address}`);
console.log(`   NFT 2     : ${second.address}`);
console.log(`   State dir : ${process.env.STATE_DIR}\n`);
