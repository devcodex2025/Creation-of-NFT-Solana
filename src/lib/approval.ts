import type { Transaction as UmiTransaction } from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";
import type { RequestContext } from "./browser-bridge";

/**
 * Turns a compiled transaction into the facts a person needs before signing:
 * who receives SOL, how much, the estimated fee, which programs run, and the
 * full list of operations. Everything here is derived from the transaction
 * itself, so a wallet prompt cannot describe an action that the bytes do not
 * perform.
 */

export type BrowserAction =
  | "collection"
  | "nft"
  | "update"
  | "verify"
  | "batch"
  | "transaction";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const PROGRAM_NAMES: Record<string, string> = {
  [SYSTEM_PROGRAM_ID]: "System",
  [METADATA_PROGRAM_ID]: "Token Metadata",
  [COMPUTE_BUDGET_PROGRAM_ID]: "Compute Budget",
  [ASSOCIATED_TOKEN_PROGRAM_ID]: "Associated Token Account",
  [TOKEN_PROGRAM_ID]: "Token",
  [TOKEN_2022_PROGRAM_ID]: "Token 2022",
};

/** Base fee is 5,000 lamports per required signature. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Runtime default when a transaction sets a price but no unit limit. */
const DEFAULT_COMPUTE_UNITS = 200_000n;

function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function readU32LE(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 4) return null;
  return (
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24)
  ) >>> 0;
}

