import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Minimal .env loader (no dependency). Real env vars always win.
function loadDotEnv(file = '.env') {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}
loadDotEnv();

function parseInputKeys(value) {
  const defaults = { source: 'source_image', target: 'target_image' };
  if (!value) return defaults;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return { source: parsed.source || defaults.source, target: parsed.target || defaults.target };
    }
  } catch {
    // fall through to defaults
  }
  return defaults;
}

export function loadConfig(env = process.env) {
  return {
    telegramToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
    dataDir: env.STARME_DATA_DIR || './data',
    generator: (env.STARME_GENERATOR || 'mock').trim(),
    analyzer: (env.STARME_ANALYZER || 'heuristic').trim(),
    // none | face — face guard rejects selfies where no face is detected
    selfieGuard: (env.STARME_SELFIE_GUARD || 'none').trim(),
    dryRun: env.STARME_DRY_RUN === '1' || env.STARME_DRY_RUN === 'true',
    maxSelfieReuse: Number(env.STARME_MAX_SELFIE_REUSE || 0),
    worker: {
      facefusion: (env.FACEFUSION_WORKER_URL || 'http://127.0.0.1:8100').replace(/\/$/, ''),
      instantid: (env.INSTANTID_WORKER_URL || 'http://127.0.0.1:8101').replace(/\/$/, ''),
    },
    vlm: {
      baseUrl: (env.VLM_BASE_URL || '').replace(/\/$/, ''),
      apiKey: env.VLM_API_KEY || '',
      model: env.VLM_MODEL || '',
    },
    replicate: {
      apiToken: env.REPLICATE_API_TOKEN || '',
      model: env.REPLICATE_MODEL || 'pikachupichu25/image-faceswap',
      inputKeys: parseInputKeys(env.REPLICATE_INPUT_KEYS),
    },
    id: randomUUID(),
  };
}
