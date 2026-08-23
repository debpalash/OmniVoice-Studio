import type { PersistStorage, StorageValue } from 'zustand/middleware';

import {
  createZustandJsonStorage,
  flushPendingWrites as flushLocalPendingWrites,
  getPersistenceRole,
  type PersistenceRole,
} from './coalescedJsonStorage';
import {
  createIndexedDbLongformStore,
  LONGFORM_DB_NAME,
  LONGFORM_DB_SCHEMA,
  type DurableLongformRecord,
  type LongformDurableStore,
} from './indexedDbLongformStore';

export type { DurableLongformRecord, LongformDurableStore } from './indexedDbLongformStore';

const QUIET_DELAY_MS = 250;
const MAXIMUM_DELAY_MS = 1_000;
const DEFAULT_READ_ATTEMPTS = 3;
const FALLBACK_REVISION_FIELD = 'longformFallbackRevision';
const HYDRATION_ERROR_FIELD = 'longformPersistenceError';
export const LONGFORM_LOCAL_FALLBACK_CLEAR_ERROR = 'LongformLocalFallbackClearError';

/** Fields whose size grows with a manuscript, cast, or saved-project count. */
const UNBOUNDED_LONGFORM_KEYS = [
  'storyTracks',
  'cast',
  'storyProjects',
  'script',
  'meta',
  'lexicon',
  'voiceCast',
] as const;

type JsonObject = Record<string, unknown>;
type TimerHandle = ReturnType<typeof setTimeout>;

interface ListenerTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface VisibilityTarget extends ListenerTarget {
  readonly visibilityState: DocumentVisibilityState;
}

export interface LongformPersistenceOptions<S> {
  localStorage: PersistStorage<S>;
  durableStore: LongformDurableStore | (() => LongformDurableStore);
  currentVersion: number;
  getRole?: () => PersistenceRole;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  now?: () => number;
  quietDelayMs?: number;
  maximumDelayMs?: number;
  readAttempts?: number;
  warn?: (message: string) => void;
  flushLocalStorage?: () => unknown;
  getPagehideTarget?: () => ListenerTarget | null;
  getVisibilityTarget?: () => VisibilityTarget | null;
}

export interface LongformPersistenceController<S> {
  storage: PersistStorage<S>;
  flushPendingWrites(): Promise<void>;
  discardPendingWrites(): boolean;
  clearDurable(): Promise<void>;
  installLifecycleFlush(): () => void;
  reset(): void;
}

function safeErrorClass(error: unknown): string {
  let candidate = '';
  try {
    if (error !== null && typeof error === 'object') {
      const name = (error as { name?: unknown }).name;
      if (typeof name === 'string') candidate = name;
    }
  } catch {
    return 'UnknownError';
  }
  return /^[A-Za-z][A-Za-z0-9]*Error$/.test(candidate) ? candidate : 'UnknownError';
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' ? (value as JsonObject) : {};
}

function pickPayloadReferences(state: JsonObject): JsonObject {
  return Object.fromEntries(
    UNBOUNDED_LONGFORM_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(state, key)).map(
      (key) => [key, state[key]],
    ),
  );
}

function samePayloadReferences(left: JsonObject | null, right: JsonObject): boolean {
  return left !== null && UNBOUNDED_LONGFORM_KEYS.every((key) => Object.is(left[key], right[key]));
}

function sanitizeTrack(track: unknown): unknown {
  if (track === null || typeof track !== 'object') return track;
  const value = track as JsonObject;
  return {
    id: value.id,
    character: value.character,
    text: value.text,
    profileId: value.profileId,
    emotion: value.emotion,
    speed: value.speed,
  };
}

function extractLongformPayload(stateValue: unknown): JsonObject {
  const state = asObject(stateValue);
  const payload = pickPayloadReferences(state);
  if (Array.isArray(payload.storyTracks)) {
    payload.storyTracks = payload.storyTracks.map(sanitizeTrack);
  }
  return payload;
}

