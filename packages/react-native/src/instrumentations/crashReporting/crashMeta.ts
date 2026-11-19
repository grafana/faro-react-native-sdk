import type {
  Meta,
  MetaApp,
  MetaAttributes,
  MetaDevice,
  MetaOS,
  MetaPage,
  MetaSDK,
  MetaView,
} from '@grafana/faro-core';

import { omitDynamicDeviceFields, parseDynamicDeviceState } from '../../metas/dynamicDeviceState';
import type { DynamicDeviceState } from '../../metas/dynamicDeviceState';
import { DYNAMIC_SESSION_ATTRIBUTE_KEYS } from '../session/sessionAttributes';

/**
 * The metadata of the crashed process that native storage keeps with a crash.
 *
 * `meta.user` is not saved: it can hold an ID, name or email, and the SDK does not write those to
 * disk. Dynamic device and network values are not saved here either. Native code captures them at
 * crash time.
 */
export interface SavedCrashMeta {
  sdk?: MetaSDK;
  app?: MetaApp;
  os?: MetaOS;
  device?: MetaDevice;
  page?: MetaPage;
  view?: MetaView;
  sessionAttributes?: MetaAttributes;
}

const OBJECT_KEYS = ['sdk', 'app', 'os', 'device', 'page'] as const;

// The sampling decision has its own field on the crash record.
const EXCLUDED_SESSION_ATTRIBUTE_KEYS: readonly string[] = [...DYNAMIC_SESSION_ATTRIBUTE_KEYS, 'isSampled'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutEmpty<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function stringAttributes(value: unknown): MetaAttributes | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const attributes = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !EXCLUDED_SESSION_ATTRIBUTE_KEYS.includes(entry[0])
    )
  );
  return withoutEmpty(attributes);
}

/**
 * Serializes the parts of `meta` that describe the running process and do not change on their own.
 * Returns `undefined` when there is nothing to save.
 */
export function serializeCrashMeta(meta: Meta): string | undefined {
  const snapshot: Record<string, unknown> = {};
  for (const key of OBJECT_KEYS) {
    const value = meta[key];
    if (isPlainObject(value)) {
      snapshot[key] = key === 'device' ? omitDynamicDeviceFields(value as MetaDevice) : value;
    }
  }
  if (meta.view) {
    snapshot['view'] = meta.view;
  }
  const sessionAttributes = stringAttributes(meta.session?.attributes);
  if (sessionAttributes) {
    snapshot['sessionAttributes'] = sessionAttributes;
  }

  const populated = Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => !isPlainObject(value) || Object.keys(value).length > 0)
  );
  return Object.keys(populated).length > 0 ? JSON.stringify(populated) : undefined;
}

/**
 * Reads the metadata that native storage returns with a crash. A malformed part is dropped on its
 * own, so one bad value never costs the others.
 */
export function restoreCrashMeta(raw: unknown): SavedCrashMeta | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }

  const restored: SavedCrashMeta = {};
  for (const key of OBJECT_KEYS) {
    const value = raw[key];
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      (restored as Record<string, unknown>)[key] = key === 'device' ? omitDynamicDeviceFields(value) : value;
    }
  }
  const view = raw['view'];
  if (isPlainObject(view) && typeof view['name'] === 'string') {
    restored.view = { name: view['name'] };
  }
  const sessionAttributes = stringAttributes(raw['sessionAttributes']);
  if (sessionAttributes) {
    restored.sessionAttributes = sessionAttributes;
  }

  return withoutEmpty(restored);
}

/**
 * Reads the dynamic device and network values that native code captured at crash time. Returns
 * `undefined` when native code did not save any.
 */
export function restoreCrashDynamicState(raw: unknown): DynamicDeviceState | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const state = parseDynamicDeviceState(raw);
  return Object.keys(state.device).length > 0 || Object.keys(state.network).length > 0 ? state : undefined;
}
