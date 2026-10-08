// (C) Rollout step 9, the point of no return: delete the frozen players/games/
// messages/friendRequests arrays from state/global.
//
// Why: since 8b nothing writes them and since 8c the rules refuse it, so they
// are a stale copy that only costs doc size (every state/global snapshot
// ships them to every client). The collections are the only live copy.
//
// The only way back past this point is the backup (Plan step 9 "verify"), so
// --apply refuses unless it's given a backup file that:
//   - is for this project and passes its own sha256,
//   - was taken in the last BACKUP_MAX_AGE_HOURS,
//   - also holds players/games/messages/friendRequests (the updated
//     `(C) sb-backup.mjs` captures them), and
//   - has arrays identical to what's on state/global right now.
// The delete itself runs in a transaction that re-checks the last point, so
// nothing can change between the check and the delete.
//
// Dry run (read-only, the default; --backup optional):
//   GCLOUD_PROJECT=skirank-b3b70 node scripts/drop-global-arrays-step9.mjs --prod --backup <file>
// Apply (writes prod):
//   DROP_ARRAYS_CONFIRM_PROD=yes-i-am-sure GCLOUD_PROJECT=skirank-b3b70 node scripts/drop-global-arrays-step9.mjs --prod --apply --backup <file>

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

export const KEYS = ['players', 'games', 'messages', 'friendRequests'];
export const BACKUP_MAX_AGE_HOURS = 24;

// Firestore REST typed JSON (what sb-backup.mjs stores) → plain JS.
export function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return { __ts: new Date(v.timestampValue).toISOString() };
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decodeValue(x)]));
  if ('referenceValue' in v) return { __ref: v.referenceValue };
  if ('geoPointValue' in v) return { __geo: v.geoPointValue };
  if ('bytesValue' in v) return { __bytes: v.bytesValue };
  throw new Error('unknown Firestore value: ' + JSON.stringify(v).slice(0, 80));
}

// Order-independent-for-keys, order-preserving-for-arrays canonical JSON.
// Admin SDK Timestamps are normalised the same way decodeValue() does.
export function canon(v) {
  const walk = (x) => {
    if (x && typeof x.toDate === 'function' && typeof x.seconds === 'number') return { __ts: x.toDate().toISOString() };
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]));
    return x;
  };
  return JSON.stringify(walk(v === undefined ? null : v));
}

export function backupSha(backup) {
  const copy = JSON.parse(JSON.stringify(backup));
  delete copy._meta.sha256;
  return createHash('sha256').update(JSON.stringify(copy, null, 2)).digest('hex');
}

// Pure: is this backup good enough to delete against? state = live state/global data.
export function checkBackup(backup, state, { projectId, now = Date.now() }) {
  const problems = [];
  const meta = backup?._meta || {};
  if (meta.project !== projectId) problems.push(`backup is for project "${meta.project}", not "${projectId}"`);
  if (!meta.sha256 || backupSha(backup) !== meta.sha256) problems.push('backup sha256 does not match its contents (edited or truncated)');
  const age = (now - Date.parse(meta.takenAt)) / 3600000;
  if (!(age >= 0 && age <= BACKUP_MAX_AGE_HOURS)) problems.push(`backup taken ${meta.takenAt}, older than ${BACKUP_MAX_AGE_HOURS}h (or unreadable); take a fresh one`);
  for (const c of KEYS) {
    if (!Array.isArray(backup?.collections?.[c])) problems.push(`backup has no ${c}/ collection (use the updated sb-backup.mjs)`);
  }
  const fields = backup?.docs?.['state/global']?.fields;
  if (!fields) problems.push('backup has no state/global doc');
  else {
    for (const k of KEYS) {
      const inBackup = k in fields ? decodeValue(fields[k]) : undefined;
      if (canon(inBackup) !== canon(state?.[k])) {
        const n = (x) => (Array.isArray(x) ? x.length : x === undefined ? 'absent' : typeof x);
        problems.push(`state/global.${k} differs from the backup (backup ${n(inBackup)}, live ${n(state?.[k])})`);
      }
    }
  }
  return problems;
}

// Pure: what in the arrays has no collection doc. Report only. The backup
// keeps all of it; most of it is expected (deleted accounts, declined
// requests, admin-deleted games).
export function coverage(state, colIds) {
  const out = {};
  for (const k of KEYS) {
    const arr = Array.isArray(state?.[k]) ? state[k] : [];
    out[k] = { total: arr.length, missing: arr.filter((x) => x && x.id && !colIds[k].has(x.id)).map((x) => x.id) };
  }
  return out;
}