function readU64LE(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function priorityFee(transaction: UmiTransaction): bigint {
  let units = DEFAULT_COMPUTE_UNITS;
  let price = 0n;
  let sawPrice = false;

  for (const instruction of transaction.message.instructions) {
    const programId = transaction.message.accounts[instruction.programIndex];
    if (programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const kind = instruction.data[0];
    if (kind === 2) {
      const limit = readU32LE(instruction.data, 1);
      if (limit !== null && limit > 0) units = BigInt(limit);
    }
    if (kind === 3) {
      const microLamports = readU64LE(instruction.data, 1);
      if (microLamports !== null) {
        price = microLamports;
        sawPrice = true;
      }
    }
  }

  if (!sawPrice || price === 0n) return 0n;
  // Round up so the estimate never understates the fee.
  return (price * units + 999_999n) / 1_000_000n;
}

function programName(programId: string): string {
  return PROGRAM_NAMES[programId] ?? programId;
}

export function describeTransaction(
  transaction: UmiTransaction,
  action: BrowserAction,
  requiredSignatures = 1,
): RequestContext {
  const { accounts, instructions } = transaction.message;
  const operations: string[] = [];
  const programs: string[] = [];
  const transfers: Array<{ recipient: string; lamports: bigint }> = [];
  let sawSystemTransfer = false;
  let unknownProgram: string | null = null;
  let baseLabel: string | null = null;
  let baseDetail = "";

  const rememberProgram = (programId: string) => {
    const name = programName(programId);
    if (!programs.includes(name)) programs.push(name);
  };

  for (const instruction of instructions) {
    const programId = accounts[instruction.programIndex];
    const name = programName(programId);
    const data = instruction.data;
    rememberProgram(programId);

    if (programId === SYSTEM_PROGRAM_ID) {
      const kind = data[0];
      if (kind === 2) {
        sawSystemTransfer = true;
        const lamports = readU64LE(data, 4);
        const recipientIndex = instruction.accountIndexes[1];
        const recipient =
          recipientIndex === undefined ? undefined : accounts[recipientIndex];
        if (lamports !== null && recipient) {
          transfers.push({ recipient, lamports });
          operations.push(
            `Transfer ${formatSol(lamports)} SOL to ${recipient}`,
          );
          continue;
        }
        operations.push("System transfer (could not decode)");
        continue;
      }
      if (kind === 0) {
        const lamports = readU64LE(data, 4);
        const owner =
          data.length >= 52 ? base58.deserialize(data.slice(20, 52))[0] : null;
        operations.push(
          `Create account${owner ? ` owned by ${programName(owner)}` : ""}` +
            (lamports === null ? "" : ` with ${formatSol(lamports)} SOL`),
        );
        continue;
      }
      operations.push(`System instruction ${kind ?? "?"}`);
      continue;
    }

    if (programId === METADATA_PROGRAM_ID) {
      if (data[0] === 44) {
        baseLabel = "Approve collection delegation";
        baseDetail =
          "Lets the temporary batch key verify items in this collection.";
        operations.push("Delegate collection verification");
        continue;
      }
      if (data[0] === 45) {
        baseLabel = "Revoke collection delegation";
        baseDetail = "Removes the temporary batch key's permission.";
        operations.push("Revoke collection delegation");
        continue;
      }
      if (data[0] === 52 && data[1] === 1) {
        operations.push("Verify collection membership");
        continue;
      }
      if (data[0] === 52 && data[1] === 0) {
        operations.push("Verify creator");
        continue;
      }
      if (data[0] === 42) {
        operations.push(
          action === "collection" ? "Create collection NFT" : "Create NFT",
        );
        continue;
      }
      if (data[0] === 43) {
        operations.push("Mint token to the owner");
        continue;
      }
      if (data[0] === 50) {
        operations.push("Update metadata account");
        continue;
      }
      if (data[0] === 14) {
        operations.push("Create master edition");
        continue;
      }
      operations.push(`Token Metadata instruction ${data[0] ?? "?"}`);
      continue;
    }

    if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
      // Compute budget instructions only shape the fee, which is reported
      // separately; listing them here would bury the real operations.
      continue;
    }

    if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      operations.push("Create associated token account");
      continue;
    }

    if (
      programId === TOKEN_PROGRAM_ID ||
      programId === TOKEN_2022_PROGRAM_ID
    ) {
      operations.push(`${name} instruction ${data[0] ?? "?"}`);
      continue;
    }

    unknownProgram = unknownProgram ?? programId;
    operations.push(`Call program ${programId}`);
  }

  const fee =
    LAMPORTS_PER_SIGNATURE * BigInt(Math.max(1, requiredSignatures)) +
    priorityFee(transaction);

  const facts: Array<{ label: string; value: string }> = [];
  if (transfers.length === 1) {
    facts.push({ label: "Recipient", value: transfers[0].recipient });
    facts.push({
      label: "Amount",
      value: `${formatSol(transfers[0].lamports)} SOL`,
    });
  } else if (transfers.length > 1) {
    transfers.forEach((transfer, index) => {
      facts.push({
        label: `Transfer ${index + 1}`,
        value: `${formatSol(transfer.lamports)} SOL to ${transfer.recipient}`,
      });
    });
  }
  facts.push({
    label: "Network fee",
    value:
      `~${formatSol(fee)} SOL` +
      ` (${Math.max(1, requiredSignatures)} signature` +
      `${requiredSignatures === 1 ? "" : "s"}${fee > LAMPORTS_PER_SIGNATURE * BigInt(Math.max(1, requiredSignatures)) ? " + priority" : ""})`,
  });
  if (programs.length > 0) {
    facts.push({ label: "Programs", value: programs.join(", ") });
  }

  // The label names the intent. Delegation wins over the create instruction it
  // shares a transaction with, and system transfers get an action-specific name.
  let label: string | null = baseLabel;
  let detail = baseDetail;

  if (!label && (transfers.length > 0 || sawSystemTransfer)) {
    if (action === "batch") {
      label = "Approve batch funding";
      detail = "Sends SOL to the temporary batch key for rent and uploads.";
    } else {
      label = "Approve storage payment";
      detail = "Pays Irys for the Arweave upload.";
    }
  }

  if (!label && operations.some((op) => op.startsWith("Verify collection"))) {
    label = "Approve collection verification";
    detail = "Marks the NFT as a verified member of its collection on chain.";
  }
  if (!label && operations.some((op) => op === "Verify creator")) {
    label = "Approve creator verification";
    detail = "Marks the wallet as a verified creator of these NFTs.";
  }
  if (!label && operations.some((op) => op === "Create collection NFT")) {
    label = "Approve collection creation";
    detail = "Creates the collection NFT and its metadata account.";
  }
  if (!label && operations.some((op) => op === "Create NFT")) {
    label = "Approve NFT mint";
    detail = "Creates the NFT and its metadata account.";
  }
  if (!label && action === "update") {
    label = "Approve metadata update";
    detail = "Writes the new metadata to the NFT.";
  }
  if (!label) {
    label = "Approve transaction";
    detail = "Signs a Solana transaction built by the CLI.";
  }

  if (unknownProgram) {
    detail += ` This transaction also calls ${unknownProgram}, which this toolkit does not recognise.`;
  }

  return { label, detail, facts, operations };
}
