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
- No Telegram/HTTP call inside a transaction or lock: use `afterCommit(ctx, fn)` in services.
- Tenant isolation: every query filters by `company_id`; actor is loaded from DB per request (never from the token).
- Nobody approves their own task. Deadline moves need a manager + reason; motivation uses `original_deadline`.
- Reminders count working hours only; one live reminder per chat (previous is deleted); 3 overdue reminders → project manager (+1 wh) → CEO (+1 wh, only if the status did not change).
- Billing never collects card data; only a platform admin can confirm a payment.
- Report PDF links use a purpose-bound token (`issuePurposeToken`) that can never act as a session token.
- Board drag = the same state-machine action as a button (`actionToReach`); columns are per board (main/DESIGN/MEDIA) and map to a status.

## Commands
- `npm test` (all workspaces; API tests use in-memory PGlite), `npm run typecheck`.
- Local run without Telegram: `BOT_TOKEN=dev JWT_SECRET=<32+ chars> DATABASE_URL=pglite:./.pgdev DEV_LOGIN=1 npx tsx apps/api/src/main.ts`, then `npm run dev -w @retarget/web` and open `http://localhost:5173/?dev=1`.
- New migration: edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w @retarget/api`.

## Deploy
Every push to `main` runs workflow "Server" (tests → build → ship; also manual with input `deploy`/`inspect`) builds web + API image and ships to the AWS VM next to the old ERP (never touch the old `retarget-erp` containers/nginx site). Secrets: `SSH_KEY`, `SSH_HOST`, `SSH_USER`, `BOT_TOKEN`. URL: https://postkalla.3-122-101-164.nip.io

## Progress
- [x] Shared rules + tests
- [x] API core, auth, bot, reminder worker + DB/HTTP tests
- [x] Mini App: home, tasks (list/kanban/detail/create), projects, team (invite/edit/rate), profile, settings
- [x] Docker/Caddy/CI
- [x] Deploy (AWS VM, alongside old ERP)
- [x] Tasks: editable kanban columns, list, calendar, filters, checklist, comments; escalation 3 → PM → CEO
- [x] Syomka: week grid + day columns by operator/location, crew DMs, conflicts, reminders (24 h, 2 h)
- [x] Dizayn/Media pages: month stats, completion ring, review queue with approve/return, team share of open work, project progress
- [x] Moliya (CEO/Finance only): editable income/expense grid, derived status, debtors, month copy, trend chart, audit history
- [x] Onboarding: block documents per audience (all / department), drafts, read receipts «Tanishdim» (reset on content change), starter kit
- [x] Hisobotlar: project/company report from ERP data + stored Telegram group messages (`chat_messages`, bot must be group admin); preview page, PDF (pdfkit + bundled Manrope TTF in `apps/api/assets/fonts`), send to Telegram; optional AI summary (ANTHROPIC_API_KEY)
- [x] AI agent (kunlik tahlil): every working day at `digestTime` (default work start) — rule-based recommendations + optional AI advice, Telegram DM to leads (CEO/admin/PM/marketer/dept heads), dashboard card and page; money only to finance viewers, never sent to the model; recommends only, writes nothing but its own `digests` row
- [x] Obuna: plans Start/Biznes/Premium (`packages/shared/src/plans.ts`), 1/3/6/12-month prepay discounts, 14-day trial for new agencies (agencies that existed before billing = Premium, no end date), payment request → platform admin confirms in bot or app (PLATFORM_ADMIN_TG_IDS, default: owners of the oldest company); no card data is ever collected; limits are warnings only
- [x] Loyiha oylik Kanbani: open months read live from `tasks`, a month is frozen once at rollover (company lock exclusive only then, writes share it); closed history filed under the month it was finished; Telegram side effects run after commit (`afterCommit`)
- [x] Audit fixes (Oct 2026): rank guard on salary/attendance, self-created tasks get default reviewer + 1 point, private 1:1 escalation only to giver/reviewer/CEO, board lists all open + recent closed tasks, `/api/health` (db, worker, bot) + Uptime workflow + Telegram alerts, checked backups with monthly restore test, pre-deploy backup and automatic rollback
- [ ] ru/en translations, data migration from the old ERP, Payme/Click gateway

## Current state (handoff, 17 Oct 2026)
Read this first when a new session starts — the owner should not have to re-explain the project.
- Owner speaks Uzbek; answer in Uzbek, short and plain. They want fewer tokens and fast, concrete work.
- Owner works from a Mac: project lives in `~/Documents/postkalla` (git clone of branch `claude/zealous-euler-uxefhi`). Show the running app in the side-panel preview (local run command above, open `http://localhost:5173/?dev=1`).
- Branch `claude/zealous-euler-uxefhi` = PR #2 (draft, CI green, not merged): all 5 Oct audit fixes (see Progress) + custom department names at company creation + project header ring beside the title / 3 counters in one row. Merging to `main` deploys.
- **Production server is DOWN** (AWS VM at the nip.io URL stopped responding, 17 Oct). Cause unknown — ask the owner (free tier ended? frozen?). All data (Postgres volume + `~/postkalla/backups`) is on that VM's disk: recover it before moving.
- Moving to a new server is planned: candidates Google Cloud e2-micro (free, us-central1, 1 GB RAM — run Postkalla alone, add 2 GB swap), Oracle Always Free (stronger), or Hetzner (~€4/mo). For any new Ubuntu VM: update GitHub secrets `SSH_HOST/SSH_USER/SSH_KEY`, make sure nginx + certbot exist (`deploy/server-setup.sh`), then run workflow "Server" with `deploy`.
- Decisions still needed from the owner: own domain + static IP (nip.io breaks if IP changes); off-site backup (S3 or similar).
- Remaining audit items not done yet (lower priority): KPI month attribution and "absent until Keldim" (19), missing indexes (20), error/retry states in UI (21), company timezone everywhere in UI (22), confirm before delete / unsaved form loss (23), Team page on phones + light-theme contrast (24), security headers + pinned SSH host key + disable old CI deploy job (25); lazy-loaded pages, opening task attachments, zoom enabled, GitHub Actions versions; missing: export, account deletion, global search, notification center.
