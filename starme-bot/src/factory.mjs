import { Store } from './store.mjs';
import { BotCore } from './core.mjs';
import {
  MockGenerator, FaceFusionGenerator, InstantIdGenerator, ReplicateGenerator, createFaceGuard,
} from './generator.mjs';
import { createHeuristicAnalyzer, createVlmAnalyzer, buildPrompt, buildNegativePrompt } from './scene.mjs';

export function buildAnalyzer(config) {
  if (config.analyzer === 'vlm') {
    if (!config.vlm.baseUrl || !config.vlm.model) {
      console.warn('[starme] STARME_ANALYZER=vlm but VLM_BASE_URL/VLM_MODEL missing — falling back to heuristic');
      return createHeuristicAnalyzer();
    }
    return createVlmAnalyzer({
      baseUrl: config.vlm.baseUrl,
      apiKey: config.vlm.apiKey,
      model: config.vlm.model,
    });
  }
  return createHeuristicAnalyzer();
}

export function buildGenerator(config) {
  switch (config.generator) {
    case 'facefusion':
      return new FaceFusionGenerator({ workerUrl: config.worker.facefusion });
    case 'instantid':
      return new InstantIdGenerator({
        workerUrl: config.worker.instantid,
        buildPrompt,
        buildNegativePrompt,
      });
    case 'replicate':
      return new ReplicateGenerator({
        apiToken: config.replicate.apiToken,
        model: config.replicate.model,
        inputKeys: config.replicate.inputKeys,
      });
    case 'mock':
    default:
      return new MockGenerator();
  }
}

export function buildBot(config) {
  const store = new Store(config.dataDir);
  const analyzer = buildAnalyzer(config);
  const generator = buildGenerator(config);

  let selfieGuard = null;
  if (config.selfieGuard === 'face') {
    const workerUrl = generator.name === 'instantid' ? config.worker.instantid : config.worker.facefusion;
    selfieGuard = createFaceGuard({ workerUrl });
  }

  const core = new BotCore({ store, generator, analyzer, config, selfieGuard });
  return { config, store, analyzer, generator, core, selfieGuard };
}

export { buildPrompt, buildNegativePrompt };
