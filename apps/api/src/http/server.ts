import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ACTIONS, DomainError, ROLES, scopesFor, type TaskAction } from '@retarget/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { findUserByTelegram, issuePurposeToken, issueToken, upsertTelegramUser, verifyInitData, verifyPurposeToken, verifyToken } from '../auth/telegram.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as analytics from '../services/analytics.js';
import * as att from '../services/attendance.js';
import { loadActor, type Ctx, type ResolvedActor } from '../services/context.js';
import * as org from '../services/org.js';
import * as projects from '../services/projects.js';
import * as months from '../services/projectMonths.js';
import * as tasks from '../services/tasks.js';
import { globalSearch } from '../services/search.js';
import * as boards from '../services/boards.js';
import * as shoots from '../services/shoots.js';
import * as finance from '../services/finance.js';
import * as onboarding from '../services/onboarding.js';
import * as reports from '../services/reports.js';
import * as digest from '../services/digest.js';
import * as billing from '../services/billing.js';
import { recordGroupMessage, type IncomingMessage } from '../services/chatlog.js';
import { checkHealth } from '../services/health.js';
import { reportPdf, sendReport } from '../services/reportSend.js';

export interface HttpConfig {
  botToken: string;
  botUsername: string;
  jwtSecret: string;
  corsOrigins: string[];
  /** Local development only: log in as any Telegram id without Telegram. */
  devLogin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

export function buildServer(ctx: Ctx, cfg: HttpConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Short-lived report links carry a token in the query string — never write it to logs.
      serializers: { req: (req) => ({ method: req.method, url: req.url.replace(/([?&]t=)[^&]+/, '$1[redacted]'), remoteAddress: req.ip }) },
    },
    // Only the host nginx (loopback / Docker network) may set X-Forwarded-For; trusting every
    // hop would let a client fake its IP and slip past the rate limits.
    trustProxy: ['127.0.0.1', '::1', '172.16.0.0/12', '10.0.0.0/8'],
    bodyLimit: 256 * 1024,
  });

  app.register(cors, { origin: cfg.corsOrigins.length ? cfg.corsOrigins : true, allowedHeaders: ['authorization', 'content-type', 'x-company-id'] });
  app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send({ code: err.code, message: err.message });
    if (err instanceof ZodError) {
      return reply.status(422).send({ code: 'VALIDATION', message: "Ma'lumot noto'g'ri", issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ code: 'BAD_REQUEST', message: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: 'Serverda xatolik' });
  });

  const auth = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new DomainError('UNAUTHORIZED', 'Kirish kerak');
    req.userId = await verifyToken(h.slice(7), cfg.jwtSecret);
  };
  const actorOf = async (req: FastifyRequest): Promise<ResolvedActor> => {
    await auth(req);
    const companyId = req.headers['x-company-id'];
    if (typeof companyId !== 'string' || !/^[0-9a-f-]{36}$/.test(companyId)) throw new DomainError('VALIDATION', 'Kompaniya tanlanmagan');
    return loadActor(ctx.db, req.userId!, companyId);
  };
  const idParam = z.object({ id: z.string().uuid() });
  const inviteLink = (token: string) => `https://t.me/${cfg.botUsername}/app?startapp=inv_${token}`;

  // Polled by the Docker healthcheck and the external uptime workflow: 503 when the database,
  // the reminder worker or the bot is down.
  app.get('/api/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const h = await checkHealth(ctx);
    return reply.status(h.ok ? 200 : 503).send({ ...h, time: ctx.now().toISOString() });
  });

  // ---------------------------------------------------------------- auth
  app.post('/api/auth/telegram', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { initData } = z.object({ initData: z.string().min(10).max(8192) }).parse(req.body);
    const data = verifyInitData(initData, cfg.botToken, ctx.now());
    const user = await upsertTelegramUser(ctx.db, data.user);
    return { token: await issueToken(user.id, cfg.jwtSecret), user, startParam: data.startParam, companies: await org.myCompanies(ctx.db, user.id) };
  });

  if (cfg.devLogin) {
    app.post('/api/auth/dev', async (req) => {
      const body = z.object({ telegramId: z.number().int(), firstName: z.string().min(1) }).parse(req.body);
      const user = (await findUserByTelegram(ctx.db, body.telegramId)) ?? (await upsertTelegramUser(ctx.db, { id: body.telegramId, first_name: body.firstName }));
      return { token: await issueToken(user.id, cfg.jwtSecret), user, startParam: null, companies: await org.myCompanies(ctx.db, user.id) };
    });
    // Local development: bind a fake group and feed it messages as if the bot received them.
    app.post('/api/dev/chat', async (req) => {
      const actor = await actorOf(req);
      const body = z.object({ projectId: z.string().uuid(), chatId: z.number().int(), title: z.string(), messages: z.array(z.record(z.string(), z.unknown())) }).parse(req.body);
      await projects.bindChat(ctx, actor, body.projectId, body.chatId, body.title);
      let n = 0;
      for (const m of body.messages) if (await recordGroupMessage(ctx, m as unknown as IncomingMessage)) n++;
      return { n };
    });
  }

  app.get('/api/me', async (req) => {
    await auth(req);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, req.userId!));
    if (!user) throw new DomainError('UNAUTHORIZED', 'Foydalanuvchi topilmadi');
    return { user, companies: await org.myCompanies(ctx.db, user.id) };
  });

  app.post('/api/companies', async (req) => {
    await auth(req);
    return org.createCompany(ctx, req.userId!, req.body as never);
  });

  app.get('/api/invitations/:token/preview', async (req) => {
    await auth(req);
    return org.previewInvitation(ctx, z.object({ token: z.string().max(64) }).parse(req.params).token);
  });
  app.post('/api/invitations/:token/accept', async (req) => {
    await auth(req);
    return org.acceptInvitation(ctx, req.userId!, z.object({ token: z.string().max(64) }).parse(req.params).token);
  });

  // ---------------------------------------------------------------- company scope
  app.get('/api/context', async (req) => {
    const a = await actorOf(req);
    // What the UI may show. It is a hint only — every call is checked again on the server.
    const permissions = Object.fromEntries(ACTIONS.map((act) => [act, scopesFor(a.roles, act)]));
    return {
      company: a.company,
      roles: a.roles,
      departmentIds: a.departmentIds,
      headOfDepartmentIds: a.headOfDepartmentIds,
      projectIds: a.projectIds,
      permissions,
      allRoles: ROLES,
    };
  });
  app.patch('/api/company', async (req) => org.updateCompany(ctx, await actorOf(req), req.body as never));

  app.get('/api/departments', async (req) => org.listDepartments(ctx, await actorOf(req)));
  app.post('/api/departments', async (req) => org.createDepartment(ctx, await actorOf(req), req.body as never));
  app.patch('/api/departments/:id', async (req) => org.updateDepartment(ctx, await actorOf(req), idParam.parse(req.params).id, req.body as never));

  app.get('/api/members', async (req) => org.listMembers(ctx, await actorOf(req)));
  app.patch('/api/members/:id', async (req) => org.updateMember(ctx, await actorOf(req), idParam.parse(req.params).id, req.body as never));
  app.get('/api/members/:id/scores', async (req) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    return analytics.memberScores(ctx, await actorOf(req), idParam.parse(req.params).id, month);
  });

  app.get('/api/invitations', async (req) => (await org.listInvitations(ctx, await actorOf(req))).map((i) => ({ ...i, link: inviteLink(i.token) })));
  app.post('/api/invitations', async (req) => {
    const inv = await org.createInvitation(ctx, await actorOf(req), req.body as never);
    return { ...inv, link: inviteLink(inv.token) };
  });
  app.delete('/api/invitations/:id', async (req) => {
    await org.revokeInvitation(ctx, await actorOf(req), idParam.parse(req.params).id);
    return { ok: true };
  });

  app.get('/api/projects/:id/months', async req => months.listProjectMonths(ctx, await actorOf(req), idParam.parse(req.params).id));
  const periodParam = z.object({ id: z.string().uuid(), month: months.monthInput });
  app.get('/api/projects/:id/months/:month', async req => { const p = periodParam.parse(req.params); return months.getProjectMonth(ctx, await actorOf(req), p.id, p.month); });
  app.post('/api/projects/:id/months', async req => months.createProjectMonth(ctx, await actorOf(req), idParam.parse(req.params).id, z.object({ month: months.monthInput }).parse(req.body).month));
  app.delete('/api/projects/:id/months/:month', async req => { const p = periodParam.parse(req.params); return months.deleteProjectMonth(ctx, await actorOf(req), p.id, p.month); });
  app.get('/api/projects', async (req) => projects.listProjects(ctx, await actorOf(req)));
  app.post('/api/projects', async (req) => projects.createProject(ctx, await actorOf(req), req.body as never));
  app.patch('/api/projects/:id', async (req) => projects.updateProject(ctx, await actorOf(req), idParam.parse(req.params).id, req.body as never));

  app.post('/api/tasks/export', async (req) => tasks.exportTasks(ctx, await actorOf(req), z.object({ mine: z.boolean().optional() }).parse(req.body ?? {})));
  app.get('/api/search', async (req) => globalSearch(ctx, await actorOf(req), req.query as never));
  app.get('/api/tasks', async (req) => tasks.listTasks(ctx, await actorOf(req), req.query as never));
  app.post('/api/tasks', async (req) => tasks.createTask(ctx, await actorOf(req), req.body as never));
  app.get('/api/tasks/:id', async (req) => tasks.getTask(ctx, await actorOf(req), idParam.parse(req.params).id));
  app.patch('/api/tasks/:id', async (req) => tasks.updateTask(ctx, await actorOf(req), idParam.parse(req.params).id, req.body as never));
  app.post('/api/tasks/:id/actions', async (req) => {
    const body = z
      .object({ action: z.enum(['START', 'BLOCK', 'SUBMIT', 'APPROVE', 'RETURN', 'REOPEN', 'CANCEL']), comment: z.string().max(2000).optional() })
      .parse(req.body);
    return tasks.actOnTask(ctx, await actorOf(req), idParam.parse(req.params).id, body.action as TaskAction, body.comment);
  });

  // ---------------------------------------------------------------- boards, comments, checklist
  app.get('/api/boards/:board/columns', async (req) => boards.listColumns(ctx, await actorOf(req), (req.params as { board: string }).board));
  app.post('/api/boards/:board/columns', async (req) => boards.createColumn(ctx, await actorOf(req), (req.params as { board: string }).board, req.body as never));
  app.put('/api/boards/:board/order', async (req) =>
    boards.reorderColumns(ctx, await actorOf(req), (req.params as { board: string }).board, z.object({ ids: z.array(z.string().uuid()).max(20) }).parse(req.body).ids),
  );
  app.patch('/api/columns/:id', async (req) => boards.updateColumn(ctx, await actorOf(req), idParam.parse(req.params).id, req.body as never));
  app.delete('/api/columns/:id', async (req) => {
    await boards.deleteColumn(ctx, await actorOf(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/tasks/:id/move', async (req) => {
    const body = z.object({ columnId: z.string().uuid(), comment: z.string().max(2000).optional() }).parse(req.body);
    return boards.moveTask(ctx, await actorOf(req), idParam.parse(req.params).id, body.columnId, body.comment);
  });
  app.post('/api/tasks/:id/comments', async (req) =>
    boards.addComment(ctx, await actorOf(req), idParam.parse(req.params).id, z.object({ body: z.string() }).parse(req.body).body),
  );
  app.post('/api/tasks/:id/checklist', async (req) =>
    boards.addChecklistItem(ctx, await actorOf(req), idParam.parse(req.params).id, z.object({ text: z.string() }).parse(req.body).text),
  );
  const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
  app.patch('/api/tasks/:id/checklist/:itemId', async (req) => {
    const p = itemParams.parse(req.params);
    return boards.updateChecklistItem(ctx, await actorOf(req), p.id, p.itemId, req.body as never);
  });
  app.delete('/api/tasks/:id/checklist/:itemId', async (req) => {
    const p = itemParams.parse(req.params);
    await boards.deleteChecklistItem(ctx, await actorOf(req), p.id, p.itemId);
    return { ok: true };
  });

  app.get('/api/attendance/today', async (req) => att.today(ctx, await actorOf(req)));
  app.post('/api/attendance/check-in', async (req) => att.checkIn(ctx, await actorOf(req), (req.body ?? {}) as never));
  app.post('/api/attendance/check-out', async (req) => att.checkOut(ctx, await actorOf(req), (req.body ?? {}) as never));
  app.get('/api/attendance/month', async (req) => att.attendanceMonth(ctx, await actorOf(req), req.query as never));

  app.get('/api/finance', async (req) => finance.financeMonth(ctx, await actorOf(req), req.query as never));
  app.get('/api/finance/trend', async (req) => finance.financeTrend(ctx, await actorOf(req), req.query as never));
  app.post('/api/finance/rows', async (req) => finance.createRow(ctx, await actorOf(req), req.body as never));
  app.patch('/api/finance/rows/:id', async (req) => finance.updateRow(ctx, await actorOf(req), (req.params as { id: string }).id, req.body as never));
  app.delete('/api/finance/rows/:id', async (req) => {
    await finance.deleteRow(ctx, await actorOf(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/finance/rows/:id/history', async (req) => finance.rowHistory(ctx, await actorOf(req), (req.params as { id: string }).id));
  app.post('/api/finance/copy', async (req) => finance.copyMonth(ctx, await actorOf(req), req.body as never));

  app.get('/api/onboarding', async (req) => onboarding.listDocs(ctx, await actorOf(req)));
  app.post('/api/onboarding', async (req) => onboarding.createDoc(ctx, await actorOf(req), req.body as never));
  app.post('/api/onboarding/starter', async (req) => onboarding.createStarterKit(ctx, await actorOf(req)));
  app.put('/api/onboarding/order', async (req) => {
    await onboarding.reorderDocs(ctx, await actorOf(req), (req.body as { ids: string[] }).ids ?? []);
    return { ok: true };
  });
  app.get('/api/onboarding/:id', async (req) => onboarding.getDoc(ctx, await actorOf(req), (req.params as { id: string }).id));
  app.patch('/api/onboarding/:id', async (req) => onboarding.updateDoc(ctx, await actorOf(req), (req.params as { id: string }).id, req.body as never));
  app.delete('/api/onboarding/:id', async (req) => {
    await onboarding.deleteDoc(ctx, await actorOf(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/onboarding/:id/ack', async (req) => onboarding.acknowledge(ctx, await actorOf(req), (req.params as { id: string }).id));

  // ---------------------------------------------------------------- billing (Obuna)
  app.get('/api/billing', async (req) => billing.billingOverview(ctx, await actorOf(req)));
  app.post('/api/billing/request', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => billing.requestPayment(ctx, await actorOf(req), req.body as never));
  app.get('/api/platform/payments', async (req) => {
    await auth(req);
    return billing.pendingPayments(ctx, req.userId!);
  });
  app.post('/api/platform/payments/:id', async (req) => {
    await auth(req);
    const { id } = idParam.parse(req.params);
    const { decision } = z.object({ decision: z.enum(['PAID', 'CANCELLED']) }).parse(req.body);
    return billing.decidePayment(ctx, req.userId!, id, decision);
  });

  // ---------------------------------------------------------------- daily digest (recommendations only)
  app.get('/api/digest', async (req) => digest.todayDigest(ctx, await actorOf(req)));
  app.post('/api/digest/refresh', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req) => digest.refreshDigest(ctx, await actorOf(req)));

  // ---------------------------------------------------------------- reports
  app.get('/api/reports', async (req) => reports.buildReport(ctx, await actorOf(req), req.query as never));
  app.post('/api/reports/send', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => sendReport(ctx, await actorOf(req), req.body as never));
  app.post('/api/reports/link', async (req) => {
    const actor = await actorOf(req);
    const q = reports.reportQuery.parse(req.body);
    const t = await issuePurposeToken('report', actor.userId, { cid: actor.companyId, p: q.projectId ?? null, f: q.from, to: q.to }, cfg.jwtSecret, 180);
    return { url: `/api/reports/pdf?t=${encodeURIComponent(t)}` };
  });
  // Opened by link (Telegram / browser download) — the short-lived token replaces the auth header.
  app.get('/api/reports/pdf', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const t = z.object({ t: z.string().min(20) }).parse(req.query).t;
    const claims = await verifyPurposeToken('report', t, cfg.jwtSecret);
    const actor = await loadActor(ctx.db, claims.sub, String(claims.cid));
    const { fileName, pdf } = await reportPdf(ctx, actor, { projectId: (claims.p as string | null) ?? undefined, from: String(claims.f), to: String(claims.to) });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('cache-control', 'private, no-store')
      .send(pdf);
  });

  app.get('/api/shoots', async (req) => shoots.listShoots(ctx, await actorOf(req), req.query as never));
  app.post('/api/shoots', async (req) => shoots.createShoot(ctx, await actorOf(req), req.body as never));
  app.patch('/api/shoots/:id', async (req) => shoots.updateShoot(ctx, await actorOf(req), (req.params as { id: string }).id, req.body as never));
  app.delete('/api/shoots/:id', async (req) => {
    await shoots.deleteShoot(ctx, await actorOf(req), (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/attendance', async (req) => att.listAttendance(ctx, await actorOf(req), req.query as never));
  app.put('/api/attendance', async (req) => att.editAttendance(ctx, await actorOf(req), req.body as never));

  app.get('/api/dashboard', async (req) => analytics.dashboard(ctx, await actorOf(req)));

  return app;
}

