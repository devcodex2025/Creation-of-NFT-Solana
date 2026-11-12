import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getNumber, getString, parseArgs } from "../lib/args";
import { cluster, connection, rpcUrl } from "../lib/config";
import { loadKeypair } from "../lib/keypair";

const flags = parseArgs();
const amount = getNumber(flags, "amount", 1);

if (cluster === "mainnet-beta") {
  throw new Error("Refusing to airdrop on mainnet-beta. Use real SOL.");
}

const keypair = loadKeypair(getString(flags, "keypair"));

console.log(`\n🚰  Requesting ${amount} SOL on ${cluster}`);
console.log(`   Wallet : ${keypair.publicKey}`);

try {
  const signature = await connection.requestAirdrop(
    keypair.publicKey,
    Math.round(amount * LAMPORTS_PER_SOL),
  );
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature, ...latestBlockhash },
    "confirmed",
  );
  console.log(`   Signature: ${signature}`);
  console.log(`\n✅ Airdrop confirmed.\n`);
} catch (error) {
  const message = (error as Error).message;
  console.error(`\n❌ Airdrop failed: ${message}`);
  console.error(
    [
      "",
      "The public devnet faucet is rate-limited and often closed to direct RPC airdrops.",
      "Options:",
      "  1. https://faucet.solana.com (browser, captcha)",
      "  2. Run a local validator and test for free, no faucet limits:",
      "       solana-test-validator --reset",
      "       npm run fund -- --amount 100   # with SOLANA_CLUSTER=localnet",
      "  3. Programmatic proof-of-work faucet: https://github.com/solana-foundation/devnet-pow",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const balance = await connection.getBalance(keypair.publicKey);
console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL (${rpcUrl})\n`);
