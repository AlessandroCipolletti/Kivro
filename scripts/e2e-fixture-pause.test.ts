import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureInferenceGate, pauseFixtureImage } from './e2e-fixture-pause.js';

test('fixture gate drains exactly one response and keeps the next call held', async () => {
  const gate = new FixtureInferenceGate();
  let completed = 0;
  const first = gate.enter().then(() => { completed++; });
  await Promise.resolve(); assert.equal(completed, 0); assert.equal(gate.pending, true);
  gate.release(); await first; assert.equal(completed, 1); assert.equal(gate.pending, false);
  const second = gate.enter().then(() => { completed++; });
  await Promise.resolve(); assert.equal(completed, 1); assert.equal(gate.pending, true);
  gate.release(); await second; assert.equal(completed, 2);
});

test('fixture gate permits completion only after explicit opening', async () => {
  const gate = new FixtureInferenceGate(), waiting = gate.enter();
  gate.open(); await waiting; assert.equal(gate.pending, false);
  await gate.enter(); assert.equal(gate.pending, false);
  gate.open(); gate.release();
});

test('fixture gate rejects unexpected concurrent inference', async () => {
  const gate = new FixtureInferenceGate(), waiting = gate.enter();
  await assert.rejects(gate.enter(), /FIXTURE_CONCURRENT_PROVIDER_GATE/);
  gate.open(); await waiting;
});

test('pause image selection permits local pinned identifiers only', () => {
  for (const value of ['kivro-sandbox:2026.8.2', 'kivro-sandbox:2026.8.2-pause-v2', `sha256:${'a'.repeat(64)}`]) assert.equal(pauseFixtureImage(value), value);
  for (const value of ['', 'ubuntu:latest', 'https://example.test/image', '/tmp/image', 'kivro-sandbox:tag\n', ' kivro-sandbox:tag',
    'kivro-sandbox:tag;echo', 'sha256:bad', `sha256:${'g'.repeat(64)}`, 'kivro-sandbox:../tag']) assert.throws(() => pauseFixtureImage(value));
});
