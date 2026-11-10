import "dotenv/config";
import { Connection, LAMPORTS_PER_SOL, clusterApiUrl } from "@solana/web3.js";

export type Cluster = "devnet" | "testnet" | "mainnet-beta" | "localnet";

function normalizeCluster(value: string): Cluster {
  const cluster = value.trim().toLowerCase();
  if (cluster === "mainnet") return "mainnet-beta";
  if (cluster === "dev" || cluster === "devnet") return "devnet";
  if (cluster === "local" || cluster === "localnet" || cluster === "localhost") {
    return "localnet";
  }
  if (cluster === "testnet") return "testnet";
  if (cluster === "mainnet-beta") return "mainnet-beta";
  throw new Error(
    `Unknown cluster "${value}". Use devnet, testnet, mainnet-beta or localnet.`,
  );
}

export const cluster: Cluster = normalizeCluster(
  process.env.SOLANA_CLUSTER ?? "devnet",
);

export const rpcUrl =
  process.env.RPC_URL ??
  (cluster === "localnet"
    ? "http://127.0.0.1:8899"
    : clusterApiUrl(cluster));

export const connection = new Connection(rpcUrl, "confirmed");

export const explorerClusterQuery =
  cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;

export const lamportsPerSol = LAMPORTS_PER_SOL;

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}${explorerClusterQuery}`;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerClusterQuery}`;
}
