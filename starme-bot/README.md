# StarMe AI — Telegram bot

Персональные фото по шаблону сцены. Не просто face swap, а двухэтапный пайплайн:

1. Клиент присылает фото знаменитости → bot разбирает сцену и создаёт **JSON-дизайн-код**.
2. Клиент присылает селфи → bot применяет дизайн-код + селфи + референс сцены и отдаёт персональную версию.

Дизайн-код отделяет **описание сцены** от **личности человека**, поэтому клиенту не нужно писать промпт.

```
фото знаменитости ─▶ анализ сцены ─▶ JSON-дизайн-код ─▶ (хранится)
                                                              │
селфи клиента ─────────────────────────────────────────────▶ рендер ─▶ готовое фото
```

## Быстрый старт (без генератора)

Работает полностью локально, без Telegram и без нейросети — проверяет пайплайн end-to-end.

```bash
cd starme-bot
npm install
npm run demo        # включает детектирование лица
npm test            # 18 тестов
```

## Запуск бота

1. Создайте бота у [@BotFather](https://t.me/BotFather), скопируйте токен.
2. Скопируйте `.env.example` в `.env` и укажите `TELEGRAM_BOT_TOKEN`.
3. Запустите:

```bash
npm start
```

## Включение реальной генерации

Генератор — plug-in. По умолчанию `mock` (плейсхолдер). Варианты:

### Replicate — проще всего (без GPU, без сервера моделей)

Облачный face swap. При регистрации дают ~$10 бесплатных кредитов, одна фотография ≈ $0.0016. Нужен только ключ API — генерация идёт на стороне сервиса.

```bash
# в .env:
STARME_GENERATOR=replicate
REPLICATE_API_TOKEN=r8....
```

1. Зарегистрируйтесь на [replicate.com](https://replicate.com), создайте токен в аккаунте.
2. Скопируйте токен в `REPLICATE_API_TOKEN`.

### FaceFusion — бесплатно, но нужен GPU

Прямой face swap: лицо клиента кладётся на фото сцены, сохраняя позу, одежду, фон и свет. Проще и вернее оригинала, но дизайн-код не «ведёт» генерацию (он хранится для переиспользования).

```bash
pip install facefusion
python3 worker/facefusion_worker.py          # :8100
# в .env:
STARME_GENERATOR=facefusion
```

### InstantID — дизайн-код ведёт генерацию

SDXL + ArcFace + IdentityNet: промпт из дизайн-кода, селфи — как личность, фото знаменитости — как поза. Генерирует новую сцену. Требует GPU.

```bash
pip install torch diffusers transformers accelerate insightface opencv-python
# скачайте antelopev2 + веса InstantID (см. README InstantID)
python3 worker/instantid_worker.py           # :8101
# в .env:
STARME_GENERATOR=instantid
```

### Анализатор сцены

- `heuristic` (default) — offline, плейсхолдер (не «видит» содержание).
- `vlm` — любой OpenAI-compatible vision endpoint (OpenAI, Groq, Together, Ollama, LM Studio, vLLM):

```bash
# в .env:
STARME_ANALYZER=vlm
VLM_BASE_URL=https://api.openai.com/v1
VLM_API_KEY=...
VLM_MODEL=gpt-4o-mini
```

## Команды бота

| Команды | Что делает |
|---|---|
| `/start`, `/help` | Справка |
| `/status` | Статус сессии |
| `/template` | Показать JSON дизайн-код |
| `/scene` | Показать сохранённый референс сцены |
| `/reset` | Новая сцена |

После первого результата дизайн-код сохраняется: можно отправить ещё селфи для той же сцены.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Токен бота |
| `STARME_DATA_DIR` | `./data` | Папка хранения |
| `STARME_GENERATOR` | `mock` | `mock` / `replicate` / `facefusion` / `instantid` |
| `STARME_ANALYZER` | `heuristic` | `heuristic` / `vlm` |
| `STARME_SELFIE_GUARD` | `none` | `none` / `face` — отклонять селфи без лица |
| `REPLICATE_API_TOKEN` | — | Ключ API Replicate (бесплатные кредиты при регистрации) |
| `REPLICATE_MODEL` | `pikachupichu25/image-faceswap` | Модель face swap на Replicate |
| `FACEFUSION_WORKER_URL` | `http://127.0.0.1:8100` | Адрес воркера |
| `INSTANTID_WORKER_URL` | `http://127.0.0.1:8101` | Адрес воркера |
| `VLM_BASE_URL`, `VLM_API_KEY`, `VLM_MODEL` | — | Vision-модель для анализа сцены |

## Защита от злоупотреблений

- Селфи принимается только на втором этапе, после создания шаблона.
- `STARME_SELFIE_GUARD=face` отклоняет селфи без детектируемого лица (воркер `/analyze`).
- Хранится исходник сцены как референс, но доступ к нему ограничен (`/scene`).
- Оригиналы можно очищать по расписанию (см. `ARCHITECTURE.md`).

## Структура

```
starme-bot/
├── src/
│   ├── bot.mjs          # Telegram (Telegraf)
│   ├── core.mjs         # машина состояний (двухэтапный пайплайн)
│   ├── scene.mjs        # схема дизайн-кода, валидация, промпт, анализаторы
│   ├── generator.mjs    # генератор + адаптеры + guard
│   ├── store.mjs        # хранилище (JSON)
│   └── factory.mjs      # сборка по конфигу
├── worker/
│   ├── facefusion_worker.py
│   └── instantid_worker.py
├── scripts/             # demo + PNG-енкодер
├── test/                # 18 тестов
└── ARCHITECTURE.md
```

Смотрите `ARCHITECTURE.md` для детального описания архитектуры и выбора генератора.
