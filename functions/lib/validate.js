'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }
  return request.auth.uid;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpsError('invalid-argument', `${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function optionalArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

module.exports = { requireAuth, requireNonEmptyString, optionalString, optionalArray, HttpsError };
