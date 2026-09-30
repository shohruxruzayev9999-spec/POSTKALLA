# Project monthly Kanban

Click a project to open its existing main-board columns, monthly task counters, assignee/status filters, project editor and task details. Future months can be opened up to two calendar years ahead. New tasks created there retain that planning month independently of their deadline.

## Calendar and history

- Months follow the company's timezone. The minute worker and every task/board mutation reconcile month boundaries. A company advisory transaction lock serializes rollover with task changes; the same mechanism also covers Telegram actions.
- Closed-month snapshots retain task fields, card counters, assignee display and column structure. Open tasks carry forward with the same ID, status, column and original deadline. Completed/cancelled tasks stay in their month. Reopening completed work places it in the current month without rewriting its archive.
- Catch-up works across multiple missed months and merges tasks already planned for a future month without duplication.
- Existing installations establish their first truthful snapshot in the current month. Earlier month-end states are not fabricated; pre-existing task event histories remain available. Existing tasks are initially grouped into that current month.
- Archive deletion is limited to OWNER/ADMIN, requires an explicit UI confirmation, clears the snapshot and retains a tombstone to prevent recreation. It does not delete underlying tasks or their events.
- Project settings, manager reassignment and new months are controlled by OWNER/ADMIN or the actual project manager. A replacement manager must be an active member of the same company. Task action rules, private-task visibility and tenant isolation still apply.

## Deployment and validation

Apply generated migration `0011_cheerful_shinobi_shaw.sql` through the existing startup migrator. It adds nullable `tasks.planned_month` and `project_months`. This migration does not delete or reset tasks.

Validation: shared and API tests; `npm run typecheck`; web production build; desktop and 390px mobile browser checks, including creating a future-month task in an isolated demo database. The monthly tests cover midnight edits, duplicate prevention, future planning, multi-month catch-up, year rollover/reopening, privacy, tenant isolation, archive deletion and project manager reassignment.
