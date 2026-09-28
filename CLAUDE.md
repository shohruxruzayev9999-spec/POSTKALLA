# Retarget ERP v2 — working notes

Telegram Mini App ERP for marketing agencies (multi-tenant SaaS). Language of UI: Uzbek (ru/en planned).

## Layout
- `packages/shared` — pure business rules, no I/O: RBAC matrix + hard rules (`permissions.ts`), task state machine (`tasks.ts`), working-time math in company TZ (`worktime.ts`), motivation score (`motivation.ts`), KPI (`kpi.ts`), reminder/escalation plan (`reminders.ts`).
- `apps/api` — Fastify + Drizzle (Postgres) + grammY bot. `services/*` hold all domain logic; `http/server.ts` and `bot/bot.ts` are thin transports. Reminder worker: `jobs/reminders.ts` (every minute, idempotent via `reminder_log`).
- `apps/web` — React 19 + Vite Mini App. Design: "H" set (dark green-gradient) + light theme. Tokens in `src/styles.css`.
- `deploy/` — docker compose project `postkalla` (Postgres 16, API on 127.0.0.1:8090, nightly backup); host nginx serves the web build and proxies `/api`.

## Rules that must never regress (covered by tests)
- Visibility: everyone sees the work (tasks, projects, team, attendance, KPI); money (finance, others' salaries) only CEO/Finance/HR; private 1:1 tasks only giver, assignee, reviewer, Owner, never posted to groups.
- Roles/salary/attendance: nobody edits their own; nobody grants or touches a rank ≥ their own; ≥1 Owner always.
- Tenant isolation: every query filters by `company_id`; actor is loaded from DB per request (never from the token).
- Nobody approves their own task. Deadline moves need a manager + reason; motivation uses `original_deadline`.
- Reminders count working hours only; one live reminder per chat (previous is deleted); 3 overdue reminders → project manager (+1 wh) → CEO (+1 wh, only if the status did not change).
- Board drag = the same state-machine action as a button (`actionToReach`); columns are per board (main/DESIGN/MEDIA) and map to a status.

## Commands
- `npm test` (all workspaces; API tests use in-memory PGlite), `npm run typecheck`.
- Local run without Telegram: `BOT_TOKEN=dev JWT_SECRET=<32+ chars> DATABASE_URL=pglite:./.pgdev DEV_LOGIN=1 npx tsx apps/api/src/main.ts`, then `npm run dev -w @retarget/web` and open `http://localhost:5173/?dev=1`.
- New migration: edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w @retarget/api`.

## Deploy
Actions → workflow "Server" (manual, input `deploy`) builds web + API image and ships to the AWS VM next to the old ERP (never touch the old `retarget-erp` containers/nginx site). Secrets: `SSH_KEY`, `SSH_HOST`, `SSH_USER`, `BOT_TOKEN`. URL: https://postkalla.3-122-101-164.nip.io

## Progress
- [x] Shared rules + tests
- [x] API core, auth, bot, reminder worker + DB/HTTP tests
- [x] Mini App: home, tasks (list/kanban/detail/create), projects, team (invite/edit/rate), profile, settings
- [x] Docker/Caddy/CI
- [x] Deploy (AWS VM, alongside old ERP)
- [x] Tasks: editable kanban columns, list, calendar, filters, checklist, comments; escalation 3 → PM → CEO
- [x] Syomka: week grid + day columns by operator/location, crew DMs, conflicts, reminders (24 h, 2 h)
- [x] Dizayn/Media pages: month stats, completion ring, review queue with approve/return, team share of open work, project progress
- [ ] Moliya, Onboarding, Hisobotlar, AI digest, Obuna, ru/en translations
