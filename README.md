# SupportTemplates

Шаблоны ответов поддержки Majestic RP и Россия Онлайн в Discord — Vencord и BetterDiscord, в стиле
панели Majestic, с защитой от шаблона чужого проекта и (позже) входом через аккаунт панели.

## Где что

| Путь | Что |
|---|---|
| `docs/IDEAS.md` | сводка идей, решений, багов 0.5.1 и открытых вопросов |
| `docs/superpowers/specs/` | спек (согласованный дизайн) |
| `docs/superpowers/plans/` | план этапа 1 (ядро + Vencord) |
| `TODO.md` | защита своих тикетов от чужого `/tt` |
| `docs/history/chat.md` | полная история обсуждения (секреты вырезаны) |
| `docs/history/sdd-ledger.md` | журнал выполнения плана: задачи, ревью, решения |
| `docs/mockups/` | HTML-макеты (стиль, компоновки, итоговый концепт) |
| `docs/screens/` | PNG-макеты для показа |
| `src/core/` | ядро (TypeScript, Vitest) — задачи 1–5 готовы |
| `src/vencord/` | Vencord-плагин (обёртка над ядром): окно, `;команда`, диалоги, сборка ответа |
| `reference/bd-0.5.1/` | исходный BD-плагин 0.5.1 |
| `reference/vencord-spike/` | первый прототип под Vencord |
| `reference/ticket-sound/` | скрипт звука нового тикета (основа подпроекта B) |
| `reference/VKMaj.js` | VK-скрипт поиска шаблонов (источник синонимов) |
| `assets/` | иконки проектов |

## Серверы

Плагин работает только на трёх серверах (таблица в `src/core/guard.ts`, `serverMode`):

| Сервер | id | Режим |
|---|---|---|
| Majestic RP | `530693013622489088` | `mj` — шаблоны Majestic и общие; чужой проект — парный шаблон или предупреждение |
| Россия Онлайн | `1089530150540034181` | `ro` — то же для РО |
| Tech™ (сервер саппортов) | `1395915167040016545` | `all` — переключатель «Majestic / Россия Онлайн» в окне (запоминается): список, Alt+1…9, бинды и подсказки `;` — выбранного проекта и общие; без предупреждений о чужом проекте |

На остальных серверах и в ЛС (`off`) плагин невидим: кнопки нет, Ctrl+Alt+T, Alt+1…9, бинды и `;команда`
не перехватываются — клавиши уходят в Discord. Режим отладки работает везде и показывает режим сервера.

## Ветки

- `main` — спек и план.
- `stage1` — этап 1: ядро + Vencord-версия (задачи 1–10 готовы и прошли ревью; ждёт ручной проверки в Discord).
- `wip/task-6-partial` — недоделанная задача 6 (каркас Vencord), сессия прервалась; не ревьюилась.

## Разработка

```bash
pnpm install
pnpm test            # ядро (Vitest)
pnpm typecheck
pnpm icons           # перегенерировать src/vencord/ui/icons.ts из assets/
pnpm sync:vencord    # скопировать плагин в C:/Users/oblako/dev/Vencord/src/userplugins/supportTemplates
cd C:/Users/oblako/dev/Vencord && pnpm build   # затем Ctrl+R в Discord
```

`VENCORD_DIR` переопределяет путь к Vencord. Vencord должен быть установлен из исходников (`pnpm inject`).

## Шрифты

Окно использует шрифты панели: Golos Text и JetBrains Mono (SIL Open Font License 1.1, тексты лицензий — `assets/fonts/OFL-*.txt`). Они встроены в плагин (`pnpm fonts` → `src/vencord/ui/fontData.ts`) и подгружаются из памяти под именами «STX Golos» / «STX Mono»: без сетевых запросов, шрифты самого Discord не меняются.
