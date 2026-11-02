// Generator abstraction.
//
// All generators expose:
//   name: string
//   async render(designCode, selfieBuffer, sceneBuffer, meta): Promise<{buffer, mimeType, meta}>
//   capabilities(): { sceneRef: boolean, selfie: boolean, prompt: boolean }
//
// `sceneBuffer` is the stored celebrity photo (structure/pose/background reference).
// `selfieBuffer` is the client identity source.
//
// Real generators talk to a local Python worker over a tiny HTTP protocol:
//   POST {workerUrl}/render
//   { "prompt", "negative_prompt", "identity_image": "<b64>", "scene_image": "<b64>", "params": {...} }
//   -> { "image": "<b64>", "mime": "image/jpeg" }
// The worker implements the actual model (FaceFusion / InstantID / ...).

export class GeneratorError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GeneratorError';
    this.status = status;
    this.body = body;
  }
}

export class MockGenerator {
  name = 'mock';

  capabilities() {
    return { sceneRef: true, selfie: true, prompt: true };
  }

  async render(_designCode, _selfieBuffer, sceneBuffer) {
    // Placeholder: returns the scene reference so the pipeline is exercisable
    // end-to-end without a model. Real generators replace this.
    return {
      buffer: sceneBuffer,
      mimeType: 'image/jpeg',
      meta: { generator: this.name, note: 'placeholder result — configure STARME_GENERATOR' },
    };
  }
}

async function postRender(workerUrl, payload, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(`${workerUrl}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new GeneratorError(`generator worker unreachable at ${workerUrl}: ${error.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GeneratorError(`generator worker HTTP ${res.status}: ${body.slice(0, 300)}`,
      { status: res.status, body });
  }
  const json = await res.json().catch(() => null);
  if (!json || !json.image) throw new GeneratorError('generator worker returned no image');
  return {
    buffer: Buffer.from(json.image, 'base64'),
    mimeType: json.mime || 'image/jpeg',
    meta: { generator: json.generator || 'worker', worker: workerUrl, ...(json.meta || {}) },
  };
}

export class FaceFusionGenerator {
  name = 'facefusion';

  constructor({ workerUrl, fetchImpl = globalThis.fetch } = {}) {
    if (!workerUrl) throw new Error('FaceFusionGenerator requires a worker URL');
    this.workerUrl = workerUrl;
    this.fetchImpl = fetchImpl;
  }

  capabilities() {
    // Face swap preserves the scene photo exactly; the prompt is informational.
    return { sceneRef: true, selfie: true, prompt: false };
  }

  async render(designCode, selfieBuffer, sceneBuffer) {
    return postRender(this.workerUrl, {
      mode: 'swap',
      prompt: '',
      negative_prompt: '',
      identity_image: selfieBuffer.toString('base64'),
      scene_image: sceneBuffer.toString('base64'),
      params: {
        preserve_background: designCode?.constraints?.preserve_background !== false,
        match_lighting: designCode?.constraints?.match_lighting !== false,
      },
    }, this.fetchImpl);
  }
}

export class InstantIdGenerator {
  name = 'instantid';

  constructor({ workerUrl, fetchImpl = globalThis.fetch, buildPrompt, buildNegativePrompt } = {}) {
    if (!workerUrl) throw new Error('InstantIdGenerator requires a worker URL');
    this.workerUrl = workerUrl;
    this.fetchImpl = fetchImpl;
    this.buildPrompt = buildPrompt;
    this.buildNegativePrompt = buildNegativePrompt;
  }

  capabilities() {
    // Text prompt drives the scene, selfie drives identity, scene drives pose.
    return { sceneRef: true, selfie: true, prompt: true };
  }

  async render(designCode, selfieBuffer, sceneBuffer) {
    const prompt = this.buildPrompt ? this.buildPrompt(designCode) : '';
    const negative = this.buildNegativePrompt ? this.buildNegativePrompt(designCode) : '';
    return postRender(this.workerUrl, {
      mode: 'instantid',
      prompt,
      negative_prompt: negative,
      identity_image: selfieBuffer.toString('base64'),
      scene_image: sceneBuffer.toString('base64'),
      params: {
        ip_adapter_scale: 0.8,
        controlnet_conditioning_scale: 0.8,
        steps: 30,
        guidance_scale: 7.0,
      },
    }, this.fetchImpl);
  }
}

// Optional abuse-prevention guard: reject selfies where no face is detected.
// Calls the worker's POST /analyze endpoint (implemented by the Python workers).
export function createFaceGuard({ workerUrl, fetchImpl = globalThis.fetch }) {
  return async function selfieGuard(selfieBuffer) {
    let res;
    try {
      res = await fetchImpl(`${workerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: selfieBuffer.toString('base64') }),
      });
    } catch (error) {
      throw new Error(`face guard unreachable at ${workerUrl}: ${error.message}`);
    }
    if (!res.ok) throw new Error(`face guard HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    if (!json.has_face) throw new Error('На селфи не найдено лица. Пришлите фото с чётким, хорошо освещённым лицом.');
    return json;
  };
}

// Cloud generator — Replicate face-swap model. No GPU, no worker: just an API
// token (free credits on signup, ~$0.0016 per image). Creates a prediction,
// polls until done, downloads the result.
export class ReplicateGenerator {
  name = 'replicate';

  constructor({
    apiToken, model = 'pikachupichu25/image-faceswap',
    inputKeys = { source: 'source_image', target: 'target_image' },
    pollMs = 1500, timeoutMs = 120000, fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiToken) throw new Error('ReplicateGenerator requires an API token');
    this.apiToken = apiToken;
    this.model = model;
    this.inputKeys = inputKeys;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  capabilities() {
    return { sceneRef: true, selfie: true, prompt: false };
  }

  _dataUri(buffer) {
    return 'data:image/jpeg;base64,' + buffer.toString('base64');
  }

  async _fetchJson(url, options = {}) {
    const headers = { Authorization: 'Token ' + this.apiToken, ...(options.headers || {}) };
    let res;
    try {
      res = await this.fetchImpl(url, { ...options, headers });
    } catch (error) {
      throw new GeneratorError(`Replicate unreachable: ${error.message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GeneratorError(`Replicate HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status, body: text });
    }
    return res.json();
  }

  async render(designCode, selfieBuffer, sceneBuffer) {
    const input = {
      [this.inputKeys.source]: this._dataUri(selfieBuffer),
      [this.inputKeys.target]: this._dataUri(sceneBuffer),
    };
    const created = await this._fetchJson(
      `https://api.replicate.com/v1/models/${this.model}/predictions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) },
    );
    let prediction = created;
    const deadline = Date.now() + this.timeoutMs;
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      prediction = await this._fetchJson(`https://api.replicate.com/v1/predictions/${prediction.id}`);
    }
    if (prediction.status === 'failed') {
      throw new GeneratorError('Replicate prediction failed: ' + (prediction.error || 'unknown'));
    }
    if (prediction.status !== 'succeeded') {
      throw new GeneratorError('Replicate prediction timeout');
    }
    const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!url) throw new GeneratorError('Replicate returned no output image');
    const imgRes = await this.fetchImpl(url);
    if (!imgRes.ok) throw new GeneratorError(`Replicate output download HTTP ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return {
      buffer,
      mimeType: 'image/jpeg',
      meta: { generator: this.name, model: this.model, prediction: prediction.id },
    };
  }
}
