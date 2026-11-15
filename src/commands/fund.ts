import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getNumber, getString, parseArgs } from "../lib/args";
import { connectBrowserWallet } from "../lib/browser-bridge";
import { cluster, connection, rpcUrl } from "../lib/config";

const flags = parseArgs();
const amount = getNumber(flags, "amount", 1);
let address = getString(flags, "address");

if (cluster === "mainnet-beta") {
  throw new Error("Refusing to airdrop on mainnet-beta. Use real SOL.");
}

if (!address) {
  const wallet = await connectBrowserWallet();
  address = wallet.publicKey;
  await wallet.close();
}

console.log(`\n🚰  Requesting ${amount} SOL on ${cluster}`);
console.log(`   Wallet : ${address}`);

try {
  const signature = await connection.requestAirdrop(
    new PublicKey(address),
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

const balance = await connection.getBalance(new PublicKey(address));
console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL (${rpcUrl})\n`);
