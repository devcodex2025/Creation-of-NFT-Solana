import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { cluster } from "./config";
import { repoRoot } from "./paths";
import type { SignedTransactionRecord } from "./tx";

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
  /**
   * `pending` means the create transaction was signed but not recorded as
   * confirmed. A re-run checks the chain before creating a second collection.
   */
  status?: "pending" | "minted";
  /** Signed bytes kept only until the collection is confirmed. */
  signed?: SignedTransactionRecord | null;
}

/**
 * Batch progress exists so a failed run resumes instead of paying for the same
 * Arweave uploads again. The temporary signing key is never stored, only the
 * public results.
 */
export interface BatchItemRecord {
  name: string;
  imageUri?: string;
  metadataUri?: string;
  address?: string;
  signature?: string;
  /**
   * `pending` means the mint transaction was signed. The recorded address lets
   * a re-run ask the chain whether the item landed before minting it again.
   */
  status?: "pending" | "minted";
  /** Signed bytes kept only until the mint is confirmed, so it can be re-sent. */
  signed?: SignedTransactionRecord | null;
}

export interface BatchRecord {
  collection: string;
  items: BatchItemRecord[];
  updatedAt: string;
}

export interface ProjectState {
  cluster: string;
  wallet?: string;
  collection?: CollectionRecord;
  nfts: NftRecord[];
  batch?: BatchRecord;
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

  let parsed: Partial<ProjectState>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectState>;
  } catch {
    throw new Error(
      `State file ${file} is not valid JSON. Do not delete it: it may be the only record of minted items. Inspect or restore it first.`,
    );
  }
  return {
    cluster,
    wallet: parsed.wallet,
    collection: parsed.collection,
    nfts: Array.isArray(parsed.nfts) ? parsed.nfts : [],
    batch: parsed.batch,
  };
}

/**
 * Writes through a temporary file and renames it into place. A crash mid-write
 * leaves the previous state intact instead of a truncated JSON file.
 */
function writeState(state: ProjectState): void {
  const file = stateFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
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

/** Upload and mint progress for the active batch, keyed by collection. */
export function readBatchItems(collection: string): BatchItemRecord[] {
  const state = readState();
  if (!state.batch || state.batch.collection !== collection) return [];
  return state.batch.items;
}

export function saveBatchItem(
  collection: string,
  item: BatchItemRecord,
): void {
  const state = readState();
  const items =
    state.batch && state.batch.collection === collection
      ? state.batch.items
      : [];
  const index = items.findIndex((entry) => entry.name === item.name);
  const target: BatchItemRecord =
    index >= 0 ? items[index] : { name: item.name };

  const { signed, ...rest } = item;
  Object.assign(target, rest);
  if (signed === null) delete target.signed;
  else if (signed) target.signed = signed;

  if (index >= 0) items[index] = target;
  else items.push(target);

  state.batch = {
    collection,
    items,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
}

/**
 * Drops the mint address of a transaction that never landed. Upload URIs stay,
 * so a retry does not pay for the same Arweave files twice.
 */
export function resetBatchItem(collection: string, name: string): void {
  const state = readState();
  if (!state.batch || state.batch.collection !== collection) return;
  const item = state.batch.items.find((entry) => entry.name === name);
  if (!item) return;
  delete item.address;
  delete item.signature;
  delete item.signed;
  delete item.status;
  state.batch.updatedAt = new Date().toISOString();
  writeState(state);
}

export function clearBatch(): void {
  const state = readState();
  writeState({
    cluster: state.cluster,
    wallet: state.wallet,
    collection: state.collection,
    nfts: state.nfts,
  });
}
