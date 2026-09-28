import type { TaskAction } from '@retarget/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { loadActor, type Ctx } from '../services/context.js';
import type { Notifier, ReminderDelivery, SentMessage, TaskCard } from '../services/notifier.js';
import { acceptInvitation, createCompany, createInvitation } from '../services/org.js';
import { testDb } from './db.js';

export class RecordingNotifier implements Notifier {
  cards: TaskCard[] = [];
  changes: Array<{ card: TaskCard; action: TaskAction; actorName: string; comment: string | null }> = [];
  reminders: ReminderDelivery[] = [];
  deleted: Array<{ chatId: number; messageId: number }> = [];
  dms: Array<{ telegramId: number; text: string }> = [];
  private nextId = 100;

  async upsertTaskCard(card: TaskCard): Promise<SentMessage | null> {
    this.cards.push(card);
    if (!card.groupChatId) return null;
    return { chatId: card.groupChatId, messageId: card.groupMessageId ?? this.nextId++ };
  }
  async taskChanged(card: TaskCard, action: TaskAction, actorName: string, comment: string | null) {
    this.changes.push({ card, action, actorName, comment });
  }
  async sendReminder(d: ReminderDelivery): Promise<SentMessage[]> {
    this.reminders.push(d);
    this.deleted.push(...d.previous);
    const chats = [...d.privateChatIds, ...(d.includeGroup && d.card.groupChatId ? [d.card.groupChatId] : [])];
    return chats.map((chatId) => ({ chatId, messageId: this.nextId++ }));
  }
  async direct(telegramId: number, text: string) {
    this.dms.push({ telegramId, text });
  }
}

export class Clock {
  constructor(public t: Date) {}
  now = () => this.t;
  set(d: Date) {
    this.t = d;
  }
}

let tg = 1000;
export async function makeUser(db: Db, firstName: string) {
  const [u] = await db.insert(users).values({ telegramId: ++tg, firstName, canDm: true }).returning();
  return u!;
}

/**
 * A small agency: Owner (CEO), Admin, HR, a design department with its head and two designers,
 * and a PM. Everyone joined through real invitations.
 */
export async function agency(start = new Date('2026-09-21T05:00:00Z') /* Mon 10:00 Tashkent */) {
  const db = await testDb();
  const clock = new Clock(start);
  const notifier = new RecordingNotifier();
  const ctx: Ctx = { db, notifier, now: clock.now };

  const ceo = await makeUser(db, 'Sardor');
  const company = await createCompany(ctx, ceo.id, {
    name: 'Test Agency',
    departments: [
      { name: 'Dizayn' },
      { name: 'Video' },
    ],
  });
  const actor = (userId: string) => loadActor(db, userId, company.id);
  const owner = await actor(ceo.id);
  const { departments } = await import('../db/schema.js');
  const deps = await db.select().from(departments).where(eq(departments.companyId, company.id));
  const design = deps.find((d) => d.name === 'Dizayn')!;
  const video = deps.find((d) => d.name === 'Video')!;

  async function join(name: string, role: Parameters<typeof createInvitation>[2]['role'], departmentId?: string) {
    const u = await makeUser(db, name);
    const inv = await createInvitation(ctx, owner, { role, departmentId });
    await acceptInvitation(ctx, u.id, inv.token);
    return u;
  }
  const admin = await join('Admin', 'ADMIN');
  const hr = await join('Hilola', 'HR');
  const pm = await join('Kamola', 'PM');
  const head = await join('Jasur', 'EMPLOYEE', design.id);
  const aziz = await join('Aziz', 'EMPLOYEE', design.id);
  const bekzod = await join('Bekzod', 'EMPLOYEE', design.id);
  const videographer = await join('Otabek', 'EMPLOYEE', video.id);

  const { updateDepartment } = await import('../services/org.js');
  await updateDepartment(ctx, owner, design.id, { headUserId: head.id });

  return { db, ctx, clock, notifier, company, design, video, actor, users: { ceo, admin, hr, pm, head, aziz, bekzod, videographer } };
}
