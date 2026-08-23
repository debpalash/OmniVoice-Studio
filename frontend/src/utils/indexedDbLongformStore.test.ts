import { describe, expect, it, vi } from 'vitest';

import { createIndexedDbLongformStore } from './indexedDbLongformStore';

function createReadableFactory(): IDBFactory {
  const database = {
    close: vi.fn(),
    objectStoreNames: { contains: () => true },
    transaction: vi.fn(() => {
      const transaction: Record<string, unknown> = {
        error: null,
        objectStore: () => ({
          get: () => {
            const request: Record<string, unknown> = { error: null, result: undefined };
            queueMicrotask(() => {
              (request.onsuccess as (() => void) | undefined)?.();
              (transaction.oncomplete as (() => void) | undefined)?.();
            });
            return request;
          },
        }),
      };
      return transaction;
    }),
  };
  return {
    open: vi.fn(() => {
      const request: Record<string, unknown> = { error: null, result: database };
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
      return request;
    }),
  } as unknown as IDBFactory;
}

describe('IndexedDB long-form store', () => {
  it('reopens after the factory throws synchronously', async () => {
    const factory = createReadableFactory();
    const getFactory = vi
      .fn<() => IDBFactory>()
      .mockImplementationOnce(() => {
        throw new DOMException('content intentionally omitted', 'UnknownError');
      })
      .mockReturnValue(factory);
    const store = createIndexedDbLongformStore(getFactory);

    await expect(store.read()).rejects.toMatchObject({ name: 'UnknownError' });
    await expect(store.read()).resolves.toBeNull();
    expect(getFactory).toHaveBeenCalledTimes(2);
  });
});
