import { describeTransaction } from "../src/lib/umi";
import type { Transaction as UmiTransaction } from "@metaplex-foundation/umi";

/**
 * The approval page shows a label for every signature. These cases pin the
 * mapping from instruction bytes to that label, so a change in the SDK or in
 * the instruction order cannot turn a mint into "Approve transaction" silently.
 */

const METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM = "11111111111111111111111111111111";

function tx(programIds: string[], datas: number[][]): UmiTransaction {
  return {
    message: {
      instructions: programIds.map((_, index) => ({
        programIndex: index,
        accountIndexes: [],
        data: Uint8Array.from(datas[index]),
      })),
      accounts: programIds,
    },
  } as unknown as UmiTransaction;
}

const failures: string[] = [];

function check(name: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`   ✓ ${name}`);
  } else {
    console.log(`   ✗ ${name} — expected "${expected}", got "${actual}"`);
    failures.push(name);
  }
}

console.log("\n🏷️  Request labels\n");

check(
  "collection create",
  describeTransaction(tx([METADATA], [[42, 0]]), "collection").label ?? "",
  "Approve collection creation",
);
check(
  "item mint",
  describeTransaction(tx([METADATA], [[42, 0]]), "nft").label ?? "",
  "Approve NFT mint",
);
check(
  "collection verification",
  describeTransaction(tx([METADATA], [[52, 1]]), "nft").label ?? "",
  "Approve collection verification",
);
check(
  "storage payment",
  describeTransaction(tx([SYSTEM], [[2, 0, 0, 0]]), "nft").label ?? "",
  "Approve storage payment",
);
check(
  "metadata update",
  describeTransaction(tx([METADATA], [[50, 1]]), "update").label ?? "",
  "Approve metadata update",
);
check(
  "unknown transaction",
  describeTransaction(tx([SYSTEM], [[0, 0, 0, 0]]), "nft").label ?? "",
  "Approve transaction",
);
check(
  "mint wins over a system instruction in the same transaction",
  describeTransaction(
    tx([SYSTEM, METADATA], [
      [0, 0, 0, 0],
      [42, 0],
    ]),
    "nft",
  ).label ?? "",
  "Approve NFT mint",
);

if (failures.length > 0) {
  console.error(`\n❌ Label tests failed (${failures.length})`);
  process.exit(1);
}

console.log("\n✅ Label tests passed");
