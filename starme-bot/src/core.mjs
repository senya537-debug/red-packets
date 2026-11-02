// Framework-agnostic StarMe AI state machine.
// Two-stage flow per user:
//   1. celebrity photo  -> analyze scene -> design code (+ stored scene reference)
//   2. client selfie    -> render design code + selfie + scene ref -> result
// The design code persists so the client can send more selfies with the same scene.

import { validateDesignCode, normalizeDesignCode } from './scene.mjs';
import { GeneratorError } from './generator.mjs';

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // Telegram photo cap

export class BotCore {
  constructor({ store, generator, analyzer, config = {}, selfieGuard = null }) {
    this.store = store;
    this.generator = generator;
    this.analyzer = analyzer;
    this.config = config;
    this.selfieGuard = selfieGuard;
  }

  async init() {
    await this.store.init();
  }

  async handlePhoto(userId, imageBuffer, meta = {}) {
    const uid = String(userId);
    if (!imageBuffer || imageBuffer.length === 0) {
      return { ok: false, error: 'empty_photo', message: 'Фото пусто. Пришлите картинку.' };
    }
    if (imageBuffer.length > MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: 'too_large', message: 'Фото слишком большое.' };
    }
    const session = this.store.getSession(uid);
    const now = new Date().toISOString();

    // --- Stage 1: celebrity / scene photo -------------------------------------
    if (!session || session.stage === 'idle') {
      const sceneRef = await this.store.saveImage('scene', uid, imageBuffer, meta);
      let designCode;
      try {
        designCode = await this.analyzer.analyze(imageBuffer, { ...meta, path: sceneRef.path });
      } catch (error) {
        this.store.deleteImage(sceneRef.path);
        return {
          ok: false, error: 'analyzer_failed',
          message: `Не удалось разобрать сцену: ${error.message}`,
        };
      }
      const valid = validateDesignCode(designCode);
      if (!valid.ok) {
        this.store.deleteImage(sceneRef.path);
        return { ok: false, error: 'bad_design_code', message: 'Некорректный дизайн-код сцены.' };
      }
      const next = {
        userId: uid,
        stage: 'await_selfie',
        designCode: normalizeDesignCode(designCode),
        sceneRef,
        selfie: null,
        result: null,
        reuseCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.store.saveSession(next);
      return {
        ok: true,
        type: 'scene_accepted',
        session: next,
        message: 'Сцена разобрана и преобразована в дизайн-код. Пришлите ваше селфи, чтобы получить персональную версию.',
      };
    }

    // --- Stage 2: client selfie ------------------------------------------------
    if (session.stage === 'await_selfie') {
      const selfie = await this.store.saveImage('selfie', uid, imageBuffer, meta);
      if (this.selfieGuard) {
        try {
          await this.selfieGuard(selfie.buffer, { ...meta, session });
        } catch (error) {
          this.store.deleteImage(selfie.path);
          return { ok: false, error: 'selfie_rejected', message: error.message };
        }
      }
      const sceneBuffer = this.store.loadImage(session.sceneRef.path);
      let rendered;
      try {
        rendered = await this.generator.render(
          session.designCode, selfie.buffer, sceneBuffer,
          { selfiePath: selfie.path, scenePath: session.sceneRef.path, filename: meta.filename },
        );
      } catch (error) {
        const msg = error instanceof GeneratorError ? error.message : error.message;
        return { ok: false, error: 'generator_failed', message: `Ошибка генерации: ${msg}` };
      }
      const result = await this.store.saveImage('result', uid, rendered.buffer, {
        mimeType: rendered.mimeType, filename: meta.filename,
      });
      const updated = {
        ...session,
        selfie,
        result,
        reuseCount: (session.reuseCount || 0) + 1,
        lastRenderedAt: now,
        updatedAt: now,
      };
      // Keep the design code for reuse; the next photo is another selfie.
      this.store.saveSession(updated);
      const reuse = this.config.maxSelfieReuse > 0
        ? ` (повторов: ${updated.reuseCount}/${this.config.maxSelfieReuse})`
        : '';
      return {
        ok: true,
        type: 'result',
        result: { ...result, buffer: rendered.buffer },
        session: updated,
        meta: rendered.meta,
        message: `Готово${reuse}. Можете отправить ещё селфи или /reset для новой сцены.`,
      };
    }

    return { ok: false, error: 'unknown_stage', message: 'Неожиданное состояние. Используйте /reset.' };
  }

  async handleText(userId, text) {
    const uid = String(userId);
    const command = (text || '').trim().split(/\s+/)[0].toLowerCase();
    const session = this.store.getSession(uid);

    if (command === '/start' || command === '/help') {
      return { ok: true, type: 'help', message: HELP_TEXT };
    }
    if (command === '/reset') {
      this.store.deleteSession(uid);
      return { ok: true, type: 'reset', message: 'Сессия сброшена. Пришлите фото знаменитости для новой сцены.' };
    }
    if (command === '/status') {
      if (!session || session.stage === 'idle') {
        return { ok: true, type: 'status', message: 'Сейчас нет активной сцены.' };
      }
      const stage = session.stage === 'await_selfie' ? 'ожидается селфи' : session.stage;
      return {
        ok: true, type: 'status',
        message: `Сцена активна, ${stage}. Режим: ${this.generator.name}, анализатор: ${this.analyzer.name}.`,
      };
    }
    if (command === '/template') {
      if (!session || !session.designCode) {
        return { ok: false, error: 'no_scene', message: 'Сначала пришлите фото знаменитости.' };
      }
      return { ok: true, type: 'template', designCode: session.designCode, message: session.designCode };
    }
    if (command === '/scene') {
      if (!session || !session.sceneRef) {
        return { ok: false, error: 'no_scene', message: 'Сначала пришлите фото знаменитости.' };
      }
      return { ok: true, type: 'scene_ref', sceneRef: session.sceneRef, message: 'Исходное фото сцены сохранено как референс.' };
    }
    return { ok: false, error: 'unknown_command', message: 'Команда не распознана. Используйте /help.' };
  }

  async reset(userId) {
    this.store.deleteSession(String(userId));
  }
}

export const HELP_TEXT = [
  'StarMe AI — персональные фото по шаблону сцены.',
  '',
  'Как работает:',
  '1. Пришлите фото знаменитости — я разберу сцену и создам дизайн-код.',
  '2. Пришлите ваше селфи — я придумаю персональную версию той же сцены.',
  '3. Можете отправить ещё селфи для той же сцены.',
  '',
  'Команды:',
  '/status — статус сессии',
  '/template — показать JSON дизайн-код',
  '/scene — показать сохранённый референс сцены',
  '/reset — начать новую сцену',
  '/help — справка',
].join('\n');
