# Обновление зависимостей тестирования — 15 октября 2026

## Изменения

Vitest 3.2.7 → 4.1.12, точная версия в package.json и обновлённый pnpm-lock.yaml. Выбрана исправленная ветка 4 без дополнительного перехода на 5 перед собранием. Код плагина и тестовые ожидания не менялись; подавлений audit и overrides нет.

Исходный audit: 2 moderate (vitest/@vitest/mocker), 2 critical (tinypool). После обновления `pnpm audit`: No known vulnerabilities found, код выхода 0. JSON: 2026-10-15-audit-after-update.json. Tinypool отсутствует в разрешённом дереве (`pnpm why tinypool` пуст).

## Проверки

- Node 24.12.0, pnpm 9.15.9.
- `pnpm install --frozen-lockfile`: успешно, lockfile актуален.
- `pnpm test`: 17 файлов, 123 теста прошли.
- `pnpm typecheck`: успешно.
- Полный `pnpm exec tsc --noEmit` в Vencord: успешно.
- `pnpm build` в Vencord: успешно.
- Браузерный стенд личной библиотеки: создание/редактирование, цвета, папки, команда, сохранение, dirty-guards, 400 px; ошибок JS нет.

Проверяется дерево зависимостей репозитория support-templates, не весь Discord/Vencord. Отдельное предупреждение Node DEP0169 (url.parse внутри инструментария pnpm) остаётся: это не запись pnpm audit. Глобальный pnpm не обновлялся. Живая приёмка новых экранов Discord не заменяется этими проверками.

Источники для выбора миграции: npm registry (версии и engines), https://vitest.dev/guide/migration/ и https://v4.vitest.dev/guide/migration.html. Advisory IDs исходного audit: GHSA-82fw-gwwq-j7x9, GHSA-85c8-ppgw-ccpr и остальные записи сохранённого предыдущего отчёта.
