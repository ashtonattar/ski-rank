'use strict';

const crypto = require('crypto');
const { requireAuth, HttpsError } = require('./validate');
const { resolveCallerPlayerId } = require('./identity');

/**
 * Side track A (2026-10-12): signed Cloudinary clip uploads.
 *
 * Clips used to go up through the UNSIGNED preset `skirank-clips`, whose
 * name sits in the public index.html, so anyone could upload straight into
 * the account and burn the free-tier credits. Now the client asks this
 * callable for a one-off signature first. The server picks every signed
 * param (public_id, allowed formats, overwrite), so nothing about the
 * upload depends on a preset, and the preset can be deleted.
 *
 * Two daily caps, both counted per UTC day in server-only docs:
 *   - per player: uploadQuotas/{playerId} { day, count }
 *   - all players together: uploadQuotaTotals/{day} { count }, a circuit
 *     breaker against many throwaway accounts, so uploads fail with a clear
 *     message before the Cloudinary account itself goes over quota.
 * A rejected call increments neither.
 *
 * `apiKey`, `apiSecret` and `now` are injected so the emulator tests never
 * need the real secret.
 */

// Values from the 2026-10-12 plan review; Ashton to confirm.
const PER_PLAYER_DAILY_LIMIT = 10;
const GLOBAL_DAILY_LIMIT = 150;

// Video only. Signed, so the server sets the allowlist, not a preset.
const ALLOWED_FORMATS = 'mp4,mov,webm,m4v,3gp';

// The Cloudinary account uses Dynamic Folders (Ashton checked, 2026-10-12),
// so the Media Library folder is set by asset_folder, not by the public_id
// path. It's one FIXED, pre-created folder: the API key has the Contributor
// role, which can upload into an existing folder but not create one, so a
// per-player folder failed in prod with "missing permissions
// (actions=["create"])". The player id stays in the public_id, so delivery
// URLs still read skirank/clips/{playerId}/...
const SIGN_ASSET_FOLDER = true;
const ASSET_FOLDER = 'skirank/clips';

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Cloudinary's standard upload signature: params sorted by key, joined as
 * k=v&k=v, with the API secret appended, then SHA-1 hex. Empty values are
 * left out, as the Cloudinary SDKs do.
 */
function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

async function signClipUploadHandler(db, request, { apiKey, apiSecret, now = Date.now() } = {}) {
  const uid = requireAuth(request);
  if (!apiKey || !apiSecret) {
    throw new HttpsError('failed-precondition', 'Clip uploads are not configured.');
  }
  const day = utcDay(now);

  const playerId = await db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const playerRef = db.collection('uploadQuotas').doc(callerId);
    const totalRef = db.collection('uploadQuotaTotals').doc(day);
    const [playerSnap, totalSnap] = await Promise.all([tx.get(playerRef), tx.get(totalRef)]);

    const p = playerSnap.exists ? playerSnap.data() : {};
    const playerCount = p.day === day ? (p.count || 0) : 0;
    const totalCount = totalSnap.exists ? (totalSnap.data().count || 0) : 0;

    if (playerCount >= PER_PLAYER_DAILY_LIMIT) {
      throw new HttpsError('resource-exhausted',
        `You've hit today's limit of ${PER_PLAYER_DAILY_LIMIT} clip uploads. Try again tomorrow.`,
        { limit: 'player' });
    }
    if (totalCount >= GLOBAL_DAILY_LIMIT) {
      throw new HttpsError('resource-exhausted',
        'Clip uploads are paused for today. Try again tomorrow.',
        { limit: 'global' });
    }

    tx.set(playerRef, { day, count: playerCount + 1 });
    tx.set(totalRef, { count: totalCount + 1 });
    return callerId;
  });

  const folder = `skirank/clips/${playerId}`;
  const params = {
    public_id: `${folder}/${now}_${crypto.randomBytes(6).toString('hex')}`,
    allowed_formats: ALLOWED_FORMATS,
    overwrite: 'false',
    timestamp: Math.floor(now / 1000)
  };
  if (SIGN_ASSET_FOLDER) params.asset_folder = ASSET_FOLDER;

  const result = {
    apiKey,
    timestamp: params.timestamp,
    signature: signParams(params, apiSecret),
    publicId: params.public_id,
    allowedFormats: params.allowed_formats,
    overwrite: params.overwrite
  };
  if (SIGN_ASSET_FOLDER) result.assetFolder = params.asset_folder;
  return result;
}

module.exports = {
  signClipUploadHandler,
  signParams,
  PER_PLAYER_DAILY_LIMIT,
  GLOBAL_DAILY_LIMIT,
  ALLOWED_FORMATS
};
