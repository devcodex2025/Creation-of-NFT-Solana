import type {
  Transaction,
  TransactionBuilder,
  TransactionSignature,
  Umi,
} from "@metaplex-foundation/umi";
import { base58, base64 } from "@metaplex-foundation/umi/serializers";

const SEND_RETRIES = 5;
const RPC_RETRIES = 4;
const RETRY_BASE_MS = 700;

/**
 * Everything needed to rebroadcast the exact same transaction after a crash.
 * The signature is the idempotency key: Solana never executes one signature
 * twice, so re-sending it is always safe.
 */
export interface SignedTransactionRecord {
  signature: string;
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SendAndConfirmOptions {
  /**
   * Called after the wallet signs and before the first broadcast. Persist the
   * record here: if the process dies, a re-run can check this signature instead
   * of minting a duplicate.
   */
  onSigned?: (record: SignedTransactionRecord) => void;
  /** Skip the pre-sign simulation. Only for trusted, already validated builders. */
  skipSimulation?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  return (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

/** The chain rejected the transaction. It will never land, so do not retry it. */
class TransactionFailedError extends Error {}

/** Retries read-only RPC calls that fail because the endpoint is throttled. */
export async function retryRpc<T>(
  action: () => Promise<T>,
  attempts = RPC_RETRIES,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isRetryable(error) || attempt >= attempts) throw error;
      await wait(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

/**
 * Runs the transaction against the current bank without a signature or a fee.
 * A program error stops the run before the wallet opens. A network error only
 * warns: the wallet still shows every instruction before it signs.
 */
async function simulate(
  umi: Umi,
  builder: TransactionBuilder,
): Promise<void> {
  // Build failures (size, missing signer) must stop here, not be swallowed.
  const preview = builder.build(umi);
  let result;
  try {
    result = await umi.rpc.simulateTransaction(preview, {
      commitment: "confirmed",
      verifySignatures: false,
    });
  } catch (error) {
    console.warn(`   Simulation unavailable: ${errorMessage(error)}`);
    return;
  }
  if (result.err) {
    const logs = (result.logs ?? []).slice(-12).join("\n");
    throw new Error(
      `Simulation failed before signing: ${JSON.stringify(result.err)}` +
        (logs ? `\n${logs}` : ""),
    );
  }
}

/**
 * Re-sends the same signed bytes. Never rebuilds: a new blockhash would create
 * a new signature and a chance to execute the same mint twice.
 */
async function sendWithRetry(
  umi: Umi,
  signed: Transaction,
  recorded: boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await umi.rpc.sendTransaction(signed, {
        commitment: "confirmed",
        skipPreflight: false,
        maxRetries: 3,
      });
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt >= SEND_RETRIES) {
        throw new Error(
          `Broadcast failed after ${attempt + 1} attempt(s): ${errorMessage(error)}. ` +
            (recorded
              ? "The signed transaction is recorded, so a re-run checks it before minting again."
              : "The node did not confirm the broadcast."),
        );
      }
      await wait(RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
}

async function signatureStatus(
  umi: Umi,
  signature: TransactionSignature,
) {
  try {
    const [status] = await retryRpc(() =>
      umi.rpc.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      }),
    );
    return status ?? null;
  } catch {
    return null;
  }
}

/**
 * Confirms at `confirmed`, not `finalized`: one block is enough for the next
 * step and saves ~13 seconds per transaction. The final on-chain check at the
 * end of the batch is what proves the result.
 */
async function confirm(
  umi: Umi,
  record: SignedTransactionRecord,
  recorded: boolean,
): Promise<void> {
  const signature = base58.serialize(record.signature);
  try {
    const result = await umi.rpc.confirmTransaction(signature, {
      commitment: "confirmed",
      strategy: {
        type: "blockhash",
        blockhash: record.blockhash,
        lastValidBlockHeight: record.lastValidBlockHeight,
      },
    });
    if (result.value.err) {
      throw new TransactionFailedError(
        `Transaction ${record.signature} failed on chain: ${JSON.stringify(result.value.err)}`,
      );
    }
  } catch (error) {
    if (error instanceof TransactionFailedError) throw error;
    // A failed poll is not proof of failure: the transaction may have landed.
    const status = await signatureStatus(umi, signature);
    if (status?.error) {
      throw new TransactionFailedError(
        `Transaction ${record.signature} failed on chain: ${JSON.stringify(status.error)}`,
      );
    }
    if (status?.commitment === "confirmed" || status?.commitment === "finalized") {
      return;
    }
    throw new Error(
      `Could not confirm ${record.signature}: ${errorMessage(error)}\n` +
        (recorded
          ? "It may still land. Re-run the same command: it checks the recorded signature before minting anything."
          : "It may still land. Check the signature on an explorer before retrying."),
    );
  }
}

/**
 * Signs once, records the signed bytes, then sends and confirms.
 *
 * Solana transactions are atomic, but the chain and this process cannot commit
 * together. Recording the signature before broadcasting closes that gap: after
 * a crash the next run can ask the chain whether the transaction landed instead
 * of creating a second mint with the same item name.
 */
export async function sendAndConfirm(
  umi: Umi,
  builder: TransactionBuilder,
  options: SendAndConfirmOptions = {},
): Promise<string> {
  const blockhash = await retryRpc(() =>
    umi.rpc.getLatestBlockhash({ commitment: "confirmed" }),
  );
  const prepared = builder.setBlockhash(blockhash);

  if (!options.skipSimulation) {
    await simulate(umi, prepared);
  }

  const signed = await prepared.buildAndSign(umi);
  const signatureBytes = signed.signatures[0];
  if (!signatureBytes || isZero(signatureBytes)) {
    throw new Error("The wallet returned an unsigned transaction. Nothing was sent.");
  }

  const record: SignedTransactionRecord = {
    signature: base58.deserialize(signatureBytes)[0],
    transaction: base64.deserialize(umi.transactions.serialize(signed))[0],
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
  options.onSigned?.(record);

  const recorded = Boolean(options.onSigned);
  await sendWithRetry(umi, signed, recorded);
  await confirm(umi, record, recorded);
  return record.signature;
}

export function shortAddress(address: string, size = 6): string {
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}
