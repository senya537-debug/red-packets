import { Telegraf } from 'telegraf';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { buildBot } from './factory.mjs';

const config = loadConfig();
const { core } = buildBot(config);
await core.init();

function sendText(ctx, text) {
  if (!text) return;
  if (text.length > 4000) {
    return ctx.reply(text.slice(0, 4000) + '\n…(сообщение усечено)');
  }
  return ctx.reply(text);
}

async function getPhotoBuffer(ctx) {
  const photo = ctx.message?.photo;
  if (!photo || !photo.length) return null;
  const size = photo[photo.length - 1];
  const file = await ctx.telegram.getFile(size.file_id);
  const downloaded = await ctx.telegram.downloadFile(file);
  const buffer = typeof downloaded === 'string' ? readFileSync(downloaded) : downloaded;
  return {
    buffer,
    filename: `${size.file_id}.jpg`,
    mimeType: 'image/jpeg',
    width: size.width,
    height: size.height,
  };
}

async function handleUpdate(ctx) {
  const userId = ctx.message?.from?.id ?? ctx.update.message?.from?.id;
  if (!userId) return;

  if (ctx.message?.photo) {
    const photo = await getPhotoBuffer(ctx);
    if (!photo) return;
    const result = await core.handlePhoto(userId, photo.buffer, photo);
    if (!result.ok) {
      sendText(ctx, result.message || 'Ошибка обработки фото.');
      return;
    }
    if (result.type === 'result') {
      await ctx.replyWithPhoto({ source: result.result.buffer });
      if (result.meta?.note) sendText(ctx, `Примечание: ${result.meta.note}`);
      sendText(ctx, result.message);
      return;
    }
    sendText(ctx, result.message);
    return;
  }

  if (ctx.message?.text) {
    const result = await core.handleText(userId, ctx.message.text);
    if (!result.ok && result.error === 'unknown_command') {
      sendText(ctx, result.message);
      return;
    }
    if (result.type === 'template') {
      sendText(ctx, JSON.stringify(result.designCode, null, 2));
      return;
    }
    sendText(ctx, result.message);
    return;
  }

  sendText(ctx, 'Пришлите фото (или /help для справки).');
}

if (!config.telegramToken) {
  console.error('[starme] TELEGRAM_BOT_TOKEN is not set. Set it or run with STARME_DRY_RUN=1 for a local demo.');
  console.error('[starme] Start a bot with @BotFather, copy the token, and set TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

const bot = new Telegraf(config.telegramToken);
bot.on('message', handleUpdate);

console.log(`[starme] generator=${config.generator} analyzer=${config.analyzer} dataDir=${config.dataDir}`);
console.log('[starme] Started. Press Ctrl+C to stop.');

bot.startPolling({ drop_pending_updates: false });
bot.catch((error) => {
  console.error('[starme] Telegraf error:', error);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[starme] ${signal} received, stopping…`);
    bot.stop('SIGINT');
    process.exit(0);
  });
}
