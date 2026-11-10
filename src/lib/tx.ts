import type { TransactionBuilder, Umi } from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";

/** Sends a transaction and waits for finalized commitment. */
export async function sendAndConfirm(
  umi: Umi,
  builder: TransactionBuilder,
): Promise<string> {
  const { signature } = await builder.sendAndConfirm(umi, {
    send: { commitment: "finalized" },
  });
  return base58.deserialize(signature)[0];
}

export function shortAddress(address: string, size = 6): string {
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}
