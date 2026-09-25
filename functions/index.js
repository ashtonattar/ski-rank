'use strict';

const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Cost guardrail (Backend Architecture doc, 2026-09-16 scoping): bounds
// worst-case runaway cost from a bug or abuse without risking an app-wide
// outage, since this is a solo-maintained app with no on-call.
setGlobalOptions({ maxInstances: 10 });

const { submitMatchResultHandler } = require('./lib/submitMatchResult');
const { applyStrikePenaltyHandler } = require('./lib/applyStrikePenalty');
const { reportPendingResultHandler } = require('./lib/reportPendingResult');
const { cancelPendingResultHandler } = require('./lib/cancelPendingResult');

exports.submitMatchResult = onCall((request) => submitMatchResultHandler(db, request));
exports.applyStrikePenalty = onCall((request) => applyStrikePenaltyHandler(db, request));
exports.reportPendingResult = onCall((request) => reportPendingResultHandler(db, request));
exports.cancelPendingResult = onCall((request) => cancelPendingResultHandler(db, request));
