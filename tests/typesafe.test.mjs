import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  choice,
  score,
  noul,
  getApiKey,
  queryJev,
  projectState,
  createDecisionTrace,
  PINNED_PRODUCTION_MODEL
} from '../src/lib/typesafe.mjs';

test('production model is pinned to jev-1.13.0', () => {
  assert.equal(PINNED_PRODUCTION_MODEL, 'jev-1.13.0');
});

test('primitive builders create valid System One question objects', () => {
  const c = choice('Select option', { a: 'Option A', b: 'Option B' });
  assert.equal(c.type, 'choice');
  assert.equal(c.instructions, 'Select option');
  assert.deepEqual(c.criteria, { a: 'Option A', b: 'Option B' });

  const s = score('Rate quality', ['Bad', 'Good']);
  assert.equal(s.type, 'score');
  assert.deepEqual(s.criteria, ['Bad', 'Good']);

  const n = noul('Is this urgent?');
  assert.equal(n.type, 'noul');
  assert.equal(n.instructions, 'Is this urgent?');
});

test('projectState allowlists known fields and discards secrets (negative control)', () => {
  const raw = {
    title: 'Fix bridge timeout',
    description: 'Investigate desktop bridge lockup',
    repo: 'payments',
    api_key: 'sk-secret-typesafe-12345',
    db_password: 'supersecretpassword',
    bearer_token: 'xyz-token',
    nested_credential: { secret: 'do-not-leak' },
    notes: {
      innerApiKey: 'sk-nested-key-1234567890',
      safe_note: 'investigate bridge protocol',
      passwords: ['pw123', 'pw456']
    }
  };

  const projectedStr = projectState(raw);
  const parsed = JSON.parse(projectedStr);

  assert.equal(parsed.title, 'Fix bridge timeout');
  assert.equal(parsed.description, 'Investigate desktop bridge lockup');
  assert.equal(parsed.repo, 'payments');

  // Verify stripped top-level secrets
  assert.equal(parsed.api_key, undefined);
  assert.equal(parsed.db_password, undefined);
  assert.equal(parsed.bearer_token, undefined);
  assert.equal(parsed.nested_credential, undefined);

  // Verify nested objects inside allowlisted fields are scrubbed
  assert.equal(parsed.notes.safe_note, 'investigate bridge protocol');
  assert.equal(parsed.notes.innerApiKey, undefined);
  assert.equal(parsed.notes.passwords, undefined);
  assert.doesNotMatch(projectedStr, /secret-typesafe/);
  assert.doesNotMatch(projectedStr, /supersecretpassword/);
  assert.doesNotMatch(projectedStr, /sk-nested-key/);
});

