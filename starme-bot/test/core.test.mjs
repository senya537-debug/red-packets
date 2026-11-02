import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { buildBot } from '../src/factory.mjs';
import { solidPng } from './helpers.mjs';

function makeCore() {
  const dir = join(tmpdir(), 'starme-' + randomUUID());
  const config = {
    ...loadConfig(),
    telegramToken: '',
    generator: 'mock',
    analyzer: 'heuristic',
    dataDir: dir,
    maxSelfieReuse: 0,
  };
  return buildBot(config);
}

test('two-stage flow: scene photo then selfie produces a result', async () => {
  const { core } = makeCore();
  await core.init();
  const uid = 'user-1';
  const scene = solidPng(640, 800, [10, 20, 30]);
  const selfie = solidPng(320, 320, [200, 180, 160]);

  const r1 = await core.handlePhoto(uid, scene, { filename: 'scene.png', mimeType: 'image/png' });
  assert.equal(r1.ok, true);
  assert.equal(r1.type, 'scene_accepted');
  assert.equal(r1.session.stage, 'await_selfie');
  assert.equal(r1.session.designCode.version, 1);
  assert.equal(r1.session.sceneRef.kind, 'scene');

  const r2 = await core.handlePhoto(uid, selfie, { filename: 'selfie.png', mimeType: 'image/png' });
  assert.equal(r2.ok, true);
  assert.equal(r2.type, 'result');
  assert.ok(r2.result.buffer.length > 0);
  assert.equal(r2.result.kind, 'result');
});

test('design code persists and can be reused for another selfie', async () => {
  const { core } = makeCore();
  await core.init();
  const uid = 'user-2';
  const scene = solidPng(640, 800, [10, 20, 30]);
  const selfie = solidPng(320, 320, [200, 180, 160]);

  await core.handlePhoto(uid, scene, { filename: 's.png', mimeType: 'image/png' });
  const r1 = await core.handlePhoto(uid, selfie, { filename: 'selfie.png', mimeType: 'image/png' });
  assert.equal(r1.type, 'result');

  const r2 = await core.handlePhoto(uid, selfie, { filename: 'selfie2.png', mimeType: 'image/png' });
  assert.equal(r2.type, 'result');
  assert.equal(r2.session.reuseCount, 2);
  assert.equal(r2.session.designCode.version, 1);
});

test('commands: status, template, reset', async () => {
  const { core } = makeCore();
  await core.init();
  const uid = 'user-3';

  assert.match((await core.handleText(uid, '/status')).message, /нет активной сцены/);
  await core.handlePhoto(uid, solidPng(640, 800, [1, 2, 3]), { filename: 's.png', mimeType: 'image/png' });
  assert.match((await core.handleText(uid, '/status')).message, /ожидается селфи/);

  const tmpl = await core.handleText(uid, '/template');
  assert.equal(tmpl.ok, true);
  assert.equal(tmpl.designCode.version, 1);

  const reset = await core.handleText(uid, '/reset');
  assert.equal(reset.type, 'reset');
  assert.equal(core.store.getSession(uid), null);
});

test('empty photo is rejected without creating a session', async () => {
  const { core } = makeCore();
  await core.init();
  const r = await core.handlePhoto('u-empty', Buffer.alloc(0), { filename: 'x.jpg' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty_photo');
});

test('analyzer failure rolls back the stored scene image', async () => {
  const { core, store } = makeCore();
  // force the analyzer to fail
  core.analyzer = { name: 'failing', async analyze() { throw new Error('boom'); } };
  await core.init();
  const uid = 'u-fail';
  const r = await core.handlePhoto(uid, solidPng(100, 100, [1, 1, 1]), { filename: 's.png', mimeType: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'analyzer_failed');
  assert.equal(store.getSession(uid), null);
});

test('selfie guard rejects a selfie and rolls back', async () => {
  const { core } = makeCore();
  await core.init();
  const uid = 'u-guard';
  await core.handlePhoto(uid, solidPng(640, 800, [1, 2, 3]), { filename: 's.png', mimeType: 'image/png' });
  core.selfieGuard = async () => { throw new Error('no face'); };
  const r = await core.handlePhoto(uid, solidPng(320, 320, [4, 5, 6]), { filename: 'selfie.png', mimeType: 'image/png' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'selfie_rejected');
  assert.match(r.message, /no face/);
  // design code is still available for another selfie
  assert.equal(core.store.getSession(uid).stage, 'await_selfie');
});
