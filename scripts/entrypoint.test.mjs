// (C) Regression test for a real bug found in this repo's history: both
// migrate-to-collections.mjs and verify-migration.mjs used
// `import.meta.url === \`file://${process.argv[1]}\`` as their "am I the
// entrypoint" guard. That comparison was always false here — argv[1] isn't
// absolute when invoked relatively, and even absolute it doesn't match
// because this repo's real path contains spaces (".../AI Brain/...") that
// import.meta.url percent-encodes and raw template-string concatenation
// does not. Every production safety guard lived inside the unreached
// main(), so both scripts silently exited 0 having done nothing.
//
// This MUST invoke both scripts as real subprocesses, never by importing
// their functions — importing is exactly what let the original bug hide
// from dry-run-migration.mjs, which only ever calls runMigration()/
// runVerification() directly and never executes either file's own
// `if (... === entrypoint)` guard at all.
//
// Every case here must assert a NON-ZERO exit code. The bug produced exit 0
// with empty stdout/stderr, so a test that only greps output for expected
// text would have passed against the broken version too.
//
// Nothing here ever passes a real GCLOUD_PROJECT alongside --prod +
// MIGRATION_CONFIRM_PROD — that is the one combination that writes
// production data, and it belongs nowhere in an automated test.
//
// Run: node scripts/entrypoint.test.mjs (no emulator needed — every case
// below is expected to refuse before touching Firestore at all).

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATE_REL = 'scripts/migrate-to-collections.mjs';
const MIGRATE_ABS = path.join(__dirname, 'migrate-to-collections.mjs');
const VERIFY_REL = 'scripts/verify-migration.mjs';
const VERIFY_ABS = path.join(__dirname, 'verify-migration.mjs');
const ROLLBACK_REL = 'scripts/rollback-migration.mjs';
const ROLLBACK_ABS = path.join(__dirname, 'rollback-migration.mjs');
const REPO_ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