async function main() {
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const allowProd = process.argv.includes('--prod');
  const apply = process.argv.includes('--apply');
  const bi = process.argv.indexOf('--backup');
  const backupPath = bi > 0 ? process.argv[bi + 1] : null;

  if (!emulatorHost && !allowProd) {
    console.error('Refusing to run: pass --prod with GCLOUD_PROJECT set, or set FIRESTORE_EMULATOR_HOST.');
    process.exit(1);
  }
  if (emulatorHost && allowProd) {
    console.error(`Refusing to run: --prod was passed but FIRESTORE_EMULATOR_HOST is set (${emulatorHost}), which is contradictory intent.`);
    process.exit(1);
  }
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || (allowProd ? null : 'demo-step9');
  if (!projectId) {
    console.error('Set GCLOUD_PROJECT explicitly when running with --prod. Refusing to guess a project id.');
    process.exit(1);
  }
  if (apply && !backupPath) {
    console.error('Refusing to delete: --apply needs --backup <file> (a fresh sb-backup.mjs export). The backup is the only way back.');
    process.exit(1);
  }
  if (allowProd && apply && process.env.DROP_ARRAYS_CONFIRM_PROD !== 'yes-i-am-sure') {
    console.error('Refusing to write production: --apply with --prod also needs DROP_ARRAYS_CONFIRM_PROD=yes-i-am-sure.');
    process.exit(1);
  }
  const backup = backupPath ? JSON.parse(readFileSync(backupPath, 'utf8')) : null;
  if (allowProd) console.warn(`${apply ? 'WRITING TO' : 'Dry run against'} REAL project "${projectId}".\n`);
  initializeApp({ projectId });

  const db = getFirestore();
  const ref = db.doc('state/global');
  const state = (await ref.get()).data() || {};
  const colIds = {};
  for (const k of KEYS) colIds[k] = new Set((await db.collection(k).select().get()).docs.map((d) => d.id));

  const present = KEYS.filter((k) => k in state);
  console.log(`state/global: ${Object.keys(state).length} keys, ~${(Buffer.byteLength(JSON.stringify(state)) / 1024).toFixed(1)} KiB as JSON`);
  const cov = coverage(state, colIds);
  for (const k of KEYS) {
    const c = cov[k];
    console.log(`  ${k.padEnd(15)} ${k in state ? `array ${String(c.total).padStart(4)}` : 'absent    '}   collection ${String(colIds[k].size).padStart(4)}` +
      (c.missing.length ? `   ${c.missing.length} array id(s) with no doc: ${c.missing.join(', ')}` : ''));
  }
  if (!present.length) { console.log('\nNothing to do: none of the arrays are on state/global.'); return; }

  if (backup) {
    const problems = checkBackup(backup, state, { projectId });
    console.log(problems.length ? `\nBackup ${backupPath} NOT usable:\n  - ${problems.join('\n  - ')}` : `\nBackup OK: ${backupPath} (taken ${backup._meta.takenAt}, arrays identical to live).`);
    if (problems.length && apply) process.exit(1);
  }
  if (!apply) {
    console.log(`\nDry run: nothing written. --apply would delete: ${present.join(', ')}.`);
    return;
  }

  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() || {};
    const again = checkBackup(backup, cur, { projectId });
    if (again.length) throw new Error('state/global changed since the check, aborting: ' + again.join('; '));
    const del = {};
    KEYS.filter((k) => k in cur).forEach((k) => { del[k] = FieldValue.delete(); });
    tx.update(ref, del);
  });
  const after = (await ref.get()).data() || {};
  const left = KEYS.filter((k) => k in after);
  const lost = Object.keys(state).filter((k) => !KEYS.includes(k) && !(k in after));
  console.log(`\nDeleted ${present.join(', ')}. state/global now ${Object.keys(after).length} keys, ~${(Buffer.byteLength(JSON.stringify(after)) / 1024).toFixed(1)} KiB.`);
  if (left.length || lost.length) {
    console.error(`VERIFY FAILED: still present [${left.join(', ')}], other keys missing [${lost.join(', ')}].`);
    process.exit(1);
  }
  console.log('Verified: the four arrays are gone and every other key is still there.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
