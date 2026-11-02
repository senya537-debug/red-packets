// StarMe AI "design code" schema, validation, prompt building and scene analyzers.
//
// The design code is the reusable artifact produced from the celebrity photo.
// It describes the SCENE (composition, pose, lighting, ...) separately from the
// IDENTITY (the client selfie). It is intentionally a description, not a command:
// the generator must support the corresponding editing modes.

export const SCHEMA_VERSION = 1;

export const SCENE_FIELDS = [
  'composition',
  'camera_angle',
  'head_position',
  'expression',
  'lighting',
  'background',
  'color_grading',
];

export const CONSTRAINT_FIELDS = [
  'preserve_pose',
  'preserve_clothing',
  'preserve_background',
  'match_lighting',
];

export function emptyDesignCode() {
  return {
    version: SCHEMA_VERSION,
    scene: Object.fromEntries(SCENE_FIELDS.map((f) => [f, ''])),
    identity: { source: 'client_selfie', preserve_identity: true },
    constraints: Object.fromEntries(CONSTRAINT_FIELDS.map((f) => [f, true])),
  };
}

export function validateDesignCode(code) {
  const errors = [];
  if (!code || typeof code !== 'object' || Array.isArray(code)) {
    return { ok: false, errors: ['design code must be an object'] };
  }
  if (code.version !== SCHEMA_VERSION) errors.push(`unsupported version: ${code.version}`);
  if (!code.scene || typeof code.scene !== 'object') errors.push('missing scene object');
  else for (const f of SCENE_FIELDS) if (!(f in code.scene)) errors.push(`missing scene.${f}`);
  if (!code.identity || typeof code.identity !== 'object') errors.push('missing identity object');
  else {
    if (code.identity.source !== 'client_selfie') errors.push('identity.source must be "client_selfie"');
    if (code.identity.preserve_identity !== true) errors.push('identity.preserve_identity must be true');
  }
  if (!code.constraints || typeof code.constraints !== 'object') errors.push('missing constraints object');
  else for (const f of CONSTRAINT_FIELDS) if (!(f in code.constraints)) errors.push(`missing constraints.${f}`);
  return { ok: errors.length === 0, errors };
}

export function normalizeDesignCode(code) {
  const base = emptyDesignCode();
  const out = { ...base, ...code };
  out.scene = { ...base.scene, ...(code.scene || {}) };
  out.identity = { ...base.identity, ...(code.identity || {}) };
  out.constraints = { ...base.constraints, ...(code.constraints || {}) };
  out.version = SCHEMA_VERSION;
  return out;
}

// Turn the structured scene description into a natural-language prompt.
export function buildPrompt(code, extra = '') {
  const s = code.scene || {};
  const clauses = [];
  if (s.composition) clauses.push(String(s.composition));
  if (s.camera_angle) clauses.push(`camera angle: ${s.camera_angle}`);
  if (s.head_position) clauses.push(`head position: ${s.head_position}`);
  if (s.expression) clauses.push(`expression: ${s.expression}`);
  if (s.lighting) clauses.push(`lighting: ${s.lighting}`);
  if (s.background) clauses.push(`background: ${s.background}`);
  if (s.color_grading) clauses.push(`color grading: ${s.color_grading}`);

  const c = code.constraints || {};
  const constraints = [];
  if (c.preserve_pose) constraints.push('keep the original pose and composition');
  if (c.preserve_clothing) constraints.push('keep the original clothing');
  if (c.preserve_background) constraints.push('keep the original background');
  if (c.match_lighting) constraints.push('match the original lighting');

  const parts = ['photorealistic portrait of the person from the identity image', ...clauses, ...constraints];
  if (extra) parts.push(extra);
  parts.push('high detail, sharp focus, natural skin texture, 50mm lens look');
  return parts.filter(Boolean).join(', ');
}

export function buildNegativePrompt(code = {}) {
  const parts = ['lowres', 'blurry', 'deformed', 'bad anatomy', 'extra limbs', 'mutated hands',
    'watermark', 'text', 'signature', 'cartoon', 'illustration'];
  if (code.identity?.preserve_identity) parts.push('different person');
  return parts.join(', ');
}

// --- Offline heuristic analyzer (no network, no model) --------------------------
// It cannot understand the actual content of the photo. It fills a safe default
// design code and records the image dimensions. Use the VLM analyzer for real
// scene understanding.

import { readImageMeta } from './imageMeta.mjs';

export function createHeuristicAnalyzer() {
  return {
    name: 'heuristic',
    async analyze(imageBuffer, meta = {}) {
      const info = readImageMeta(imageBuffer);
      const code = emptyDesignCode();
      const [w, h] = [info?.width, info?.height].filter(Boolean);
      if (w && h) {
        code.scene.composition = w > h ? 'cinematic horizontal portrait' : 'cinematic vertical portrait';
      }
      code.scene.background = 'original background preserved';
      code.notes = ['heuristic placeholder — set STARME_ANALYZER=vlm for real scene understanding'];
      if (meta.filename) code.sourceFile = meta.filename;
      code.imageMeta = info;
      return code;
    },
  };
}

// --- VLM analyzer (OpenAI-compatible vision endpoint) --------------------------
// Any endpoint that accepts chat.completions with an image_url works:
// OpenAI, Azure, Together, Groq, Ollama, LM Studio, vLLM, etc.

export function createVlmAnalyzer({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) throw new Error('VLM analyzer requires VLM_BASE_URL');
  if (!model) throw new Error('VLM analyzer requires VLM_MODEL');

  const systemPrompt = [
    'You are a photography director. Describe a reference portrait photo so that',
    "another AI can recreate the SCENE while a different person's face is placed in it.",
    'Return ONLY a JSON object with this exact shape:',
    JSON.stringify(emptyDesignCode(), null, 2),
    'Describe only what is visible in the image. Do not invent identity details.',
  ].join(' ');

  return {
    name: 'vlm',
    async analyze(imageBuffer, meta = {}) {
      const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
      const body = {
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Describe this reference photo.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] },
        ],
      };
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`VLM HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content || '{}';
      let parsed;
      try { parsed = JSON.parse(content); }
      catch { throw new Error('VLM returned invalid JSON'); }
      return normalizeDesignCode(parsed);
    },
  };
}
