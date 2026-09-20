'use strict';

// Shared helpers for the emulator-backed integration tests. These call the
// handler functions directly (bypassing the onCall() HTTPS wrapper, which
// is a two-line passthrough with no logic of its own) against a REAL
// Firestore emulator instance, so transaction semantics, missing-doc reads,
// and query behavior are all genuine — only the callable-function transport
// layer itself is skipped.

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const PROJECT_ID = 'demo-step5';

function getDb() {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
}

async function clearEmulatorData() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — these tests must run under firebase emulators:exec.');
  }
  const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator data: ${res.status} ${await res.text()}`);
  }
}

function fakeRequest(uid, data) {
  return { auth: uid ? { uid } : null, data };
}

module.exports = { PROJECT_ID, getDb, clearEmulatorData, fakeRequest };
