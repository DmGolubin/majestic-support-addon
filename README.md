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
| `reference/bd-0.5.1/` | исходный BD-плагин 0.5.1 |
| `reference/vencord-spike/` | первый прототип под Vencord |
| `reference/VKMaj.js` | VK-скрипт поиска шаблонов (источник синонимов) |
| `assets/` | иконки проектов |

## Ветки

- `main` — спек и план.
- `stage1` — выполнение плана: задачи 1–5 (ядро) готовы и прошли ревью.
- `wip/task-6-partial` — недоделанная задача 6 (каркас Vencord), сессия прервалась; не ревьюилась.

## Разработка

```bash
pnpm install
pnpm test        # ядро
pnpm typecheck
```
