#!/usr/bin/env node
// System check for StarMe AI bot — tells a non-technical user whether the
// computer is good enough to run the bot (Replicate mode: no GPU needed).
import { availableParallelism, totalmem, freemem } from 'node:os';
import { statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

function line(ok, label, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${detail}`);
}
function info(label, detail) {
  console.log(`  ℹ️  ${label}: ${detail}`);
}

const problems = [];

console.log('Проверка компьютера для StarMe AI bot\n');

// 1. Node.js version
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) {
  line(true, 'Node.js', process.versions.node + ' (нужно 20+)');
} else {
  line(false, 'Node.js', process.versions.node + ' — нужна версия 20+ ([скачать](https://nodejs.org))');
  problems.push('Node.js');
}

// 2. CPU cores
const cores = availableParallelism();
if (cores >= 2) {
  line(true, 'CPU', cores + ' ядер (хватит)');
} else {
  line(true, 'CPU', cores + ' ядер (работать будет, но медленнее)');
}

// 3. RAM
const total = gb(totalmem());
const free = gb(freemem());
if (total >= 2) {
  line(true, 'RAM', `${total} ГБ всего, ${free} ГБ свободно (нужно 2+ ГБ)`);
} else {
  line(false, 'RAM', `${total} ГБ всего — мало, нужно 2+ ГБ`);
  problems.push('RAM');
}

// 4. Disk
try {
  const st = statfsSync(root);
  const diskFree = gb(st.bsize * st.bavail);
  if (diskFree >= 1) {
    line(true, 'Disk', `${diskFree} ГБ свободно (нужно ~1 ГБ)`);
  } else {
    line(false, 'Disk', `${diskFree} ГБ свободно — мало`);
    problems.push('Disk');
  }
} catch (error) {
  info('Disk', 'не удалось определить (проверьте вручную ~1 ГБ свободно)');
}

// 5. Internet — Telegram and Replicate must be reachable
async function reachable(url) {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000), redirect: 'manual' });
    return res.status < 500;
  } catch {
    return false;
  }
}
console.log('  ⏳ Проверка сети (Telegram, Replicate)…');
const [tg, rep] = await Promise.all([
  reachable('https://api.telegram.org/'),
  reachable('https://api.replicate.com/v1/models'),
]);
line(tg, 'api.telegram.org', tg ? 'достижим' : 'НЕ достижим (нужен для бота)');
if (!tg) problems.push('Telegram API');
line(rep, 'api.replicate.com', rep ? 'достижим' : 'НЕ достижим (нужен для генерации)');
if (!rep) problems.push('Replicate API');

console.log('');
if (problems.length === 0) {
  console.log('✅ Компьютер подходит. Загружайте bot: npm install && npm start');
} else {
  console.log('❌ Есть проблемы: ' + problems.join(', '));
  console.log('   Исправьте их и запустите снова: node scripts/check.mjs');
}
