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

function txWithAccounts(
  accounts: string[],
  programIndex: number,
  accountIndexes: number[],
  data: number[],
): UmiTransaction {
  return {
    message: {
      instructions: [{ programIndex, accountIndexes, data: Uint8Array.from(data) }],
      accounts,
    },
  } as unknown as UmiTransaction;
}

function lamports(value: bigint): number[] {
  const bytes = new Array<number>(8).fill(0);
  for (let i = 0; i < 8; i += 1) {
    bytes[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
  return bytes;
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
  "creator verification",
  describeTransaction(tx([METADATA], [[52, 0]]), "batch").label ?? "",
  "Approve creator verification",
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
check(
  "collection create plus delegation",
  describeTransaction(
    tx([METADATA, METADATA], [
      [42, 0],
      [44, 0],
    ]),
    "batch",
  ).label ?? "",
  "Approve collection delegation",
);
check(
  "batch funding plus delegation",
  describeTransaction(
    tx([SYSTEM, METADATA], [
      [2, 0, 0, 0],
      [44, 0],
    ]),
    "batch",
  ).label ?? "",
  "Approve collection delegation",
);
check(
  "revoking delegation",
  describeTransaction(tx([METADATA], [[45, 0]]), "batch").label ?? "",
  "Revoke collection delegation",
);

const RECIPIENT = "6fFX4ZSTPMEDiizZwEhqcff7beBZDTs338Bk1TbAgEiR";
const funding = txWithAccounts(
  ["FHL1oz55LDXcaovK4f2XYBLcHWFiqvwgB9gAEYzjFYG7", RECIPIENT, SYSTEM],
  2,
  [0, 1],
  [2, 0, 0, 0, ...lamports(500_000_000n)],
);
const fundingContext = describeTransaction(funding, "batch", 1);
check(
  "funding shows the recipient",
  fundingContext.facts?.find((fact) => fact.label === "Recipient")?.value ?? "",
  RECIPIENT,
);
check(
  "funding shows the amount",
  fundingContext.facts?.find((fact) => fact.label === "Amount")?.value ?? "",
  "0.5 SOL",
);
check(
  "funding shows the base fee",
  fundingContext.facts?.find((fact) => fact.label === "Network fee")?.value ?? "",
  "~0.000005 SOL (1 signature)",
);
check(
  "funding lists the transfer operation",
  fundingContext.operations?.[0] ?? "",
  `Transfer 0.5 SOL to ${RECIPIENT}`,
);

const unknownProgram = describeTransaction(
  tx(["UnknownProgram111111111111111111111111111111"], [[0]]),
  "nft",
);
check(
  "unknown program is named in the warning",
  unknownProgram.detail?.includes("UnknownProgram111111111111111111111111111111")
    ? "yes"
    : "no",
  "yes",
);
check(
  "unknown program is listed as an operation",
  unknownProgram.operations?.[0] ?? "",
  "Call program UnknownProgram111111111111111111111111111111",
);

if (failures.length > 0) {
  console.error(`\n❌ Label tests failed (${failures.length})`);
  process.exit(1);
}

console.log("\n✅ Label tests passed");
