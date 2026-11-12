import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getString, parseArgs } from "../lib/args";
import { connectBrowserWallet } from "../lib/browser-bridge";
import { cluster, connection, explorerAddressUrl, rpcUrl } from "../lib/config";
import { loadKeypair } from "../lib/keypair";
import { setWallet } from "../lib/state";
import { resolveSignerMode } from "../lib/umi";

const flags = parseArgs();
const explicitAddress = getString(flags, "address");
const signerMode = resolveSignerMode(
  getString(flags, "signer", process.env.SIGNER),
);

let address = explicitAddress;
if (!address && signerMode === "browser") {
  const wallet = await connectBrowserWallet();
  address = wallet.publicKey;
  await wallet.close();
} else if (!address) {
  const keypair = loadKeypair(getString(flags, "keypair"));
  address = keypair.publicKey.toBase58();
  setWallet(address);
}

const balanceLamports = await connection.getBalance(new PublicKey(address));
const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

console.log(`\n💰  Balance`);
console.log(`   Cluster : ${cluster} (${rpcUrl})`);
console.log(`   Address : ${address}`);
console.log(`   Balance : ${balanceSol} SOL`);
console.log(`   Explorer: ${explorerAddressUrl(address)}`);

if (balanceSol < 0.02) {
  console.log(
    `\n⚠️  Low balance. Minting a collection or NFT costs roughly 0.02–0.04 SOL in rent and fees.`,
  );
  if (cluster === "localnet") {
    console.log(`   Fund it with: npm run fund -- --amount 5`);
  } else if (cluster === "devnet") {
    console.log(
      `   Fund it at https://faucet.solana.com, or run a local validator and use SOLANA_CLUSTER=localnet.`,
    );
  }
}
console.log("");