function compactLongformState(stateValue: unknown): JsonObject {
  const compact = { ...asObject(stateValue) };
  for (const key of UNBOUNDED_LONGFORM_KEYS) delete compact[key];
  return compact;
}

function resetLongformState(stateValue: unknown): JsonObject {
  return {
    ...compactLongformState(stateValue),
    currentProjectId: null,
    coverRef: null,
    lastOutput: '',
  };
}

function containsLongformPayload(stateValue: unknown): boolean {
  const state = asObject(stateValue);
  return UNBOUNDED_LONGFORM_KEYS.some((key) => Object.prototype.hasOwnProperty.call(state, key));
}

/** Retain only the project payload from an IDB-failure fallback during a preference reset. */
export function preserveRevisionedLongformFallback(rawValue: string | null): string | null {
  if (rawValue === null) return null;
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const envelope = parsed as JsonObject;
    const revision = envelope[FALLBACK_REVISION_FIELD];
    if (!validRevision(revision) || revision === 0 || !containsLongformPayload(envelope.state)) {
      return null;
    }
    const preserved: JsonObject = {
      [FALLBACK_REVISION_FIELD]: revision,
      state: extractLongformPayload(envelope.state),
    };
    if (Object.prototype.hasOwnProperty.call(envelope, 'version')) {
      preserved.version = envelope.version;
    }
    return JSON.stringify(preserved);
  } catch {
    return null;
  }
}

function mergePayload(stateValue: unknown, payload: JsonObject): JsonObject {
  return { ...compactLongformState(stateValue), ...payload };
}

type VersionedStorageValue<S> = StorageValue<S> & {
  [FALLBACK_REVISION_FIELD]?: number;
};

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function fallbackRevision<S>(value: StorageValue<S> | null): number {
  if (!value) return 0;
  const revision = (value as VersionedStorageValue<S>)[FALLBACK_REVISION_FIELD];
  return validRevision(revision) ? revision : 0;
}

function durableRevision(value: DurableLongformRecord | null): number {
  return validRevision(value?.revision) ? value.revision : 0;
}

function compactEnvelope<S>(value: StorageValue<S>): StorageValue<S> {
  const compact = { ...value } as VersionedStorageValue<S>;
  delete compact[FALLBACK_REVISION_FIELD];
  compact.state = compactLongformState(value.state) as S;
  return compact;
}

function resetEnvelope<S>(value: StorageValue<S>): StorageValue<S> {
  const reset = compactEnvelope(value);
  reset.state = resetLongformState(value.state) as S;
  return reset;
}

function fullEnvelope<S>(value: StorageValue<S>, revision: number): VersionedStorageValue<S> {
  return {
    ...value,
    [FALLBACK_REVISION_FIELD]: revision,
    state: {
      ...compactLongformState(value.state),
      ...extractLongformPayload(value.state),
    } as S,
  };
}

interface PendingWrite<S> {
  name: string;
  value: StorageValue<S>;
  payloadReferences: JsonObject;
  generation: number;
  windowGeneration: number;
  quietTimer: TimerHandle | null;
  maximumTimer: TimerHandle | null;
}

/**
 * Split Zustand persistence across bounded localStorage and durable IndexedDB.
 * IndexedDB is always committed before a legacy full envelope is compacted.
 */
