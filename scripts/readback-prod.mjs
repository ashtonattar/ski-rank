// (C) Independent, read-only re-verification of the rollout step-4 prod
// migration — deliberately NOT reusing migrate-to-collections.mjs's or
// verify-migration.mjs's connection path. Those both go through
// firebase-admin (ADC auth, gRPC/protobuf wire). This script talks straight
// to the Firestore REST API over plain HTTPS, authenticated via the
// firebase-tools stored OAuth credential (same pattern as
// "(C) Pre-Migration Backups/(C) sb-backup.mjs") — a different token, a
// different OAuth client, a different transport, and its own hand-rolled
// decoder from Firestore's REST wire format instead of the Admin SDK's
// .data(). The point: a bug that fooled the admin-SDK path should not also
// fool this one.
//
// STRICTLY READ-ONLY — this file must never contain a PATCH, POST, PUT, or
// DELETE against Firestore. Every request below is a GET.
//
// Usage: node scripts/readback-prod.mjs

import { readFileSync } from 'fs';

const PROJECT = 'skirank-b3b70';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// Captured live against prod immediately before the rollout step-4 migration
// ran (ADC read + linkage recheck, same session): state/global's four array
// counts and its updateTime. state/global is read-only for this whole
// rollout step, so both must be byte-identical to this baseline now.
// updateTime is the full microsecond-precision REST value (re-confirmed via
// a raw REST read) — the admin-SDK path's toDate().toISOString() rounds to
// milliseconds (".157653Z" -> ".158Z"), which is the same instant but an
// incorrect byte-for-byte baseline for this REST-native comparison.
const PRE_MIGRATION_BASELINE = {
  counts: { players: 16, games: 117, messages: 11, friendRequests: 5 },
  updateTime: '2026-09-15T17:01:10.157653Z',
};
const EXPECTED_LINKED_COUNT = 7;
const SAMPLE_SIZE = 12; // >= 10 required

let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

async function getAccessToken() {
  const cfgPath = process.env.HOME + '/.config/configstore/firebase-tools.json';
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const body = new URLSearchParams({
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: cfg.tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const json = await res.json();
  if (!json.access_token) throw new Error('firebase-tools auth failed — run `firebase login`: ' + JSON.stringify(json));
  return json.access_token;
}

async function getDoc(token, path) {
  const r = await fetch(`${BASE}/${path}`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error.message}`);
  return j;
}

async function listCollection(token, collection) {
  const docs = [];
  let pageToken;
  do {
    const u = new URL(`${BASE}/${collection}`);
    u.searchParams.set('pageSize', '300');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.error) throw new Error(`${collection}: ${j.error.message}`);
    (j.documents || []).forEach((d) => docs.push(d));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return docs;
}

// Hand-rolled Firestore REST wire-format decoder — independent of the Admin
// SDK's own decoding (protobuf -> JS), so a serialization bug on one side
// wouldn't silently agree with the same bug on the other.
function decodeValue(v) {
  if (v.nullValue !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.referenceValue !== undefined) return v.referenceValue;
  if (v.geoPointValue !== undefined) return v.geoPointValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(decodeValue);
  if (v.mapValue !== undefined) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}
function docId(doc) {
  return doc.name.split('/').pop();
}
// Order-independent structural equality — JSON.stringify(a) === JSON.stringify(b)
// is a trap here because two independently-fetched Firestore REST documents
// with identical fields are not guaranteed to serialize their object keys in
// the same order.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const token = await getAccessToken();

  // ---- state/global unchanged ----
  const globalDoc = await getDoc(token, 'state/global');
  const globalFields = decodeFields(globalDoc.fields);
  const globalCounts = {
    players: (globalFields.players || []).length,
    games: (globalFields.games || []).length,
    messages: (globalFields.messages || []).length,
    friendRequests: (globalFields.friendRequests || []).length,
  };
  const globalUpdateTime = globalDoc.updateTime;

  console.log('=== state/global unchanged (read-only this rollout step) ===');
  for (const k of Object.keys(PRE_MIGRATION_BASELINE.counts)) {
    ok(globalCounts[k] === PRE_MIGRATION_BASELINE.counts[k],
      `state/global.${k} count: ${globalCounts[k]} (expected ${PRE_MIGRATION_BASELINE.counts[k]})`);
  }
  ok(globalUpdateTime === PRE_MIGRATION_BASELINE.updateTime,
    `state/global.updateTime: ${globalUpdateTime} (expected ${PRE_MIGRATION_BASELINE.updateTime})`);

  // ---- collection doc counts ----
  console.log('\n=== migrated collection doc counts ===');
  const collections = ['players', 'games', 'messages', 'friendRequests'];
  const destDocs = {};
  for (const collection of collections) {
    const docs = await listCollection(token, collection);
    destDocs[collection] = docs;
    ok(docs.length === PRE_MIGRATION_BASELINE.counts[collection],
      `${collection}: ${docs.length} docs (expected ${PRE_MIGRATION_BASELINE.counts[collection]})`);
  }

  // ---- firebaseUid linkage count ----
  console.log('\n=== players.firebaseUid linkage ===');
  const decodedPlayers = destDocs.players.map((d) => ({ id: docId(d), data: decodeFields(d.fields) }));
  const linked = decodedPlayers.filter((p) => p.data.firebaseUid).length;
  ok(linked === EXPECTED_LINKED_COUNT, `players carrying firebaseUid: ${linked} (expected ${EXPECTED_LINKED_COUNT})`);

  // ---- deep sample comparison against state/global source arrays ----
  console.log(`\n=== deep sample comparison (>= ${SAMPLE_SIZE} docs) vs state/global ===`);
  const sourceById = {};
  for (const collection of collections) {
    sourceById[collection] = new Map((globalFields[collection] || []).map((el) => [el.id, el]));
  }
  const pool = [];
  for (const collection of collections) {
    for (const d of destDocs[collection]) pool.push({ collection, id: docId(d), data: decodeFields(d.fields) });
  }
  const sample = shuffle(pool).slice(0, Math.min(SAMPLE_SIZE, pool.length));
  for (const item of sample) {
    const src = sourceById[item.collection].get(item.id);
    if (!src) { ok(false, `${item.collection}/${item.id}: no matching source element in state/global`); continue; }
    let dest = item.data;
    if (item.collection === 'players') {
      const { firebaseUid, ...withoutUid } = dest;
      dest = withoutUid;
    }
    ok(deepEqual(dest, src), `${item.collection}/${item.id}: matches state/global source element`);
  }

  console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED — independent REST readback matches admin-SDK verification');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
