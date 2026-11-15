import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Write-ahead log regression tests. No wallet, no network.
 *
 * They prove the two properties the batch relies on: a mint is recorded before
 * it is broadcast, and a reset keeps the upload URIs so a retry does not pay
 * for Arweave twice. They also prove state writes are atomic and an invalid
 * state file is reported instead of silently replaced.
 */

const stateDir = `.tmp/state-wal-${Date.now()}`;
process.env.SOLANA_CLUSTER = "devnet";
process.env.STATE_DIR = stateDir;

const { readBatchItems, readState, resetBatchItem, saveBatchItem, stateFile } =
  await import("../src/lib/state");

const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`   ✓ ${name}`);
    return;
  }
  console.log(
    `   ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`,
  );
  failures.push(name);
}

function throws(name: string, fn: () => unknown): void {
  try {
    fn();
    console.log(`   ✗ ${name} — expected a throw`);
    failures.push(name);
  } catch {
    console.log(`   ✓ ${name}`);
  }
}

console.log("\n🧾  Batch write-ahead log\n");

const collection = "946RYfpz4C25VUk6gieFgWmVMJWncfZgmdEXKpArBPUa";
const mint = "8KbfSW3ifJFeywEDSH48GfNLrL4KuN1qUox76TiFD9W8";
const signature = `5${"1".repeat(87)}`;

saveBatchItem(collection, {
  name: "Item #1",
  imageUri: "https://gateway.irys.xyz/image",
  metadataUri: "https://gateway.irys.xyz/meta",
  address: mint,
  status: "pending",
});

let items = readBatchItems(collection);
check("mint address is recorded before broadcast", items[0]?.address, mint);
check("pending status is recorded", items[0]?.status, "pending");

saveBatchItem(collection, {
  name: "Item #1",
  signed: {
    signature,
    transaction: "AQID",
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 1,
  },
});

items = readBatchItems(collection);
check("signed bytes are persisted", items[0]?.signed?.transaction, "AQID");
check("signature is the idempotency key", items[0]?.signed?.signature, signature);

saveBatchItem(collection, {
  name: "Item #1",
  signature,
  status: "minted",
  signed: null,
});

items = readBatchItems(collection);
check("minted status replaces pending", items[0]?.status, "minted");
check("signed bytes are dropped after confirmation", items[0]?.signed, undefined);
check(
  "upload URIs survive confirmation",
  items[0]?.metadataUri,
  "https://gateway.irys.xyz/meta",
);

resetBatchItem(collection, "Item #1");
items = readBatchItems(collection);
check("reset drops the mint address", items[0]?.address, undefined);
check("reset drops the signature", items[0]?.signature, undefined);
check("reset drops the pending status", items[0]?.status, undefined);
check(
  "reset keeps the image URI",
  items[0]?.imageUri,
  "https://gateway.irys.xyz/image",
);
check(
  "reset keeps the metadata URI",
  items[0]?.metadataUri,
  "https://gateway.irys.xyz/meta",
);

const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as {
  batch?: { items?: unknown };
};
check("state file stays valid JSON", Array.isArray(raw.batch?.items), true);
const temps = readdirSync(path.dirname(stateFile())).filter((file) =>
  file.endsWith(".tmp"),
);
check("no temporary state file is left behind", temps.length, 0);

writeFileSync(stateFile(), "{ this is not json");
throws("an invalid state file is rejected, not replaced", () => readState());

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} write-ahead log test(s) failed\n`);
  process.exit(1);
}

console.log("\n✅ Write-ahead log tests passed\n");
