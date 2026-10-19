import {execFileSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedCreate, clientConfig, retryRead, shellQuote } from './controller.mjs';

test('provisioning forces the dedicated credential-free environment and removes unrelated injected variables', () => {
  assert.deepEqual(protectedCreate({ noEnv: false, environment: 'base', ttlSeconds: 7200, env: { RAKAZO_BOT_ID: 'fake-bot', SECRET: 'fake-value' } }), {
    noEnv: true, environment: 'rakazo', ttlSeconds: 7200, env: { RAKAZO_BOT_ID: 'fake-bot', RAKAZO_SANDBOX: 'computer' },
  });
});
test('missing or malformed bot identities refuse provisioning', () => {
  for (const body of [{}, { env: { RAKAZO_BOT_ID: '../other' } }, { env: { RAKAZO_BOT_ID: '' } }]) assert.throws(() => protectedCreate(body));
});
test('each tunnel routes only the private browser proxy and reserves the gateway address', () => {
  const config = clientConfig('fake-private', 'fake-public', 2);
  assert.match(config, /Address = 10\.202\.0\.2\/32, fd42:202:7261::2\/128/);
  assert.match(config, /Table = auto/);
  assert.match(config, /AllowedIPs = 10\.202\.0\.1\/32/);
  assert.throws(() => clientConfig('a', 'b', 1));
  assert.throws(() => clientConfig('a', 'b', 251));
});

test('transient reads retry without repeating mutations', async () => {
  let reads = 0;
  assert.equal(await retryRead(async () => { if (++reads < 3) throw new Error('connection lost'); return 'recovered'; }, 'GET', async () => {}), 'recovered');
  assert.equal(reads, 3);
  let writes = 0;
  await assert.rejects(retryRead(async () => { writes++; throw new Error('uncertain create'); }, 'POST', async () => {}));
  assert.equal(writes, 1);
});
test('authorization failures do not retry', async () => {
  let calls = 0;
  await assert.rejects(retryRead(async () => { calls++; throw Object.assign(new Error('forbidden'), {status: 403}); }, 'GET', async () => {}));
  assert.equal(calls, 1);
});

test('bootstrap scripts keep shell metacharacters literal', () => {
  const value="quote'\n$(printf expanded)`printf expanded`";
  assert.equal(execFileSync('sh', ['-c', 'printf %s ' + shellQuote(value)], {encoding:'utf8'}), value);
});
