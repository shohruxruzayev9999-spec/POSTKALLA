# Retarget ERP v2 — working notes

Telegram Mini App ERP for marketing agencies (multi-tenant SaaS). Language of UI: Uzbek (ru/en planned).

## Layout
- `packages/shared` — pure business rules, no I/O: RBAC matrix + hard rules (`permissions.ts`), task state machine (`tasks.ts`), working-time math in company TZ (`worktime.ts`), motivation score (`motivation.ts`), KPI (`kpi.ts`), reminder/escalation plan (`reminders.ts`).
- `apps/api` — Fastify + Drizzle (Postgres) + grammY bot. `services/*` hold all domain logic; `http/server.ts` and `bot/bot.ts` are thin transports. Reminder worker: `jobs/reminders.ts` (every minute, idempotent via `reminder_log`).
- `apps/web` — React 19 + Vite Mini App. Design: "H" set (dark green-gradient) + light theme. Tokens in `src/styles.css`.
- `deploy/` — docker-compose (Postgres, API, Caddy with auto-HTTPS serving the web build), nightly backups.

## Rules that must never regress (covered by tests)
- Roles/salary/attendance/KPI rating: nobody edits their own; nobody grants or touches a rank ≥ their own; ≥1 Owner always.
- Tenant isolation: every query filters by `company_id`; actor is loaded from DB per request (never from the token).
- Nobody approves their own task. Deadline moves need a manager + reason; motivation uses `original_deadline`.
- Reminders count working hours only; one live reminder per chat (previous is deleted); 3rd → dept head, then CEO.

## Commands
- `npm test` (all workspaces; API tests use in-memory PGlite), `npm run typecheck`.
- Local run without Telegram: `BOT_TOKEN=dev JWT_SECRET=<32+ chars> DATABASE_URL=pglite:./.pgdev DEV_LOGIN=1 npx tsx apps/api/src/main.ts`, then `npm run dev -w @retarget/web` and open `http://localhost:5173/?dev=1`.
- New migration: edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w @retarget/api`.

## Deploy
Push to `main` → GitHub Actions tests, builds the web app and ships to the VM (`deploy` job runs when repo variable `DEPLOY_ENABLED=true`). Secrets: `SSH_KEY`, `SSH_HOST`, `SSH_USER`; variable `BOT_USERNAME`. Server keeps `deploy/.env` (see `.env.example`).

## Progress
- [x] Shared rules + tests
- [x] API core, auth, bot, reminder worker + DB/HTTP tests
- [x] Mini App: home, tasks (list/kanban/detail/create), projects, team (invite/edit/rate), profile, settings
- [x] Docker/Caddy/CI
- [ ] Deploy to GCP e2-micro (needs VM + BotFather token)
- [ ] Finance module, content plan / shooting calendar, ru/en translations, monthly KPI close
