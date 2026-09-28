import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** A Telegram account. One person, many companies. */
export const users = pgTable('users', {
  id: id(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  username: text('username'),
  photoUrl: text('photo_url'),
  language: text('language').notNull().default('uz'),
  /** The user pressed Start / allowed write access, so the bot may DM them. */
  canDm: boolean('can_dm').notNull().default(false),
  createdAt: createdAt(),
});

/** A tenant. Everything below carries company_id and is isolated by it. */
export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Tashkent'),
  workDays: integer('work_days').array().notNull().default(sql`'{1,2,3,4,5,6}'`),
  workStart: text('work_start').notNull().default('10:00'),
  workEnd: text('work_end').notNull().default('18:00'),
  holidays: text('holidays').array().notNull().default(sql`'{}'`),
  /** Overrides of DEFAULT_REMINDER_POLICY. */
  reminderPolicy: jsonb('reminder_policy').$type<Record<string, unknown>>().notNull().default({}),
  /** Office location for check-in (optional). */
  officeLat: doublePrecision('office_lat'),
  officeLng: doublePrecision('office_lng'),
  officeRadiusM: integer('office_radius_m').notNull().default(300),
  createdAt: createdAt(),
});

export const departments = pgTable(
  'departments',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** KPI template key: DESIGN, VIDEO, SMM, TARGET, SALES, PM, DEFAULT. */
    kpiTemplate: text('kpi_template').notNull().default('DEFAULT'),
    headUserId: uuid('head_user_id').references(() => users.id),
    requireFileOnSubmit: boolean('require_file_on_submit').notNull().default(false),
    /** Which department board it feeds: DESIGN, MEDIA or NONE. */
    section: text('section').notNull().default('NONE'),
    color: text('color').notNull().default('#34D399'),
    createdAt: createdAt(),
  },
  (t) => [index('departments_company_idx').on(t.companyId)],
);

/** A user's seat in a company: roles, department, position, salary. */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roles: text('roles').array().notNull().default(sql`'{EMPLOYEE}'`),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | DISABLED
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    position: text('position'),
    phone: text('phone'),
    /** Monthly base salary in the company currency (so'm). Visible only via salary.view. */
    salary: bigint('salary', { mode: 'number' }),
    joinedAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_company_user_uq').on(t.companyId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const invitations = pgTable('invitations', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  role: text('role').notNull().default('EMPLOYEE'),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  position: text('position'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  expiresAt: ts('expires_at').notNull(),
  maxUses: integer('max_uses').notNull().default(1),
  uses: integer('uses').notNull().default(0),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: createdAt(),
});

export const clients = pgTable('clients', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  contact: text('contact'),
  createdAt: createdAt(),
});

export const projects = pgTable(
  'projects',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#34D399'),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | PAUSED | DONE
    managerUserId: uuid('manager_user_id').references(() => users.id),
    /** Telegram group bound to the project: new tasks and buttons are posted there. */
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    telegramChatTitle: text('telegram_chat_title'),
    deadline: ts('deadline'),
    createdAt: createdAt(),
  },
  (t) => [index('projects_company_idx').on(t.companyId), uniqueIndex('projects_chat_uq').on(t.telegramChatId)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    /** Short human number per company: #142. */
    number: integer('number').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('NEW'),
    priority: text('priority').notNull().default('MEDIUM'),
    assigneeUserId: uuid('assignee_user_id').notNull().references(() => users.id),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    deadline: ts('deadline').notNull(),
    /** Never changes after creation — motivation is measured against it. */
    originalDeadline: ts('original_deadline').notNull(),
    revision: integer('revision').notNull().default(1),
    points: integer('points').notNull().default(1),
    /** Placement on a board; the status is still governed by the state machine. */
    columnId: uuid('column_id').references((): AnyPgColumn => taskColumns.id, { onDelete: 'set null' }),
    /** Deliverable type (Banner, Post, Reels, Story, Logo, …) and channel (Instagram, Telegram, …). */
    format: text('format'),
    platform: text('platform'),
    links: text('links').array().notNull().default(sql`'{}'`),
    /** 1:1 task: visible only to its giver, assignee, reviewer and the Owner; never posted to a group. */
    isPrivate: boolean('is_private').notNull().default(false),
    completedAt: ts('completed_at'),
    /** Where the task card lives in Telegram (edited in place on every change). */
    groupChatId: bigint('group_chat_id', { mode: 'number' }),
    groupMessageId: integer('group_message_id'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tasks_company_number_uq').on(t.companyId, t.number),
    index('tasks_company_status_idx').on(t.companyId, t.status),
    index('tasks_assignee_idx').on(t.assigneeUserId),
    index('tasks_deadline_idx').on(t.deadline),
  ],
);

