# Три пакета и GitHub Releases

Единая версия, канал и репозиторий заданы в `distribution/config.json`.
Пакеты предназначены для Windows. Уже установленный Canary не меняется сборкой.

## Сборка

1. Зафиксировать изменения исходников коммитом.
2. Выполнить `node distribution/prepare-upstream.mjs`: создаётся отдельный checkout
   зафиксированного Vencord, зависимости устанавливаются указанной upstream версией
   pnpm с `--frozen-lockfile`. Установленный Vencord не изменяется.
3. Установить `VENCORD_DIR` в путь `checkout` из последней строки результата.
4. Выполнить проверки типов и `npm test -- --maxWorkers=4`.
5. Выполнить `node distribution/build-release.mjs`.
6. Выполнить `node distribution/publish-release.mjs --check`.

Комплект появляется в `artifacts/distribution/<version>/`. Повторная сборка не
перезаписывает существующий комплект: перенесите предыдущий комплект в архив.

## Публикация в будущем

Сейчас публикация не выполняется. Владелец планирует сделать
`skyjacc/support-templates` публичным. Сотрудникам не нужны GitHub-токены.

Команда `node distribution/publish-release.mjs` создаёт **черновик** выпуска
со всеми готовыми файлами; она требует авторизации GitHub CLI владельца.
Перед этим исходный коммит сборки должен быть отправлен в репозиторий: тег выпуска
привязывается именно к нему, а не к случайному последнему коммиту ветки.
После проверки опубликуйте этот черновик в GitHub. Для нового выпуска вместо
черновика можно явно вызвать команду с `--publish`; приватный репозиторий при
этом будет отклонён. Существующие выпуски команда не перезаписывает.

Также есть ручной GitHub Actions workflow `Build three Windows distributions`.
Он собирает и проверяет комплект, сохраняет его как Actions artifact и только
при включённом `create_draft` создаёт черновик. Автоматической публикации нет.

Для следующего обновления увеличьте версию в общем конфиге и standalone/config,
соберите все три варианта и опубликуйте новый выпуск `v<version>` вместе с
`support-templates-update.json`. Один push исходников обновление не выпускает.
Canary-выпуск должен быть отмечен prerelease. Обновлятор видит только опубликованные
выпуски своего канала и своего варианта; `/latest` не используется.

SHA-256 защищает от повреждения пакета; доверие издателю основано на HTTPS и правах
записи в указанный GitHub-репозиторий. Это не отдельная цифровая подпись.
Подробная схема и границы обновлятора: `updater/README.md`.

Документация платформ: [Vencord custom plugins](https://docs.vencord.dev/installing/custom-plugins/),
[BetterDiscord plugins](https://docs.betterdiscord.app/plugins/introduction/quick-start),
[GitHub Releases API](https://docs.github.com/en/rest/releases/releases).