export function createLongformPersistence<S>(
  options: LongformPersistenceOptions<S>,
): LongformPersistenceController<S> {
  const resolveDurableStore =
    typeof options.durableStore === 'function'
      ? (options.durableStore as () => LongformDurableStore)
      : () => options.durableStore as LongformDurableStore;
  const getRole = options.getRole ?? (() => 'main');
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((handle: TimerHandle) => globalThis.clearTimeout(handle));
  const now = options.now ?? (() => Date.now());
  const quietDelayMs = options.quietDelayMs ?? QUIET_DELAY_MS;
  const maximumDelayMs = options.maximumDelayMs ?? MAXIMUM_DELAY_MS;
  const readAttempts = options.readAttempts ?? DEFAULT_READ_ATTEMPTS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const getPagehideTarget =
    options.getPagehideTarget ??
    (() => (typeof window === 'undefined' ? null : (window as ListenerTarget)));
  const getVisibilityTarget =
    options.getVisibilityTarget ??
    (() => (typeof document === 'undefined' ? null : (document as VisibilityTarget)));

  if (quietDelayMs < 0 || maximumDelayMs < quietDelayMs) {
    throw new RangeError('Persistence delays must satisfy 0 <= quiet <= maximum');
  }
  if (!Number.isSafeInteger(readAttempts) || readAttempts < 1) {
    throw new RangeError('Persistence read attempts must be a positive integer');
  }

  let pending: PendingWrite<S> | null = null;
  let nextGeneration = 0;
  let nextWindowGeneration = 0;
  let durablePayloadKnown = false;
  let durableReadUncertain = false;
  let payloadDirty = false;
  let latestPayloadReferences: JsonObject | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let lifecycleCleanup: (() => void) | null = null;
  let writesSuspended = false;
  let epoch = 0;
  let storageName: string | null = null;
  let nextRevision = 0;
  const warnedFailures = new Set<string>();

  function warnFailure(operation: string, error: unknown): void {
    const errorClass = safeErrorClass(error);
    const warningId = `${operation}\u0000${errorClass}`;
    if (warnedFailures.has(warningId)) return;
    warnedFailures.add(warningId);
    warn(`[persistence] ${operation} failed for ${LONGFORM_DB_NAME} (${errorClass})`);
  }

  function clearPendingTimers(entry: PendingWrite<S>): void {
    if (entry.quietTimer !== null) clearTimer(entry.quietTimer);
    if (entry.maximumTimer !== null) clearTimer(entry.maximumTimer);
    entry.quietTimer = null;
    entry.maximumTimer = null;
  }

  function discardPendingWrites(): boolean {
    if (!pending) return false;
    clearPendingTimers(pending);
    pending = null;
    return true;
  }

  async function commit(entry: PendingWrite<S>, commitEpoch: number): Promise<void> {
    if (commitEpoch !== epoch || getRole() !== 'main') return;
    const revision = ++nextRevision;
    const record: DurableLongformRecord = {
      schema: LONGFORM_DB_SCHEMA,
      revision,
      payload: extractLongformPayload(entry.value.state),
    };

    try {
      await resolveDurableStore().write(record);
    } catch (error) {
      warnFailure('write', error);
      payloadDirty = true;
      // IndexedDB may be disabled by policy. Preserve the old full-envelope
      // fallback instead of silently dropping persistence altogether.
      try {
        options.localStorage.setItem(entry.name, fullEnvelope(entry.value, revision));
        // The normal localStorage lifecycle listener may already have run before
        // this async IndexedDB rejection. Force its newly queued fallback out now.
        options.flushLocalStorage?.();
      } catch (localError) {
        warnFailure('fallback-write', localError);
      }
      return;
    }

    if (commitEpoch !== epoch || getRole() !== 'main') return;
    durablePayloadKnown = true;
    if (
      samePayloadReferences(latestPayloadReferences, entry.payloadReferences) &&
      entry.generation === nextGeneration &&
      pending === null
    ) {
      payloadDirty = false;
    }
    try {
      options.localStorage.setItem(entry.name, compactEnvelope(entry.value));
      // A lifecycle flush of the coalesced adapter may already have run before
      // this asynchronous IndexedDB commit completed.
      options.flushLocalStorage?.();
    } catch (error) {
      // The durable payload is already committed. A stale/full local envelope
      // remains a safe fallback and will be compacted on a later hydration.
      warnFailure('compact', error);
    }
  }

  function flushPendingWrites(): Promise<void> {
    if (getRole() !== 'main' || pending === null) return writeChain;
    const entry = pending;
    clearPendingTimers(entry);
    pending = null;
    const commitEpoch = epoch;
    const task = writeChain.then(() => commit(entry, commitEpoch));
    writeChain = task.catch(() => {});
    return task;
  }

  function schedule(value: StorageValue<S>, name: string, payloadReferences: JsonObject): void {
    const generation = ++nextGeneration;
    const previous = pending;
    if (previous && previous.quietTimer !== null) clearTimer(previous.quietTimer);

    if (previous) {
      pending = {
        name,
        value,
        payloadReferences,
        generation,
        windowGeneration: previous.windowGeneration,
        quietTimer: setTimer(() => {
          if (pending?.generation === generation) void flushPendingWrites();
        }, quietDelayMs),
        maximumTimer: previous.maximumTimer,
      };
      return;
    }

    const windowGeneration = ++nextWindowGeneration;
    const firstQueuedAt = now();
    const entry: PendingWrite<S> = {
      name,
      value,
      payloadReferences,
      generation,
      windowGeneration,
      quietTimer: null,
      maximumTimer: null,
    };
    entry.quietTimer = setTimer(() => {
      if (pending?.generation === generation) void flushPendingWrites();
    }, quietDelayMs);
    entry.maximumTimer = setTimer(
      () => {
        if (pending?.windowGeneration === windowGeneration) void flushPendingWrites();
      },
      Math.max(0, firstQueuedAt + maximumDelayMs - now()),
    );
    pending = entry;
  }

  async function readLocal(name: string): Promise<StorageValue<S> | null> {
    try {
      return await options.localStorage.getItem(name);
    } catch (error) {
      warnFailure('local-read', error);
      return null;
    }
  }

  async function hydrate(name: string): Promise<StorageValue<S> | null> {
    storageName = name;
    if (pending?.name === name) return pending.value;

    const localValue = await readLocal(name);
    let durableRecord: DurableLongformRecord | null = null;
    let readError: unknown;
    for (let attempt = 0; attempt < readAttempts; attempt += 1) {
      try {
        durableRecord = await resolveDurableStore().read();
        readError = undefined;
        break;
      } catch (error) {
        readError = error;
        if (attempt + 1 < readAttempts) await Promise.resolve();
      }
    }

    if (readError !== undefined) {
      warnFailure('read', readError);
      durablePayloadKnown = false;
      durableReadUncertain = true;
      payloadDirty = false;
      latestPayloadReferences = localValue
        ? pickPayloadReferences(asObject(localValue.state))
        : null;
      if (getRole() === 'readonly') return localValue;
      const unavailable = localValue ?? {
        state: {} as S,
        version: options.currentVersion,
      };
      return {
        ...unavailable,
        state: {
          ...asObject(unavailable.state),
          [HYDRATION_ERROR_FIELD]: true,
        } as S,
      };
    }

    durableReadUncertain = false;
    const localRevision = fallbackRevision(localValue);
    const storedRevision = durableRevision(durableRecord);
    nextRevision = Math.max(nextRevision, localRevision, storedRevision);

    if (
      durableRecord &&
      localValue &&
      containsLongformPayload(localValue.state) &&
      localRevision > storedRevision
    ) {
      const payload = extractLongformPayload(localValue.state);
      latestPayloadReferences = pickPayloadReferences(asObject(localValue.state));
      durablePayloadKnown = false;
      payloadDirty = true;
      if (getRole() === 'main') {
        try {
          await resolveDurableStore().write({
            schema: LONGFORM_DB_SCHEMA,
            revision: localRevision,
            payload,
          });
          durablePayloadKnown = true;
          payloadDirty = false;
          try {
            options.localStorage.setItem(name, compactEnvelope(localValue));
          } catch (error) {
            warnFailure('compact', error);
          }
        } catch (error) {
          warnFailure('migrate', error);
        }
      }
      return {
        ...localValue,
        state: {
          ...asObject(localValue.state),
          [HYDRATION_ERROR_FIELD]: false,
        } as S,
      };
    }

    if (durableRecord) {
      durablePayloadKnown = true;
      payloadDirty = false;
      latestPayloadReferences = pickPayloadReferences(durableRecord.payload);

      const merged: StorageValue<S> = localValue
        ? {
            ...localValue,
            state: mergePayload(localValue.state, durableRecord.payload) as S,
          }
        : {
            state: durableRecord.payload as S,
            version: options.currentVersion,
          };

      // A prior quota failure may have left the v8/full fallback in place.
      // The IndexedDB commit above is already durable, so trimming is safe now.
      if (getRole() === 'main' && localValue && containsLongformPayload(localValue.state)) {
        try {
          options.localStorage.setItem(name, compactEnvelope(merged));
        } catch (error) {
          warnFailure('compact', error);
        }
      }
      return {
        ...merged,
        state: {
          ...asObject(merged.state),
          [HYDRATION_ERROR_FIELD]: false,
        } as S,
      };
    }

    if (!localValue) {
      return {
        state: { [HYDRATION_ERROR_FIELD]: false } as S,
        version: options.currentVersion,
      };
    }
    const state = asObject(localValue.state);
    const payloadReferences = pickPayloadReferences(state);
    latestPayloadReferences = payloadReferences;

    if (containsLongformPayload(state) && getRole() === 'main') {
      const record: DurableLongformRecord = {
        schema: LONGFORM_DB_SCHEMA,
        revision: localRevision || ++nextRevision,
        payload: extractLongformPayload(state),
      };
      try {
        // The migration's load-bearing ordering: commit IndexedDB first. The
        // persist middleware may compact/version-bump only after this resolves.
        await resolveDurableStore().write(record);
        durablePayloadKnown = true;
        payloadDirty = false;
        if (localValue.version === options.currentVersion) {
          try {
            options.localStorage.setItem(name, compactEnvelope(localValue));
          } catch (error) {
            warnFailure('compact', error);
          }
        }
      } catch (error) {
        durablePayloadKnown = false;
        payloadDirty = true;
        warnFailure('migrate', error);
      }
    }
    return {
      ...localValue,
      state: {
        ...asObject(localValue.state),
        [HYDRATION_ERROR_FIELD]: false,
      } as S,
    };
  }

  const storage: PersistStorage<S> = {
    getItem: hydrate,
    setItem(name, value) {
      storageName = name;
      if (getRole() !== 'main' || writesSuspended) return;
      // A failed read leaves the in-memory long-form fields at slice defaults.
      // The main window is gated until a successful rehydrate reconciles them;
      // never let those placeholders become authoritative in the meantime.
      if (durableReadUncertain) return;
      const state = asObject(value.state);
      const references = pickPayloadReferences(state);
      const payloadChanged = !samePayloadReferences(latestPayloadReferences, references);
      latestPayloadReferences = references;
      if (!durablePayloadKnown || payloadChanged) payloadDirty = true;

      if (durablePayloadKnown && !payloadDirty) {
        try {
          options.localStorage.setItem(name, compactEnvelope(value));
        } catch (error) {
          warnFailure('compact', error);
        }
      }
      if (payloadDirty || pending !== null) schedule(value, name, references);
    },
    removeItem(name) {
      storageName = name;
      if (getRole() !== 'main') return;
      options.localStorage.removeItem(name);
      return clearDurable();
    },
  };

  async function clearDurable(): Promise<void> {
    writesSuspended = true;
    discardPendingWrites();
    // An IndexedDB transaction already in flight cannot be cancelled. Advance
    // the epoch so it cannot compact localStorage, then wait for it before the
    // delete transaction; otherwise a slow write could resurrect reset data.
    epoch += 1;
    await writeChain;
    durablePayloadKnown = false;
    durableReadUncertain = false;
    payloadDirty = false;
    latestPayloadReferences = null;
    try {
      await resolveDurableStore().clear();
      if (storageName) {
        const localValue = await options.localStorage.getItem(storageName);
        if (localValue) {
          await options.localStorage.setItem(storageName, resetEnvelope(localValue));
        }
      }
    } catch (error) {
      writesSuspended = false;
      warnFailure('clear', error);
      throw error;
    }
  }

  function installLifecycleFlush(): () => void {
    if (getRole() !== 'main') return () => {};
    if (lifecycleCleanup) return lifecycleCleanup;

    const pagehideTarget = getPagehideTarget();
    const visibilityTarget = getVisibilityTarget();
    const onPagehide: EventListener = () => {
      void flushPendingWrites();
    };
    const onVisibilityChange: EventListener = () => {
      if (visibilityTarget?.visibilityState === 'hidden') void flushPendingWrites();
    };
    pagehideTarget?.addEventListener('pagehide', onPagehide);
    visibilityTarget?.addEventListener('visibilitychange', onVisibilityChange);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pagehideTarget?.removeEventListener('pagehide', onPagehide);
      visibilityTarget?.removeEventListener('visibilitychange', onVisibilityChange);
      if (lifecycleCleanup === cleanup) lifecycleCleanup = null;
    };
    lifecycleCleanup = cleanup;
    return cleanup;
  }

  function reset(): void {
    epoch += 1;
    discardPendingWrites();
    lifecycleCleanup?.();
    lifecycleCleanup = null;
    durablePayloadKnown = false;
    durableReadUncertain = false;
    payloadDirty = false;
    writesSuspended = false;
    latestPayloadReferences = null;
    storageName = null;
    nextRevision = 0;
    nextGeneration = 0;
    nextWindowGeneration = 0;
    warnedFailures.clear();
    writeChain = Promise.resolve();
  }

  return {
    storage,
    flushPendingWrites,
    discardPendingWrites,
    clearDurable,
    installLifecycleFlush,
    reset,
  };
}

