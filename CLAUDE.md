# KAIZO — agent instructions

For the overall architecture, modules and data model, see [CONTEXT.md](CONTEXT.md).

## Mandatory rule: everything in the repository is written in English

Whatever language the chat is in, everything that goes into the repository is
English: documentation (README, CONTEXT.md, `docs/`), these instructions, code
comments and docstrings, test names, config-file comments, script output, and
commit messages / PR descriptions.

Product UI text is the only multilingual content, and it goes through i18n
(next section). Technical identifiers that already exist stay as they are even
when they are Portuguese — e.g. the MQTT topic `usinas/{plant_id}/captores/{sensor_code}/leitura`
and its `valor` key (device firmware depends on them), or the database name
`manutencao` and the Compose project name `manutencao-mes` (the data volumes
depend on them).

## Mandatory rule: i18n by default (en / fr / es)

**Every new UI string is born translated.** Never hardcode user-facing text in
components. This applies to any text the end user reads: labels, buttons,
titles, placeholders, `title=`/`aria-label`, `<select>` options,
error/success/toast messages, `confirm()`/`alert()` texts, empty states
("No data") and descriptions.

Doing this at creation time avoids the retrofit rework we have already done on
several pages.

### How to do it

1. In the component, use `react-i18next`:
   ```tsx
   import { useTranslation } from 'react-i18next';
   const { t } = useTranslation();
   // ...
   <button>{t('namespace.myKey')}</button>
   ```
2. Add the key to **all three** locales: `frontend/src/i18n/locales/en.json`,
   `fr.json` and `es.json`. Every key exists in en, fr **and** es — never in just
   one. `en` is the fallback (`frontend/src/i18n/index.ts`).
3. Group keys by namespace (e.g. `users`, `workOrders`, `equipment`). Reuse the
   shared namespaces before creating new keys:
   - `common.*` — save, cancel, delete, edit, back, search, loading…
   - `roles.*` — user roles (use `t(\`roles.${role}\`)`, not local maps)
   - `status.*`, `priority.*`, `type.*`, `ticketStatus.*`, `alertStatus.*` — enums
4. Interpolation: `t('users.createdSuccess', { name })` with
   `"createdSuccess": "{{name}} created successfully"`.
5. For text with markup in the middle, split it into prefix/suffix
   (e.g. `users.resettingForPrefix` + `<span>{name}</span>` + `users.resettingForSuffix`)
   or use `<Trans>`.

### Do not translate

Technical/code-style identifiers shown in monospace (e.g. permission keys such
as `work_orders`, codes), brand/product names, and values coming from the
database. When in doubt, translate.

### Before finishing a new page/feature

- `grep` for hardcoded text in what you created and confirm everything goes
  through `t(...)`.
- Run `cd frontend && npx tsc --noEmit` (must pass clean).
- To see it in the app: the frontend hot-reloads — `docker-compose.override.yml`
  bind-mounts `./frontend` into the container, so source edits show up without
  a rebuild. Rebuild (`docker compose up -d --build frontend`) only when the
  dependencies change. The backend has **no** mount: backend edits need
  `docker compose up -d --build backend`.

## Backend

Error messages returned in the `detail` of HTTP responses show up in the UI.
When you create a new message meant for the end user, prefer a stable
code/string that the frontend can map to `t(...)` instead of English-only prose.
