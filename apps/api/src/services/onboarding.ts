import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { canAccess, checkAccess } from '@retarget/shared';
import { z } from 'zod';
import { departments, memberships, onboardingAcks, onboardingDocs, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

export const BLOCK_TYPES = ['heading', 'text', 'callout', 'checklist', 'link', 'video', 'divider'] as const;

const block = z.object({
  id: z.string().min(1).max(40).optional(),
  type: z.enum(BLOCK_TYPES),
  text: z.string().max(6000).default(''),
  items: z.array(z.string().max(300)).max(40).optional(),
  url: z.string().trim().url().max(500).optional().or(z.literal('')),
  tone: z.enum(['info', 'warn', 'good']).optional(),
});
export type Block = z.infer<typeof block>;

const docInput = z.object({
  title: z.string().trim().min(1).max(120),
  emoji: z.string().trim().min(1).max(8).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  blocks: z.array(block).max(120).optional(),
  departmentIds: z.array(z.string().uuid()).max(50).optional(),
  published: z.boolean().optional(),
});

type Doc = typeof onboardingDocs.$inferSelect;

const canManage = (actor: ResolvedActor) => canAccess(actor, 'onboarding.manage', { companyId: actor.companyId });

/** A document is for everyone unless it names departments. */
function isFor(doc: Pick<Doc, 'departmentIds'>, departmentId: string | null) {
  return !doc.departmentIds.length || (!!departmentId && doc.departmentIds.includes(departmentId));
}

async function activeMembers(ctx: Ctx, companyId: string) {
  return ctx.db
    .select({ userId: memberships.userId, departmentId: memberships.departmentId, firstName: users.firstName, lastName: users.lastName, photoUrl: users.photoUrl, telegramId: users.telegramId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'ACTIVE')));
}

function withIds(blocks: z.infer<typeof block>[]) {
  return blocks.map((b) => ({ ...b, id: b.id ?? randomUUID().slice(0, 8), url: b.url || undefined }));
}

/** Key-order-insensitive fingerprint (jsonb reorders keys). */
function canon(blocks: Array<Record<string, unknown>>) {
  return JSON.stringify(blocks.map((b) => [b.id, b.type, b.text ?? '', b.items ?? null, b.url ?? null, b.tone ?? null]));
}

async function assertDepartments(ctx: Ctx, companyId: string, ids: string[] | undefined) {
  if (!ids?.length) return;
  const rows = await ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), inArray(departments.id, ids)));
  if (rows.length !== new Set(ids).size) throw notFound('Bo‘lim');
}

// ------------------------------------------------------------------------------------------ read

/** What the actor should read, with their progress; managers also see drafts and who has not read what. */
export async function listDocs(ctx: Ctx, actor: ResolvedActor) {
  const manager = canManage(actor);
  const docs = await ctx.db.select().from(onboardingDocs).where(eq(onboardingDocs.companyId, actor.companyId)).orderBy(asc(onboardingDocs.position), asc(onboardingDocs.createdAt));
  const acks = docs.length ? await ctx.db.select().from(onboardingAcks).where(inArray(onboardingAcks.docId, docs.map((d) => d.id))) : [];
  const members = await activeMembers(ctx, actor.companyId);
  const me = members.find((m) => m.userId === actor.userId);
  const visible = docs.filter((d) => manager || (d.published && isFor(d, me?.departmentId ?? null)));
  return visible.map((d) => {
    const mine = acks.find((a) => a.docId === d.id && a.userId === actor.userId);
    const audience = members.filter((m) => isFor(d, m.departmentId));
    const current = acks.filter((a) => a.docId === d.id && a.version === d.version);
    return {
      id: d.id,
      title: d.title,
      emoji: d.emoji,
      color: d.color,
      published: d.published,
      version: d.version,
      departmentIds: d.departmentIds,
      blockCount: d.blocks.length,
      updatedAt: d.updatedAt,
      forMe: d.published && isFor(d, me?.departmentId ?? null),
      acked: mine?.version === d.version,
      /** Read an older version — the document changed since. */
      outdated: !!mine && mine.version !== d.version,
      ...(manager ? { audience: audience.length, ackedCount: audience.filter((m) => current.some((a) => a.userId === m.userId)).length } : {}),
    };
  });
}

export async function getDoc(ctx: Ctx, actor: ResolvedActor, id: string) {
  const [d] = await ctx.db.select().from(onboardingDocs).where(and(eq(onboardingDocs.id, id), eq(onboardingDocs.companyId, actor.companyId)));
  if (!d) throw notFound('Hujjat');
  const manager = canManage(actor);
  const members = await activeMembers(ctx, actor.companyId);
  const me = members.find((m) => m.userId === actor.userId);
  if (!manager && !(d.published && isFor(d, me?.departmentId ?? null))) throw notFound('Hujjat');
  const acks = await ctx.db.select().from(onboardingAcks).where(eq(onboardingAcks.docId, id));
  const mine = acks.find((a) => a.userId === actor.userId);
  const readers = manager
    ? members
        .filter((m) => isFor(d, m.departmentId))
        .map((m) => {
          const a = acks.find((x) => x.userId === m.userId);
          return { userId: m.userId, name: [m.firstName, m.lastName].filter(Boolean).join(' '), photoUrl: m.photoUrl, ackedAt: a?.version === d.version ? a.ackedAt : null, outdated: !!a && a.version !== d.version };
        })
        .sort((a, b) => Number(!!a.ackedAt) - Number(!!b.ackedAt) || a.name.localeCompare(b.name))
    : undefined;
  return { ...d, acked: mine?.version === d.version, ackedAt: mine?.version === d.version ? mine.ackedAt : null, outdated: !!mine && mine.version !== d.version, canEdit: manager, readers };
}