test('projectState scrubs raw string and array secrets (negative control)', () => {
  const rawString = "Please review error with apiKey=supersecret123 and bearer sk-abc1234567890def";
  const scrubbedString = projectState(rawString);
  assert.doesNotMatch(scrubbedString, /supersecret123/);
  assert.doesNotMatch(scrubbedString, /sk-abc1234567890def/);
  assert.match(scrubbedString, /apiKey=\[REDACTED\]/);
  assert.match(scrubbedString, /\[REDACTED_API_KEY\]/);

  // Exact adversarial reviewer counterexamples:
  const credentialSamples = [
    "api_key=abcd1234567890", // gitleaks:allow (fake credential the redaction test must scrub)
    "access_token=abcd1234567890", // gitleaks:allow (fake credential the redaction test must scrub)
    "github_pat_11AA12345678901234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "AKIAIOSFODNN7EXAMPLE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak_signature_here" // gitleaks:allow (fake credential the redaction test must scrub)
  ].join(" ");

  const scrubbedCredentials = projectState(credentialSamples);
  assert.doesNotMatch(scrubbedCredentials, /abcd1234567890/);
  assert.doesNotMatch(scrubbedCredentials, /github_pat_11AA/);
  assert.doesNotMatch(scrubbedCredentials, /ghp_abcdefgh/);
  assert.doesNotMatch(scrubbedCredentials, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(scrubbedCredentials, /do_not_leak_signature_here/);
  assert.match(scrubbedCredentials, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(scrubbedCredentials, /\[REDACTED_AWS_KEY\]/);
  assert.match(scrubbedCredentials, /\[REDACTED_JWT\]/);

  const rawArray = [
    { title: "Normal task" },
    { secretKey: "do_not_leak_array_token", token: "bearer-xyz" }
  ];
  const scrubbedArrayStr = projectState(rawArray);
  const parsedArray = JSON.parse(scrubbedArrayStr);
  assert.equal(parsedArray[0].title, "Normal task");
  assert.equal(parsedArray[1].secretKey, undefined);
  assert.equal(parsedArray[1].token, undefined);
  assert.doesNotMatch(scrubbedArrayStr, /do_not_leak_array_token/);
});

test('projectState safely truncates oversized payloads', () => {
  const hugeText = 'a'.repeat(5000);
  const truncated = projectState(hugeText, { maxStateLength: 100 });
  assert.ok(truncated.length <= 200);
  assert.match(truncated, /truncated for Jev System One payload limit/);
});

test('createDecisionTrace produces structured audit record', () => {
  const trace = createDecisionTrace({
    decisionId: 'test-123',
    decisionType: 'dispatch',
    latencyMs: 142,
    status: 'ok',
    answers: { is_risky: { noul: 0.12 } }
  });

  assert.equal(trace.schema_version, 1);
  assert.equal(trace.decision_id, 'test-123');
  assert.equal(trace.decision_type, 'dispatch');
  assert.equal(trace.model, PINNED_PRODUCTION_MODEL);
  assert.equal(trace.latency_ms, 142);
  assert.equal(trace.status, 'ok');
  assert.equal(trace.answers.is_risky.noul, 0.12);
});

test('queryJev rejects when API key is missing (negative control)', async () => {
  await assert.rejects(
    async () => {
      await queryJev('Task: test missing key', { t: noul('test') }, { apiKey: '' });
    },
    /Missing TYPESAFE_API_KEY environment variable/i
  );
});

test('package.json remains free of runtime dependencies', () => {
  const pkgPath = resolve('package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'Must not introduce npm dependencies for Jev client');
});

test('queryJev executes a typed question against Jev', async (t) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    t.skip('Skipping live TypeSafe test: TYPESAFE_API_KEY not found');
    return;
  }

  const res = await queryJev(
    'Task: fix typo in README',
    {
      category: choice('What is this task?', {
        docs: 'Documentation or readme update',
        code: 'Bug fix in source code'
      }),
      is_docs: noul('Does this modify documentation?')
    }
  );

  assert.ok(res.answers, 'Must return answers object');
  assert.equal(res.answers.category.choice, 'docs');
  assert.ok(res.answers.category.confidence >= 0.8, 'Confidence should be high for simple typo');
  assert.ok(res.answers.is_docs.noul >= 0.8, 'Noul probability for docs should be high');
  assert.ok(res.latencyMs > 0, 'Should measure latency');
});

test('queryJev aborts when request exceeds timeoutMs', async (t) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    t.skip('Skipping live TypeSafe test: TYPESAFE_API_KEY not found');
    return;
  }

  await assert.rejects(
    async () => {
      await queryJev('Task: huge background simulation', {
        test: noul('Does this take time?')
      }, { timeoutMs: 1 });
    },
    /timed out after 1ms/i
  );
});

test('queryJev handles malformed API response and server error gracefully (negative control)', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error: Malformed backend payload');
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      async () => {
        await queryJev('Task: test server error', { t: noul('test') }, {
          apiUrl: `http://127.0.0.1:${port}`,
          apiKey: 'test-key',
          timeoutMs: 1000
        });
      },
      /TypeSafe API error HTTP 500/i
    );
  } finally {
    server.close();
  }
});