export const taskEvents = pgTable(
  'task_events',
  {
    id: id(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    comment: text('comment'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId)],
);

/** Files live in Telegram (file_id) — the server stores no binaries. */
export const taskFiles = pgTable('task_files', {
  id: id(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  telegramFileId: text('telegram_file_id').notNull(),
  fileName: text('file_name'),
  kind: text('kind').notNull().default('document'),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  createdAt: createdAt(),
});

/** Which reminder steps were handled (sent or skipped) — survives restarts. */
export const reminderLog = pgTable(
  'reminder_log',
  {
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    /** Deadline the plan was built for — moving the deadline starts a fresh plan. */
    deadline: ts('deadline').notNull(),
    sent: boolean('sent').notNull(),
    handledAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.stepKey, t.deadline] })],
);

/** The single live reminder message per task per chat — deleted before the next one is sent. */
export const reminderMessages = pgTable(
  'reminder_messages',
  {
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: integer('message_id').notNull(),
    sentAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.chatId] })],
);

export const attendance = pgTable(
  'attendance',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** Local calendar date in the company timezone. */
    day: date('day').notNull(),
    checkIn: ts('check_in'),
    checkOut: ts('check_out'),
    checkInLat: doublePrecision('check_in_lat'),
    checkInLng: doublePrecision('check_in_lng'),
    checkOutLat: doublePrecision('check_out_lat'),
    checkOutLng: doublePrecision('check_out_lng'),
    /** Minutes late against the work start. */
    lateMinutes: integer('late_minutes').notNull().default(0),
    /** Distance from office at check-in, when the office location is set. */
    distanceM: integer('distance_m'),
    note: text('note'),
    editedBy: uuid('edited_by').references(() => users.id),
  },
  (t) => [uniqueIndex('attendance_company_user_day_uq').on(t.companyId, t.userId, t.day)],
);

/** Monthly manager rating (1–5) — the "manager" KPI component. */
export const kpiRatings = pgTable(
  'kpi_ratings',
  {
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    month: text('month').notNull(), // YYYY-MM
    rating: doublePrecision('rating').notNull(),
    comment: text('comment'),
    ratedBy: uuid('rated_by').notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.userId, t.month] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_company_idx').on(t.companyId, t.createdAt)],
);

/** Kanban columns. Each board (main, DESIGN, MEDIA) has its own set; every column sits inside a status. */
export const taskColumns = pgTable(
  'task_columns',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    board: text('board').notNull().default('main'),
    name: text('name').notNull(),
    status: text('status').notNull(),
    position: integer('position').notNull().default(0),
    color: text('color').notNull().default('#34D399'),
    createdAt: createdAt(),
  },
  (t) => [index('task_columns_company_board_idx').on(t.companyId, t.board)],
);

export const taskComments = pgTable(
  'task_comments',
  {
    id: id(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('task_comments_task_idx').on(t.taskId)],
);

export const taskChecklist = pgTable(
  'task_checklist',
  {
    id: id(),
    taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    done: boolean('done').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('task_checklist_task_idx').on(t.taskId)],
);
