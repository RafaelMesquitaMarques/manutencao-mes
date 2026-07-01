# KAIZO — instruções para o agente

Para arquitetura geral, módulos e modelo de dados, ver [CONTEXT.md](CONTEXT.md).

## Regra obrigatória: i18n por padrão (en / fr / es)

**Toda string de UI nova já nasce traduzida.** Nunca escreva texto voltado ao
usuário hardcoded em componentes. Isso vale para qualquer texto que o usuário
final lê: labels, botões, títulos, placeholders, `title=`/`aria-label`, opções de
`<select>`, mensagens de erro/sucesso/toast, textos de `confirm()`/`alert()`,
estados vazios ("No data") e descrições.

Fazer isto na criação evita o retrabalho de retrofit que já fizemos em várias
páginas.

### Como fazer

1. No componente, use `react-i18next`:
   ```tsx
   import { useTranslation } from 'react-i18next';
   const { t } = useTranslation();
   // ...
   <button>{t('namespace.minhaChave')}</button>
   ```
2. Adicione a chave **nos três** locales: `frontend/src/i18n/locales/en.json`,
   `fr.json` e `es.json`. Toda chave existe em en, fr **e** es — nunca só em um.
   `en` é o fallback (`frontend/src/i18n/index.ts`).
3. Agrupe por namespace (ex.: `users`, `workOrders`, `equipment`). Reutilize os
   namespaces compartilhados antes de criar chaves novas:
   - `common.*` — save, cancel, delete, edit, back, search, loading…
   - `roles.*` — papéis de usuário (use `t(\`roles.${role}\`)`, não mapas locais)
   - `status.*`, `priority.*`, `type.*`, `ticketStatus.*`, `alertStatus.*` — enums
4. Interpolação: `t('users.createdSuccess', { name })` com
   `"createdSuccess": "{{name}} created successfully"`.
5. Para trecho com markup no meio, quebre em prefixo/sufixo
   (ex.: `users.resettingForPrefix` + `<span>{name}</span>` + `users.resettingForSuffix`)
   ou use `<Trans>`.

### Não traduzir

Identificadores técnicos/code-style mostrados em monospace (ex.: chaves de
permissão como `work_orders`, códigos), nomes de marca/produto, e valores vindos
do banco. Em caso de dúvida, traduza.

### Antes de finalizar uma página/feature nova

- `grep` por texto hardcoded no que você criou e confirme que tudo passa por `t(...)`.
- Rode `cd frontend && npx tsc --noEmit` (deve passar limpo).
- Para ver no app, rebuild do container: `docker compose up -d --build frontend`
  (o frontend roda dentro do container, sem mount — edições no host não aparecem
  sem rebuild).

## Backend

Mensagens de erro retornadas em `detail` de respostas HTTP aparecem na UI. Quando
criar uma mensagem nova destinada ao usuário final, prefira um código/string
estável que o frontend possa mapear para `t(...)`, em vez de prosa só em inglês.
