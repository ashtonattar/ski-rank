// (C) Test fixtures for drop-global-arrays-step9: build a backup file in the
// exact shape `(C) sb-backup.mjs` writes (Firestore REST typed JSON + sha256).
import { backupSha } from './drop-global-arrays-step9.mjs';

export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(encodeValue) } : {} };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)])) } };
}

export function makeBackup(state, { project = 'demo-step9', takenAt = new Date().toISOString(), cols = {} } = {}) {
  const b = {
    _meta: { project, takenAt, rolloutStep: 9 },
    docs: { 'state/global': { fields: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, encodeValue(v)])) } },
    collections: { players: [], games: [], messages: [], friendRequests: [], ...cols }
  };
  b._meta.sha256 = backupSha(b);
  return b;
}
