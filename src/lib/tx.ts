import type { TransactionBuilder, Umi } from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";

const RATE_LIMIT_RETRIES = 4;

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.toLowerCase().includes("too many requests");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a transaction and waits for finalized commitment. Public RPC endpoints
 * answer 429 under load, so a rejected send is retried with backoff. A 429 means
 * the node did not accept the transaction, which makes the retry safe.
 */
export async function sendAndConfirm(
  umi: Umi,
  builder: TransactionBuilder,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { signature } = await builder.sendAndConfirm(umi, {
        send: { commitment: "finalized" },
      });
      return base58.deserialize(signature)[0];
    } catch (error) {
      if (!isRateLimit(error) || attempt >= RATE_LIMIT_RETRIES) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}

export function shortAddress(address: string, size = 6): string {
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}
