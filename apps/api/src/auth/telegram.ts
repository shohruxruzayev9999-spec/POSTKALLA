import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@retarget/shared';
import { eq } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
}

export interface InitData {
  user: TelegramUser;
  startParam: string | null;
  authDate: Date;
}

/**
 * Validates Telegram Mini App init data (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * The hash proves the data came from Telegram for *our* bot; auth_date limits replay.
 */
export function verifyInitData(raw: string, botToken: string, now = new Date(), maxAgeSec = 24 * 3600): InitData {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) throw new DomainError('UNAUTHORIZED', 'initData hash yo‘q');
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheck).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new DomainError('UNAUTHORIZED', 'initData imzosi noto‘g‘ri');
  }
  const authDate = new Date(Number(params.get('auth_date') ?? 0) * 1000);
  if (now.getTime() - authDate.getTime() > maxAgeSec * 1000) throw new DomainError('UNAUTHORIZED', 'initData eskirgan');
  const userJson = params.get('user');
  if (!userJson) throw new DomainError('UNAUTHORIZED', 'initData user yo‘q');
  return { user: JSON.parse(userJson) as TelegramUser, startParam: params.get('start_param'), authDate };
}

/** Test helper: produce init data signed like Telegram would. */
export function signInitData(user: TelegramUser, botToken: string, authDate = new Date(), startParam?: string): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(authDate.getTime() / 1000)));
  params.set('user', JSON.stringify(user));
  if (startParam) params.set('start_param', startParam);
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}

export async function upsertTelegramUser(db: Db, tg: TelegramUser) {
  const values = {
    telegramId: tg.id,
    firstName: tg.first_name.slice(0, 64),
    lastName: tg.last_name?.slice(0, 64) ?? null,
    username: tg.username ?? null,
    photoUrl: tg.photo_url ?? null,
  };
  const [u] = await db
    .insert(users)
    .values({ ...values, language: tg.language_code === 'ru' ? 'ru' : tg.language_code === 'en' ? 'en' : 'uz', canDm: !!tg.allows_write_to_pm })
    .onConflictDoUpdate({
      target: users.telegramId,
      // canDm only ever goes up here; the bot lowers it when Telegram says the user blocked it.
      set: { ...values, ...(tg.allows_write_to_pm ? { canDm: true } : {}) },
    })
    .returning();
  return u!;
}

export async function findUserByTelegram(db: Db, telegramId: number) {
  const [u] = await db.select().from(users).where(eq(users.telegramId, telegramId));
  return u ?? null;
}

const enc = (s: string) => new TextEncoder().encode(s);

export async function issueToken(userId: string, secret: string, ttlSec = 7 * 24 * 3600): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(enc(secret));
}

export async function verifyToken(token: string, secret: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('no sub');
    return payload.sub;
  } catch {
    throw new DomainError('UNAUTHORIZED', 'Sessiya tugagan, qayta kiring');
  }
}

/**
 * Short-lived token for one purpose (e.g. opening a report PDF by link). Signed with a key derived
 * from the purpose, so it can never be used as a session token and vice versa.
 */
export async function issuePurposeToken(purpose: string, userId: string, claims: Record<string, unknown>, secret: string, ttlSec = 600): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(enc(`${secret}:${purpose}`));
}

export async function verifyPurposeToken(purpose: string, token: string, secret: string): Promise<{ sub: string } & Record<string, unknown>> {
  try {
    const { payload } = await jwtVerify(token, enc(`${secret}:${purpose}`), { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('no sub');
    return payload as { sub: string } & Record<string, unknown>;
  } catch {
    throw new DomainError('UNAUTHORIZED', 'Havola eskirgan — hisobotni qaytadan oching');
  }
}
