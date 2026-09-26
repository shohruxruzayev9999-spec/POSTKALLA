import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ACTIONS, DomainError, ROLES, scopesFor, type TaskAction } from '@retarget/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { findUserByTelegram, issueToken, upsertTelegramUser, verifyInitData, verifyToken } from '../auth/telegram.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as analytics from '../services/analytics.js';
import * as att from '../services/attendance.js';
import { loadActor, type Ctx, type ResolvedActor } from '../services/context.js';
import * as org from '../services/org.js';
import * as projects from '../services/projects.js';
import * as tasks from '../services/tasks.js';

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
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true, bodyLimit: 256 * 1024 });

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
  const inviteLink = (token: string) => `https://t.me/${cfg.botUsername}?startapp=inv_${token}`;

  app.get('/api/health', async () => ({ ok: true, time: ctx.now().toISOString() }));

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

  app.get('/api/projects', async (req) => projects.listProjects(ctx, await actorOf(req)));
  app.post('/api/projects', async (req) => projects.createProject(ctx, await actorOf(req), req.body as never));
  app.patch('/api/projects/:id', async (req) => projects.updateProject(ctx, await actorOf(req), idParam.parse(req.params).id, req.body as never));

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

  app.get('/api/attendance/today', async (req) => att.today(ctx, await actorOf(req)));
  app.post('/api/attendance/check-in', async (req) => att.checkIn(ctx, await actorOf(req), (req.body ?? {}) as never));
  app.post('/api/attendance/check-out', async (req) => att.checkOut(ctx, await actorOf(req), (req.body ?? {}) as never));
  app.get('/api/attendance', async (req) => att.listAttendance(ctx, await actorOf(req), req.query as never));
  app.put('/api/attendance', async (req) => att.editAttendance(ctx, await actorOf(req), req.body as never));

  app.get('/api/dashboard', async (req) => analytics.dashboard(ctx, await actorOf(req)));
  app.post('/api/kpi/ratings', async (req) => {
    await analytics.rateMember(ctx, await actorOf(req), req.body as never);
    return { ok: true };
  });

  return app;
}
