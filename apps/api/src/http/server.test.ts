import { describe, expect, it } from 'vitest';
import { signInitData, verifyInitData } from '../auth/telegram.js';
import { agency } from '../test/fixtures.js';
import { buildServer } from './server.js';

const BOT = '123456:TEST_TOKEN';
const cfg = { botToken: BOT, botUsername: 'retarget_test_bot', jwtSecret: 'x'.repeat(40), corsOrigins: [], devLogin: false };

describe('Telegram initData', () => {
  it('accepts genuine data and rejects forged or stale data', () => {
    const raw = signInitData({ id: 42, first_name: 'Ali' }, BOT);
    expect(verifyInitData(raw, BOT).user.id).toBe(42);
    expect(() => verifyInitData(raw, '999:OTHER')).toThrow(/imzosi/);
    const forged = raw.replace('Ali', 'Vali');
    expect(() => verifyInitData(forged, BOT)).toThrow(/imzosi/);
    const old = signInitData({ id: 42, first_name: 'Ali' }, BOT, new Date(Date.now() - 2 * 86_400_000));
    expect(() => verifyInitData(old, BOT)).toThrow(/eskirgan/);
  });
});

describe('HTTP API', () => {
  it('login → company → invite → join → role limits, end to end', async () => {
    const a = await agency(new Date());
    const app = buildServer(a.ctx, cfg);
    const login = async (id: number, name: string, startParam?: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/telegram', payload: { initData: signInitData({ id, first_name: name, allows_write_to_pm: true }, BOT, new Date(), startParam) } });
      expect(r.statusCode).toBe(200);
      return r.json() as { token: string; user: { id: string }; startParam: string | null };
    };

    const boss = await login(777, 'Boss');
    const H = (t: string, companyId?: string) => ({ authorization: `Bearer ${t}`, ...(companyId ? { 'x-company-id': companyId } : {}) });
    const company = (await app.inject({ method: 'POST', url: '/api/companies', headers: H(boss.token), payload: { name: 'Nova Agency' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/invitations', headers: H(boss.token, company.id), payload: { role: 'EMPLOYEE' } })).json();
    expect(inv.link).toBe(`https://t.me/retarget_test_bot?startapp=inv_${inv.token}`);

    const emp = await login(888, 'Emp', `inv_${inv.token}`);
    expect(emp.startParam).toBe(`inv_${inv.token}`);
    const joined = await app.inject({ method: 'POST', url: `/api/invitations/${inv.token}/accept`, headers: H(emp.token) });
    expect(joined.json()).toMatchObject({ companyId: company.id, alreadyMember: false });

    // The employee tries to make themself owner through the API.
    const hack = await app.inject({ method: 'PATCH', url: `/api/members/${emp.user.id}`, headers: H(emp.token, company.id), payload: { roles: ['OWNER'] } });
    expect(hack.statusCode).toBe(403);

    // … and cannot read another company.
    const other = await app.inject({ method: 'GET', url: '/api/members', headers: H(emp.token, a.company.id) });
    expect(other.statusCode).toBe(403);

    const ctxRes = (await app.inject({ method: 'GET', url: '/api/context', headers: H(emp.token, company.id) })).json();
    expect(ctxRes.roles).toEqual(['EMPLOYEE']);
    expect(ctxRes.permissions['finance.view']).toEqual([]);

    const noAuth = await app.inject({ method: 'GET', url: '/api/me' });
    expect(noAuth.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/tasks', headers: H(boss.token, company.id), payload: { title: '' } });
    expect(bad.statusCode).toBe(422);
    await app.close();
  });
});
