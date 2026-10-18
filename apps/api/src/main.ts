import { Bot } from 'grammy';
import { markBlocked, registerHandlers, TelegramNotifier } from './bot/bot.js';
import { connect } from './db/client.js';
import { buildServer } from './http/server.js';
import { runProjectMonths } from './services/projectMonths.js';
import { runReminders } from './jobs/reminders.js';
import { runShootReminders } from './services/shoots.js';
import { runDigests } from './services/digest.js';
import { runRecurring } from './services/recurring.js';
import type { Ctx } from './services/context.js';
import { NullNotifier } from './services/notifier.js';
import { anthropicClient } from './services/ai.js';
import { alertAdmins, liveness } from './services/health.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

async function connectPglite(dir: string) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const { MIGRATIONS_DIR } = await import('./db/client.js');
  const schema = await import('./db/schema.js');
  const client = new PGlite(dir || undefined);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db: db as unknown as import('./db/client.js').Db, close: () => client.close() };
}

async function main() {
  const botToken = env('BOT_TOKEN');
  const jwtSecret = env('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const databaseUrl = env('DATABASE_URL');
  const { db, close } = databaseUrl.startsWith('pglite:') ? await connectPglite(databaseUrl.slice(7)) : await connect(databaseUrl);

  // BOT_TOKEN=dev runs the API without Telegram (local UI work only).
  const offline = botToken === 'dev';
  // A hung Telegram call gives up after a minute (above the 30 s long-poll window).
  const bot = offline ? null : new Bot(botToken, { client: { timeoutSeconds: 60 } });
  if (bot) await bot.init();
  const botUsername = bot ? bot.botInfo.username : 'dev_bot';

  const ai = process.env.ANTHROPIC_API_KEY ? anthropicClient(process.env.ANTHROPIC_API_KEY, process.env.AI_MODEL || undefined) : undefined;
  const ctx: Ctx = { db, now: () => new Date(), notifier: new NullNotifier(), ai };
  if (bot) {
    ctx.notifier = new TelegramNotifier(bot.api, botUsername, (id) => markBlocked(ctx, id));
    registerHandlers(bot, ctx, botUsername);
  }

  const app = buildServer(ctx, {
    botToken,
    botUsername,
    jwtSecret,
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    devLogin: process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production',
  });
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });

  if (bot) {
    await bot.api
      .setMyCommands([
        { command: 'start', description: 'Ilovani ochish' },
        { command: 'task', description: 'Vazifa: /task ertaga 17:00 @username matn' },
        { command: 'my', description: 'Mening ochiq vazifalarim' },
        { command: 'due', description: 'Muddati yaqin vazifalar' },
      ])
      .catch(() => undefined);
    await bot.api
      .setMyCommands(
        [
          { command: 'task', description: 'Vazifa: xabarga javob qilib yoki /task ertaga 17:00 @username matn' },
          { command: 'bind', description: 'Guruhni loyihaga ulash' },
        ],
        { scope: { type: 'all_group_chats' } },
      )
      .catch(() => undefined);
    if (process.env.WEBAPP_URL) {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Ochish', web_app: { url: process.env.WEBAPP_URL } } }).catch(() => undefined);
    }
  }

  // Reminder worker: every minute, never overlapping. Each job is isolated — one failing job
  // never stops the others — and a failure alerts the platform admins in Telegram.
  const job = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      app.log.error(e, `${name} failed`);
      await alertAdmins(ctx, `job:${name}`, `${name} ishlamadi — ${(e as Error).message ?? e}`);
      return null;
    }
  };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await job('project months', () => runProjectMonths(ctx));
      const repeated = await job('repeating tasks', () => runRecurring(ctx));
      if (repeated) app.log.info({ repeated }, 'repeating tasks');
      const r = await job('reminders', () => runReminders(ctx));
      if (r && (r.sent || r.skipped)) app.log.info(r, 'reminders');
      const shootsSent = await job('shoot reminders', () => runShootReminders(ctx));
      if (shootsSent) app.log.info({ shootsSent }, 'shoot reminders');
      const digestsSent = await job('daily digests', () => runDigests(ctx));
      if (digestsSent) app.log.info({ digestsSent }, 'daily digests');
      liveness.workerAt = ctx.now();
    } finally {
      running = false;
    }
  }, 60_000);

  if (bot) {
    liveness.botRunning = () => bot.isRunning();
    bot
      .start({ allowed_updates: ['message', 'callback_query', 'my_chat_member'], onStart: () => app.log.info(`bot @${botUsername} polling`) })
      .catch(async (e) => {
        app.log.error(e, 'bot polling stopped');
        await alertAdmins(ctx, 'bot', `bot to‘xtadi — ${(e as Error).message ?? e}`);
      });
  }

  const shutdown = async () => {
    clearInterval(timer);
    await bot?.stop();
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

