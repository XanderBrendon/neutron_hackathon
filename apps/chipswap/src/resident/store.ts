// The catalog cache, on the machine that fetched it.
//
// This runs in the background's persistent origin, the only surface in the app
// that keeps anything across a browser restart: a tile's credentialless
// partition is ephemeral and dies with the page. Everything here is
// per-installation and never leaves the machine.

import type { PeerDesign } from "../wire.ts";

export type CachedCatalog = {
  designer: string;
  designs: PeerDesign[];
  /** Wall-clock ms of the last successful read. 0 means never. */
  fetchedAtMs: number;
  /** Why the last attempt failed, or null if it did not. */
  lastError: string | null;
};

const DB_NAME = "chipswap";
const DB_VERSION = 1;
const STORE = "catalogs";

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("IndexedDB failed"));
  });
}

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opened !== null) return opened;
  opened = new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, DB_VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "designer" });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () =>
      reject(opening.error ?? new Error("Could not open the catalog cache"));
  });
  return opened;
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await open();
  return run(db.transaction(STORE, mode).objectStore(STORE));
}

export async function readAll(): Promise<CachedCatalog[]> {
  return transact("readonly", (store) =>
    request(store.getAll() as IDBRequest<CachedCatalog[]>),
  );
}

export async function write(entry: CachedCatalog): Promise<void> {
  await transact("readwrite", async (store) => {
    await request(store.put(entry));
  });
}

/** Returns how many entries actually existed to remove. */
export async function evict(designers: string[]): Promise<number> {
  return transact("readwrite", async (store) => {
    let removed = 0;
    for (const designer of designers) {
      const existing = await request(
        store.get(designer) as IDBRequest<CachedCatalog | undefined>,
      );
      if (existing !== undefined) {
        await request(store.delete(designer));
        removed += 1;
      }
    }
    return removed;
  });
}
