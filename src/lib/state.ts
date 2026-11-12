import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { cluster } from "./config";
import { repoRoot } from "./keypair";

export interface NftRecord {
  address: string;
  name: string;
  uri: string;
  signature: string;
  collection?: string;
  verified?: boolean;
  createdAt: string;
}

export interface CollectionRecord {
  address: string;
  name: string;
  symbol: string;
  uri: string;
  signature: string;
  createdAt: string;
}

export interface ProjectState {
  cluster: string;
  wallet?: string;
  collection?: CollectionRecord;
  nfts: NftRecord[];
}

function stateFilePath(): string {
  const dir = process.env.STATE_DIR
    ? path.resolve(repoRoot, process.env.STATE_DIR)
    : path.join(repoRoot, "state");
  return path.join(dir, `${cluster}.json`);
}

export function readState(): ProjectState {
  const file = stateFilePath();
  if (!existsSync(file)) {
    return { cluster, nfts: [] };
  }

  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectState>;
  return {
    cluster,
    wallet: parsed.wallet,
    collection: parsed.collection,
    nfts: Array.isArray(parsed.nfts) ? parsed.nfts : [],
  };
}

function writeState(state: ProjectState): void {
  const file = stateFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function saveCollection(record: CollectionRecord): void {
  const state = readState();
  state.collection = record;
  writeState(state);
}

export function saveNft(record: NftRecord): void {
  const state = readState();
  const existingIndex = state.nfts.findIndex(
    (nft) => nft.address === record.address,
  );
  if (existingIndex >= 0) state.nfts[existingIndex] = record;
  else state.nfts.push(record);
  writeState(state);
}

export function updateNftRecord(
  address: string,
  patch: Partial<NftRecord>,
): void {
  const state = readState();
  const record = state.nfts.find((nft) => nft.address === address);
  if (!record) return;
  Object.assign(record, patch);
  writeState(state);
}

/**
 * The collection is an NFT too, so updating it should not leave a stale name
 * and URI in state while the chain holds the new ones.
 */
export function updateCollectionRecord(
  patch: Partial<CollectionRecord>,
): void {
  const state = readState();
  if (!state.collection) return;
  Object.assign(state.collection, patch);
  writeState(state);
}

export function setWallet(address: string): void {
  const state = readState();
  state.wallet = address;
  writeState(state);
}

export function stateFile(): string {
  return stateFilePath();
}
