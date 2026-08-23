export const LONGFORM_DB_NAME = 'omnivoice.longform';
const LONGFORM_DB_STORE = 'documents';
const LONGFORM_DB_RECORD_ID = 'workspace';
export const LONGFORM_DB_SCHEMA = 1;

export interface DurableLongformRecord {
  schema: typeof LONGFORM_DB_SCHEMA;
  payload: Record<string, unknown>;
}

export interface LongformDurableStore {
  read(): Promise<DurableLongformRecord | null>;
  write(record: DurableLongformRecord): Promise<void>;
  clear(): Promise<void>;
}

function isDurableRecord(value: unknown): value is DurableLongformRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<DurableLongformRecord>;
  return (
    record.schema === LONGFORM_DB_SCHEMA &&
    record.payload !== null &&
    typeof record.payload === 'object' &&
    !Array.isArray(record.payload)
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new DOMException('Request failed', 'UnknownError'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'));
    transaction.onerror = () =>
      reject(transaction.error ?? new DOMException('Transaction failed', 'UnknownError'));
  });
}

/** Native IndexedDB implementation; no runtime package or network dependency. */
export function createIndexedDbLongformStore(
  getFactory: () => IDBFactory = () => globalThis.indexedDB,
): LongformDurableStore {
  let databasePromise: Promise<IDBDatabase> | null = null;

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        const factory = getFactory();
        if (!factory) throw new DOMException('IndexedDB unavailable', 'NotSupportedError');
        request = factory.open(LONGFORM_DB_NAME, LONGFORM_DB_SCHEMA);
      } catch (error) {
        databasePromise = null;
        reject(error);
        return;
      }

      let settled = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LONGFORM_DB_STORE)) {
          request.result.createObjectStore(LONGFORM_DB_STORE);
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        databasePromise = null;
        reject(request.error ?? new DOMException('Database open failed', 'UnknownError'));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        databasePromise = null;
        reject(new DOMException('Database open blocked', 'InvalidStateError'));
      };
    });
    return databasePromise;
  }

  return {
    async read() {
      const database = await openDatabase();
      const transaction = database.transaction(LONGFORM_DB_STORE, 'readonly');
      const request = transaction.objectStore(LONGFORM_DB_STORE).get(LONGFORM_DB_RECORD_ID);
      const [value] = await Promise.all([requestResult(request), transactionDone(transaction)]);
      return isDurableRecord(value) ? value : null;
    },
    async write(record) {
      const database = await openDatabase();
      const transaction = database.transaction(LONGFORM_DB_STORE, 'readwrite');
      transaction.objectStore(LONGFORM_DB_STORE).put(record, LONGFORM_DB_RECORD_ID);
      await transactionDone(transaction);
    },
    async clear() {
      const database = await openDatabase();
      const transaction = database.transaction(LONGFORM_DB_STORE, 'readwrite');
      transaction.objectStore(LONGFORM_DB_STORE).delete(LONGFORM_DB_RECORD_ID);
      await transactionDone(transaction);
    },
  };
}