async function run(scriptPath, args = [], env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...env,
          // Guarantee a clean slate regardless of the ambient shell —
          // these are exactly the variables the guards key off of.
          FIRESTORE_EMULATOR_HOST: env.FIRESTORE_EMULATOR_HOST,
          MIGRATION_CONFIRM_PROD: env.MIGRATION_CONFIRM_PROD,
          GCLOUD_PROJECT: env.GCLOUD_PROJECT,
        },
      }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    // execFile rejects on non-zero exit — that's the success case for
    // every test below, so pull the exit code back out rather than
    // treating the rejection itself as a test failure.
    return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assertNonZero(result, context) {
  if (result.code === 0) {
    throw new Error(`${context}: expected non-zero exit, got 0. stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
  }
}

function assertContains(haystack, needle, context) {
  if (!haystack.includes(needle)) {
    throw new Error(`${context}: expected output to contain ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`);
  }
}

async function main() {
  console.log('migrate-to-collections.mjs:');

  await check('no env, no flags, relative path -> refuses, non-zero exit', async () => {
    const r = await run(MIGRATE_REL, [], {});
    assertNonZero(r, 'relative invocation');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', 'relative invocation');
  });

  await check('no env, no flags, ABSOLUTE path -> refuses, non-zero exit (the %20 case)', async () => {
    const r = await run(MIGRATE_ABS, [], {});
    assertNonZero(r, 'absolute invocation');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', 'absolute invocation');
  });

  await check('--prod without MIGRATION_CONFIRM_PROD -> refuses, non-zero exit', async () => {
    const r = await run(MIGRATE_REL, ['--prod'], {});
    assertNonZero(r, '--prod without confirm');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', '--prod without confirm');
  });

  await check('--prod + MIGRATION_CONFIRM_PROD, no GCLOUD_PROJECT -> refuses, non-zero exit', async () => {
    const r = await run(MIGRATE_REL, ['--prod'], { MIGRATION_CONFIRM_PROD: 'yes-i-am-sure' });
    assertNonZero(r, '--prod + confirm, no project id');
    assertContains(r.stderr, 'Refusing to guess a project id', '--prod + confirm, no project id');
  });

  await check('FIRESTORE_EMULATOR_HOST set + --prod -> refuses as contradictory intent, non-zero exit', async () => {
    const r = await run(MIGRATE_REL, ['--prod'], {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      MIGRATION_CONFIRM_PROD: 'yes-i-am-sure',
      GCLOUD_PROJECT: 'demo-migration',
    });
    assertNonZero(r, 'emulator host + --prod');
    assertContains(r.stderr, 'contradictory intent', 'emulator host + --prod');
  });

  console.log('\nverify-migration.mjs:');

  await check('no env -> refuses, non-zero exit, no success line', async () => {
    const r = await run(VERIFY_REL, [], {});
    assertNonZero(r, 'verify, no env');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', 'verify, no env');
    if (r.stdout.includes('ALL CHECKS PASSED')) {
      throw new Error('verify printed a success line despite refusing to run');
    }
  });

  await check('no env, ABSOLUTE path -> refuses, non-zero exit (the %20 case)', async () => {
    const r = await run(VERIFY_ABS, [], {});
    assertNonZero(r, 'verify, absolute, no env');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', 'verify, absolute, no env');
  });

  await check('--prod, no GCLOUD_PROJECT -> refuses, non-zero exit', async () => {
    const r = await run(VERIFY_REL, ['--prod'], {});
    assertNonZero(r, 'verify --prod, no project id');
    assertContains(r.stderr, 'Refusing to guess a project id', 'verify --prod, no project id');
  });

  await check('FIRESTORE_EMULATOR_HOST set + --prod -> refuses as contradictory intent, non-zero exit', async () => {
    const r = await run(VERIFY_REL, ['--prod'], {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      GCLOUD_PROJECT: 'demo-migration',
    });
    assertNonZero(r, 'verify emulator host + --prod');
    assertContains(r.stderr, 'contradictory intent', 'verify emulator host + --prod');
  });

  console.log('\nrollback-migration.mjs:');

  await check('no env, no flags, relative path -> refuses, non-zero exit', async () => {
    const r = await run(ROLLBACK_REL, [], {});
    assertNonZero(r, 'relative invocation');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', 'relative invocation');
  });

  await check('no env, no flags, ABSOLUTE path -> refuses, non-zero exit (the %20 case)', async () => {
    const r = await run(ROLLBACK_ABS, [], {});
    assertNonZero(r, 'absolute invocation');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', 'absolute invocation');
  });

  await check('--prod without MIGRATION_CONFIRM_PROD -> refuses, non-zero exit', async () => {
    const r = await run(ROLLBACK_REL, ['--prod'], {});
    assertNonZero(r, '--prod without confirm');
    assertContains(r.stderr, 'FIRESTORE_EMULATOR_HOST is not set', '--prod without confirm');
  });

  await check('--prod + MIGRATION_CONFIRM_PROD, no GCLOUD_PROJECT -> refuses, non-zero exit', async () => {
    const r = await run(ROLLBACK_REL, ['--prod'], { MIGRATION_CONFIRM_PROD: 'yes-i-am-sure' });
    assertNonZero(r, '--prod + confirm, no project id');
    assertContains(r.stderr, 'Refusing to guess a project id', '--prod + confirm, no project id');
  });

  await check('FIRESTORE_EMULATOR_HOST set + --prod -> refuses as contradictory intent, non-zero exit', async () => {
    const r = await run(ROLLBACK_REL, ['--prod'], {
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      MIGRATION_CONFIRM_PROD: 'yes-i-am-sure',
      GCLOUD_PROJECT: 'demo-migration',
    });
    assertNonZero(r, 'emulator host + --prod');
    assertContains(r.stderr, 'contradictory intent', 'emulator host + --prod');
  });

  console.log(`\n${passed} check(s) passed${failed ? `, ${failed} FAILED` : ''}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