// ------------------------------------------------------------------------------------------ write

export async function createDoc(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof docInput>) {
  checkAccess(actor, 'onboarding.manage', { companyId: actor.companyId });
  const data = docInput.parse(input);
  await assertDepartments(ctx, actor.companyId, data.departmentIds);
  const existing = await ctx.db.select({ id: onboardingDocs.id }).from(onboardingDocs).where(eq(onboardingDocs.companyId, actor.companyId));
  const now = ctx.now();
  const [d] = await ctx.db
    .insert(onboardingDocs)
    .values({
      companyId: actor.companyId,
      title: data.title,
      emoji: data.emoji ?? '📘',
      color: data.color ?? '#34D399',
      blocks: withIds(data.blocks ?? []),
      departmentIds: data.departmentIds ?? [],
      published: data.published ?? false,
      position: existing.length,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await audit(ctx.db, actor, 'onboarding.create', 'onboarding_doc', d!.id, { title: data.title });
  if (d!.published) await announce(ctx, d!, 'new');
  return d!;
}

export async function updateDoc(ctx: Ctx, actor: ResolvedActor, id: string, input: Partial<z.input<typeof docInput>>) {
  checkAccess(actor, 'onboarding.manage', { companyId: actor.companyId });
  const [before] = await ctx.db.select().from(onboardingDocs).where(and(eq(onboardingDocs.id, id), eq(onboardingDocs.companyId, actor.companyId)));
  if (!before) throw notFound('Hujjat');
  const data = docInput.partial().parse(input);
  await assertDepartments(ctx, actor.companyId, data.departmentIds);
  // Changing what the text says makes earlier "Tanishdim" stale — readers confirm the new version.
  const contentChanged = (data.blocks && canon(withIds(data.blocks)) !== canon(before.blocks)) || (data.title && data.title !== before.title);
  const bump = before.published && contentChanged;
  const [d] = await ctx.db
    .update(onboardingDocs)
    .set({
      ...data,
      ...(data.blocks ? { blocks: withIds(data.blocks) } : {}),
      ...(bump ? { version: before.version + 1 } : {}),
      updatedAt: ctx.now(),
    })
    .where(eq(onboardingDocs.id, id))
    .returning();
  await audit(ctx.db, actor, 'onboarding.update', 'onboarding_doc', id, { title: d!.title, version: d!.version, published: d!.published });
  if (!before.published && d!.published) await announce(ctx, d!, 'new');
  else if (bump) await announce(ctx, d!, 'updated');
  return d!;
}

export async function deleteDoc(ctx: Ctx, actor: ResolvedActor, id: string) {
  checkAccess(actor, 'onboarding.manage', { companyId: actor.companyId });
  const [d] = await ctx.db.delete(onboardingDocs).where(and(eq(onboardingDocs.id, id), eq(onboardingDocs.companyId, actor.companyId))).returning();
  if (!d) throw notFound('Hujjat');
  await audit(ctx.db, actor, 'onboarding.delete', 'onboarding_doc', id, { title: d.title });
}

export async function reorderDocs(ctx: Ctx, actor: ResolvedActor, ids: string[]) {
  checkAccess(actor, 'onboarding.manage', { companyId: actor.companyId });
  const docs = await ctx.db.select({ id: onboardingDocs.id }).from(onboardingDocs).where(eq(onboardingDocs.companyId, actor.companyId));
  const own = new Set(docs.map((d) => d.id));
  await ctx.db.transaction(async (tx) => {
    for (const [i, id] of ids.filter((x) => own.has(x)).entries()) await tx.update(onboardingDocs).set({ position: i }).where(eq(onboardingDocs.id, id));
  });
}

/** "Tanishdim" — the member confirms they read the current version. */
export async function acknowledge(ctx: Ctx, actor: ResolvedActor, id: string) {
  const d = await getDoc(ctx, actor, id);
  if (!d.published) throw notFound('Hujjat');
  const now = ctx.now();
  await ctx.db
    .insert(onboardingAcks)
    .values({ docId: id, userId: actor.userId, version: d.version, ackedAt: now })
    .onConflictDoUpdate({ target: [onboardingAcks.docId, onboardingAcks.userId], set: { version: d.version, ackedAt: now } });
  return { acked: true, version: d.version };
}

async function announce(ctx: Ctx, d: Doc, kind: 'new' | 'updated') {
  const members = await activeMembers(ctx, d.companyId);
  const text = kind === 'new' ? `${d.emoji} <b>Yangi onboarding hujjati</b>\n«${esc(d.title)}» — ilovada o‘qib, «Tanishdim» ni bosing.` : `${d.emoji} <b>Hujjat yangilandi</b>\n«${esc(d.title)}» — o‘zgarishlar bilan qayta tanishib chiqing.`;
  for (const m of members.filter((x) => isFor(d, x.departmentId) && x.userId !== d.createdBy)) {
    await ctx.notifier.direct(m.telegramId, text).catch(() => undefined);
  }
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------------------------------ starter kit

/** A ready handbook for a marketing agency — generic, editable, no real names. */
export async function createStarterKit(ctx: Ctx, actor: ResolvedActor) {
  checkAccess(actor, 'onboarding.manage', { companyId: actor.companyId });
  const company = actor.company;
  const kit: Array<{ title: string; emoji: string; color: string; blocks: z.input<typeof block>[] }> = [
    {
      title: `${company.name} bilan tanishuv`,
      emoji: '👋',
      color: '#34D399',
      blocks: [
        { type: 'heading', text: 'Xush kelibsiz!' },
        { type: 'text', text: `Siz ${company.name} jamoasiga qo‘shildingiz. Bu yerda birinchi haftada bilishingiz kerak bo‘lgan hamma narsa bor.` },
        { type: 'callout', tone: 'info', text: 'Savol tug‘ilsa — bo‘lim boshlig‘ingizga yoki loyiha menejeriga yozing. Savol berish — normal holat.' },
        { type: 'heading', text: 'Biz nima qilamiz' },
        { type: 'text', text: 'Mijozlarimizga SMM, target reklama, kontent ishlab chiqarish (foto/video) va strategiya xizmatlarini ko‘rsatamiz. Har bir loyihaning menejeri va Telegram guruhi bor.' },
        { type: 'heading', text: 'Birinchi hafta' },
        { type: 'checklist', text: '', items: ['Telegram’da botni ishga tushirish (Start)', 'Profil ma’lumotlarini tekshirish', 'Loyiha guruhlariga qo‘shilish', 'Bo‘lim boshlig‘i bilan tanishuv suhbati', 'Birinchi vazifani olish'] },
      ],
    },
    {
      title: 'Ish tartibi va qoidalar',
      emoji: '🕘',
      color: '#7AA7FF',
      blocks: [
        { type: 'heading', text: 'Ish vaqti' },
        { type: 'text', text: `Ish kunlari va vaqti Sozlamalarda ko‘rsatilgan (hozir: ${company.workStart}–${company.workEnd}). Kelganda ilovada «Keldim», ketganda «Ketdim» ni bosing.` },
        { type: 'callout', tone: 'warn', text: 'Kechikish va kelmaslik KPI’dagi «Intizom» ko‘rsatkichiga ta’sir qiladi (15%).' },
        { type: 'heading', text: 'Muloqot' },
        { type: 'checklist', text: '', items: ['Ish masalalari — loyiha guruhida yoki vazifa izohida', 'Shaxsiy savollar — bo‘lim boshlig‘iga', 'Mijoz bilan faqat menejer orqali (agar boshqacha kelishilmagan bo‘lsa)'] },
        { type: 'heading', text: 'Maxfiylik' },
        { type: 'text', text: 'Mijoz materiallari, narxlar va ichki hujjatlar kompaniya tashqarisiga chiqarilmaydi.' },
      ],
    },
    {
      title: 'Vazifalar va KPI qanday ishlaydi',
      emoji: '📈',
      color: '#B69BFF',
      blocks: [
        { type: 'heading', text: 'Vazifa hayoti' },
        { type: 'text', text: 'Yangi → Jarayonda → Tekshiruvda → Bajarildi. Tekshiruvchi qaytarsa — «Qaytarilgan», tuzatib qayta yuborasiz. Har bir qaytarish — yangi raund (R2, R3…).' },
        { type: 'callout', tone: 'info', text: 'Deadline’ga 24 va 2 soat qolganda bot eslatadi. Muddat o‘tsa — 3 marta eslatma, keyin loyiha menejeriga, keyin CEO’ga xabar boradi.' },
        { type: 'heading', text: 'KPI — hamma uchun bir xil' },
        { type: 'checklist', text: '', items: ['Deadline (50%) — vazifalar o‘z vaqtida topshirilgani', 'Hajm (35%) — rejadagi ballar bajarilgani', 'Intizom (15%) — o‘z vaqtida kelgan ish kunlari'] },
        { type: 'text', text: 'Bonus koeffitsienti: 90+ → 1.0, 75+ → 0.8, 60+ → 0.5, undan past → 0. Hammasi avtomatik hisoblanadi.' },
      ],
    },
  ];
  const made = [];
  for (const k of kit) made.push(await createDoc(ctx, actor, { ...k, published: false }));
  return made;
}
