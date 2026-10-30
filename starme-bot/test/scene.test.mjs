import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDesignCode, validateDesignCode, normalizeDesignCode,
  buildPrompt, buildNegativePrompt, createHeuristicAnalyzer,
  SCENE_FIELDS, CONSTRAINT_FIELDS, SCHEMA_VERSION,
} from '../src/scene.mjs';
import { solidPng } from './helpers.mjs';

test('emptyDesignCode has the full schema', () => {
  const code = emptyDesignCode();
  assert.equal(code.version, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(code.scene).sort(), SCENE_FIELDS.slice().sort());
  assert.deepEqual(Object.keys(code.constraints).sort(), CONSTRAINT_FIELDS.slice().sort());
  assert.equal(code.identity.source, 'client_selfie');
  assert.equal(code.identity.preserve_identity, true);
});

test('validateDesignCode accepts a valid code and rejects malformed ones', () => {
  assert.equal(validateDesignCode(emptyDesignCode()).ok, true);
  assert.equal(validateDesignCode(null).ok, false);
  assert.equal(validateDesignCode({ version: 99, scene: {}, identity: {}, constraints: {} }).ok, false);
  const bad = emptyDesignCode();
  delete bad.scene.lighting;
  assert.equal(validateDesignCode(bad).ok, false);
  const badId = emptyDesignCode();
  badId.identity.source = 'celebrity';
  assert.equal(validateDesignCode(badId).ok, false);
});

test('normalizeDesignCode fills missing fields with defaults', () => {
  const norm = normalizeDesignCode({ scene: { composition: 'close-up' } });
  assert.equal(norm.scene.composition, 'close-up');
  assert.equal(norm.scene.lighting, '');
  assert.equal(norm.version, SCHEMA_VERSION);
  assert.equal(norm.identity.preserve_identity, true);
  assert.equal(norm.constraints.preserve_pose, true);
});

test('buildPrompt turns the design code into a scene prompt', () => {
  const code = emptyDesignCode();
  Object.assign(code.scene, {
    composition: 'cinematic close-up portrait',
    camera_angle: 'three-quarter view',
    head_position: 'head tilted slightly to the left',
    expression: 'confident, natural expression',
    lighting: 'soft directional movie lighting',
    background: 'dark studio backdrop',
    color_grading: 'warm cinematic tones',
  });
  const prompt = buildPrompt(code);
  assert.match(prompt, /cinematic close-up portrait/);
  assert.match(prompt, /three-quarter view/);
  assert.match(prompt, /soft directional movie lighting/);
  assert.match(prompt, /keep the original pose/);
  assert.match(prompt, /keep the original background/);
});

test('buildNegativePrompt includes identity and quality guards', () => {
  const neg = buildNegativePrompt(emptyDesignCode());
  assert.match(neg, /different person/);
  assert.match(neg, /blurry/);
  assert.match(neg, /watermark/);
});

test('heuristic analyzer returns a valid design code with image meta', async () => {
  const analyzer = createHeuristicAnalyzer();
  const buf = solidPng(100, 200, [1, 2, 3]);
  const code = await analyzer.analyze(buf, { filename: 'x.png' });
  assert.equal(validateDesignCode(code).ok, true);
  assert.equal(code.imageMeta.width, 100);
  assert.equal(code.imageMeta.height, 200);
  assert.match(code.scene.composition, /portrait/);
});
