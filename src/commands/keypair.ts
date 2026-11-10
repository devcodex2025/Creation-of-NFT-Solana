import { getString, parseArgs } from "../lib/args";
import { cluster } from "../lib/config";
import { createKeypairFile, defaultKeypairPath } from "../lib/keypair";

const flags = parseArgs();
const out = getString(flags, "out", defaultKeypairPath) as string;

const created = createKeypairFile(out);

console.log(`\n🔑  New keypair created`);
console.log(`   Cluster    : ${cluster}`);
console.log(`   Public key : ${created.publicKey}`);
console.log(`   File       : ${created.keypairPath}`);
console.log(
  `\n⚠️  This file is the private key. Never commit it or share it. Back it up safely.`,
);
console.log(
  `Fund it on devnet: https://faucet.solana.com (or run \`npm run fund\` on localnet).\n`,
);
