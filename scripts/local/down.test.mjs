import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDown } from './down.mjs';

test('stops the fleet before selecting workers and limits cleanup to the local stack', () => {
  const calls = [];
  localDown(args => {
    calls.push(args);
    if (args[0] === 'ps' && args.includes('label=com.docker.compose.project=tabductor')) return 'fleet\ngateway\n';
    if (args[0] === 'ps') {
      assert.deepEqual(calls.at(-2), ['stop', 'fleet', 'gateway']);
      assert.ok(args.includes('label=tabductor.local-browser=1'));
      assert.ok(args.includes('network=tabductor_default'));
      return 'worker\n';
    }
    return '';
  });
  assert.deepEqual(calls.at(-2), ['rm', '-f', 'worker']);
  assert.deepEqual(calls.at(-1), ['compose', '-p', 'tabductor', '-f', 'docker-compose.yml', '--profile', '*', 'down', '--remove-orphans']);
});

test('can run again when containers are already gone', () => {
  const calls = [];
  localDown(args => { calls.push(args); return ''; });
  assert.ok(calls.at(-1).includes('down'));
  assert.ok(calls.every(args => !['stop', 'rm'].includes(args[0])));
});

test('does not remove workers or the network if stopping the controller fails', () => {
  const calls = [];
  assert.throws(() => localDown(args => {
    calls.push(args);
    if (args[0] === 'ps') return 'fleet\n';
    if (args[0] === 'stop') throw Error('stop failed');
    return '';
  }), /stop failed/);
  assert.equal(calls.at(-1)[0], 'stop');
});

test('checks Compose configuration before stopping any containers', () => {
  const calls = [];
  assert.throws(() => localDown(args => {
    calls.push(args);
    throw Error('invalid config');
  }), /invalid config/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(-2), ['config', '--quiet']);
});