const nativeDurableStore = createIndexedDbLongformStore();
let applicationDurableStore: LongformDurableStore = nativeDurableStore;
const applicationPersistence = createLongformPersistence<JsonObject>({
  localStorage: createZustandJsonStorage<JsonObject>(),
  durableStore: () => applicationDurableStore,
  currentVersion: 9,
  getRole: getPersistenceRole,
  flushLocalStorage: flushLocalPendingWrites,
});

export function createLongformZustandStorage<S>(): PersistStorage<S> {
  return applicationPersistence.storage as PersistStorage<S>;
}

export const flushLongformPendingWrites = applicationPersistence.flushPendingWrites;
export const discardLongformPendingWrites = applicationPersistence.discardPendingWrites;
export const installLongformPersistenceLifecycleFlush =
  applicationPersistence.installLifecycleFlush;

/** Clear browser-owned projects for Settings' explicit destructive content reset. */
export async function clearLongformProjects(): Promise<void> {
  await applicationPersistence.clearDurable();
  // clearDurable may have queued removal of a legacy full envelope through the
  // coalesced adapter. Make that trim durable before Settings reports success.
  const summary = flushLocalPendingWrites();
  if (summary.failed > 0) {
    throw new DOMException('', LONGFORM_LOCAL_FALLBACK_CLEAR_ERROR);
  }
}

/** Inject a deterministic durable store without replacing the Zustand adapter. */
export function configureLongformDurableStoreForTests(store: LongformDurableStore): void {
  applicationPersistence.reset();
  applicationDurableStore = store;
}

/** Test/HMR teardown. Never clears IndexedDB. */
export function resetLongformPersistenceForTests(): void {
  applicationPersistence.reset();
  applicationDurableStore = nativeDurableStore;
}
