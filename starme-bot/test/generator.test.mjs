import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  FaceFusionGenerator, InstantIdGenerator, ReplicateGenerator, createFaceGuard, GeneratorError,
} from '../src/generator.mjs';
import { buildPrompt, buildNegativePrompt, emptyDesignCode } from '../src/scene.mjs';

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(req, onReady) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => onReady(body));
}

test('FaceFusionGenerator posts base64 and returns decoded image', async () => {
  await withServer((req, res) => {
    readBody(req, (body) => {
      const payload = JSON.parse(body);
      assert.equal(payload.mode, 'swap');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        image: Buffer.from('hello').toString('base64'),
        mime: 'image/jpeg',
        generator: 'test',
      }));
    });
  }, async (url) => {
    const gen = new FaceFusionGenerator({ workerUrl: url });
    const out = await gen.render(emptyDesignCode(), Buffer.from('selfie'), Buffer.from('scene'));
    assert.equal(out.buffer.toString(), 'hello');
    assert.equal(out.mimeType, 'image/jpeg');
  });
});

test('InstantIdGenerator sends the design-code prompt and both images', async () => {
  let received;
  await withServer((req, res) => {
    readBody(req, (body) => {
      received = JSON.parse(body);
      res.end(JSON.stringify({ image: 'aGk=', mime: 'image/png' }));
    });
  }, async (url) => {
    const gen = new InstantIdGenerator({ workerUrl: url, buildPrompt, buildNegativePrompt });
    const code = emptyDesignCode();
    code.scene.composition = 'cinematic portrait';
    await gen.render(code, Buffer.from('selfie'), Buffer.from('scene'));
    assert.equal(received.mode, 'instantid');
    assert.match(received.prompt, /cinematic portrait/);
    assert.ok(received.identity_image, 'identity image is base64');
    assert.ok(received.scene_image, 'scene image is base64');
    assert.equal(received.params.steps, 30);
  });
});

test('generator surfaces worker errors as GeneratorError', async () => {
  await withServer((req, res) => {
    res.statusCode = 500;
    res.end('boom');
  }, async (url) => {
    const gen = new FaceFusionGenerator({ workerUrl: url });
    await assert.rejects(
      () => gen.render(emptyDesignCode(), Buffer.from('s'), Buffer.from('c')),
      GeneratorError,
    );
  });
});

test('generator reports an unreachable worker', async () => {
  const gen = new FaceFusionGenerator({ workerUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => gen.render(emptyDesignCode(), Buffer.from('s'), Buffer.from('c')),
    /unreachable/,
  );
});

test('createFaceGuard rejects when no face is detected', async () => {
  await withServer((req, res) => {
    res.end(JSON.stringify({ faces: 0, has_face: false }));
  }, async (url) => {
    const guard = createFaceGuard({ workerUrl: url });
    await assert.rejects(() => guard(Buffer.from('x')), /не найдено лица/);
  });
});

test('createFaceGuard passes when a face is detected', async () => {
  await withServer((req, res) => {
    res.end(JSON.stringify({ faces: 1, has_face: true }));
  }, async (url) => {
    const guard = createFaceGuard({ workerUrl: url });
    const info = await guard(Buffer.from('x'));
    assert.equal(info.has_face, true);
    assert.equal(info.faces, 1);
  });
});

test('ReplicateGenerator maps inputs, polls and downloads the result', async () => {
  let pollCount = 0;
  let postedInput;
  const gen = new ReplicateGenerator({
    apiToken: 'tok',
    pollMs: 5,
    fetchImpl: async (url, options = {}) => {
      const u = String(url);
      if (u.includes('/models/') && u.endsWith('/predictions') && options.method === 'POST') {
        postedInput = JSON.parse(options.body).input;
        return new Response(JSON.stringify({ id: 'pred-1', status: 'processing' }), { status: 201 });
      }
      if (u.endsWith('/predictions/pred-1')) {
        pollCount++;
        const status = pollCount < 2 ? 'processing' : 'succeeded';
        const body = status === 'succeeded'
          ? { id: 'pred-1', status, output: 'https://example.com/out.jpg' }
          : { id: 'pred-1', status };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (u.startsWith('https://example.com/out.jpg')) {
        return new Response(Buffer.from('imgdata'), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });
  const out = await gen.render(emptyDesignCode(), Buffer.from('selfie'), Buffer.from('scene'));
  assert.equal(out.buffer.toString(), 'imgdata');
  assert.equal(out.meta.model, 'pikachupichu25/image-faceswap');
  // selfie maps to the source key, scene to the target key
  assert.match(postedInput.source_image, /^data:image\/jpeg;base64,/);
  assert.match(postedInput.target_image, /^data:image\/jpeg;base64,/);
});

test('ReplicateGenerator surfaces auth and failure errors', async () => {
  const gen = new ReplicateGenerator({
    apiToken: 'tok',
    pollMs: 5,
    fetchImpl: async () => new Response('{"detail":"bad token"}', { status: 401 }),
  });
  await assert.rejects(() => gen.render(emptyDesignCode(), Buffer.from('s'), Buffer.from('c')), /HTTP 401/);
});

test('ReplicateGenerator reports a failed prediction', async () => {
  const gen = new ReplicateGenerator({
    apiToken: 'tok',
    pollMs: 5,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/predictions') || u.endsWith('/predictions/pred-2')) {
        return new Response(JSON.stringify({ id: 'pred-2', status: 'failed', error: 'no face' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });
  await assert.rejects(() => gen.render(emptyDesignCode(), Buffer.from('s'), Buffer.from('c')), /failed/);
});
