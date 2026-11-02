#!/usr/bin/env node
// Offline end-to-end demo: runs the two-stage flow with the mock generator
// and writes the resulting image to data/demo/result.png. No Telegram, no network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { solidPng } from './png.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildBot } from '../src/factory.mjs';

const config = {
  ...loadConfig(),
  telegramToken: '',
  generator: 'mock',
  analyzer: 'heuristic',
  dataDir: './data/demo',
};

const { core } = buildBot(config);
await core.init();

const scene = solidPng(640, 800, [40, 50, 70]);
const selfie = solidPng(400, 400, [200, 180, 160]);

const r1 = await core.handlePhoto('demo-user', scene, { filename: 'scene.png', mimeType: 'image/png' });
console.log('[demo] stage1:', r1.type, '-', r1.message);
console.log('[demo] design code:', JSON.stringify(r1.session.designCode, null, 2));

const r2 = await core.handlePhoto('demo-user', selfie, { filename: 'selfie.png', mimeType: 'image/png' });
console.log('[demo] stage2:', r2.type, '-', r2.message);
console.log('[demo] result bytes:', r2.result.buffer.length, 'meta:', JSON.stringify(r2.meta));

mkdirSync('./data/demo', { recursive: true });
writeFileSync('./data/demo/result.png', r2.result.buffer);
console.log('[demo] wrote data/demo/result.png');
