import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, session as store } from './lib/api';
import type { AppContext, CompanyRef, User } from './lib/types';
import { tg } from './lib/tg';
import { Home } from './pages/Home';
import { Onboarding } from './pages/Onboarding';
import { InviteAccept } from './pages/InviteAccept';
import { Attendance } from './pages/Attendance';
import { MemberProfile } from './pages/MemberProfile';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';
import { Tasks } from './pages/Tasks';
import { Team } from './pages/Team';
import { Icon, Ring } from './ui/kit';
import { AppProvider, go, useApp, useRoute, useThemeBoot } from './ui/state';

interface AuthResult {
  token: string;
  user: User;
  companies: CompanyRef[];
  startParam: string | null;
}

type Boot =
  | { stage: 'loading' }
  | { stage: 'outside' }
  | { stage: 'error'; message: string }
  | { stage: 'ready'; user: User; companies: CompanyRef[]; startParam: string | null };

async function authenticate(): Promise<Boot> {
  if (tg) {
    const r = await api<AuthResult>('/auth/telegram', { method: 'POST', body: { initData: tg.initData } });
    store.setToken(r.token);
    return { stage: 'ready', user: r.user, companies: r.companies, startParam: r.startParam };
  }
  const dev = new URLSearchParams(location.search).get('dev');
  if (dev && import.meta.env.DEV) {
    const r = await api<AuthResult>('/auth/dev', { method: 'POST', body: { telegramId: Number(dev), firstName: `Dev ${dev}` } });
    store.setToken(r.token);
    return { stage: 'ready', user: r.user, companies: r.companies, startParam: new URLSearchParams(location.search).get('start') };
  }
  if (store.token) {
    try {
      const r = await api<{ user: User; companies: CompanyRef[] }>('/me');
      return { stage: 'ready', ...r, startParam: null };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) store.setToken(null);
      else throw e;
    }
  }
  return { stage: 'outside' };
}

export function App() {
  const { theme, setTheme } = useThemeBoot();
  const [boot, setBoot] = useState<Boot>({ stage: 'loading' });
  const [invite, setInvite] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const qc = useQueryClient();

  const start = useCallback(async () => {
    try {
      const b = await authenticate();
      setBoot(b);
      if (b.stage !== 'ready') return;
      if (b.startParam?.startsWith('inv_')) setInvite(b.startParam.slice(4));
      if (b.startParam?.startsWith('task_')) go('tasks', b.startParam.slice(5));
      const active = b.companies.filter((c) => c.status === 'ACTIVE');
      const pick = active.find((c) => c.id === store.companyId) ?? active[0];
      store.setCompany(pick?.id ?? null);
      setCompanyId(pick?.id ?? null);
    } catch (e) {
      setBoot({ stage: 'error', message: e instanceof Error ? e.message : 'Xatolik' });
    }
  }, []);
  useEffect(() => void start(), [start]);

  const ctxQuery = useQuery({
    queryKey: ['context', companyId],
    queryFn: () => api<AppContext>('/context'),
    enabled: boot.stage === 'ready' && !!companyId,
  });

  const switchCompany = useCallback(
    (id: string) => {
      store.setCompany(id);
      qc.clear();
      setCompanyId(id);
      go('home');
    },
    [qc],
  );

  const reloadCompanies = useCallback(async (selectId?: string) => {
    const r = await api<{ user: User; companies: CompanyRef[] }>('/me');
    setBoot((b) => (b.stage === 'ready' ? { ...b, companies: r.companies, user: r.user } : b));
    if (selectId) switchCompany(selectId);
  }, [switchCompany]);

  if (boot.stage === 'loading' || (boot.stage === 'ready' && companyId && ctxQuery.isPending)) return <Splash />;
  if (boot.stage === 'outside') return <Outside />;
  if (boot.stage === 'error') return <Splash error={boot.message} onRetry={start} />;

  if (invite) {
    return (
      <InviteAccept
        token={invite}
        onDone={async (joinedCompanyId) => {
          setInvite(null);
          await reloadCompanies(joinedCompanyId ?? undefined);
        }}
      />
    );
  }
  if (!companyId) return <Onboarding user={boot.user} onCreated={(id) => reloadCompanies(id)} />;
  if (ctxQuery.isError) return <Splash error={(ctxQuery.error as Error).message} onRetry={() => ctxQuery.refetch()} />;

  return (
    <AppProvider session={{ user: boot.user, companies: boot.companies, ctx: ctxQuery.data! }} theme={theme} setTheme={setTheme} onSwitchCompany={switchCompany}>
      <Shell />
    </AppProvider>
  );
}

const NAV = [
  { name: 'home', label: 'Bosh', icon: 'home' },
  { name: 'tasks', label: 'Vazifalar', icon: 'tasks' },
  { name: 'projects', label: 'Loyihalar', icon: 'folder' },
  { name: 'team', label: 'Jamoa', icon: 'team' },
  { name: 'attendance', label: 'Davomat', icon: 'clock' },
];

function Shell() {
  const route = useRoute();
  const { session, can } = useApp();
  const nav = [...NAV, ...(can('settings.company') || can('settings.department') ? [{ name: 'settings', label: 'Sozlamalar', icon: 'settings' }] : [])];
  const page = (() => {
    switch (route.name) {
      case 'tasks':
        return <Tasks openId={route.id} />;
      case 'projects':
        return <Projects />;
      case 'team':
        return <Team openId={route.id} />;
      case 'profile':
        return <MemberProfile userId={session.user.id} />;
      case 'attendance':
        return <Attendance />;
      case 'settings':
        return <Settings />;
      default:
        return <Home />;
    }
  })();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Ring value={72} size={30} stroke={5}>
            <span />
          </Ring>
          <div className="grow">
            <div className="ellipsis">{session.ctx.company.name}</div>
            <div className="xs muted">Retarget ERP</div>
          </div>
        </div>
        {nav.map((n) => (
          <button key={n.name} className={route.name === n.name ? 'on' : ''} onClick={() => go(n.name)}>
            <Icon name={n.icon} /> {n.label}
          </button>
        ))}
      </aside>
      <main className="main">{page}</main>
      <nav className="tabbar">
        {NAV.map((n) => (
          <button key={n.name} className={route.name === n.name ? 'on' : ''} onClick={() => go(n.name)}>
            <Icon name={n.icon} size={22} />
            {n.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Splash({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 24, textAlign: 'center' }}>
      <Ring value={error ? 0 : 68} size={84} stroke={9}>
        <span />
      </Ring>
      <div className="xb" style={{ fontSize: 20 }}>Retarget ERP</div>
      {error ? (
        <>
          <div className="muted">{error}</div>
          <button className="btn primary" onClick={onRetry}>Qayta urinish</button>
        </>
      ) : (
        <div className="muted small">Yuklanmoqda…</div>
      )}
    </div>
  );
}

function Outside() {
  const bot = import.meta.env.VITE_BOT_USERNAME as string | undefined;
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center', maxWidth: 420, margin: '0 auto' }}>
      <Ring value={86} size={120}>
        <div className="grad-text xb" style={{ fontSize: 26 }}>ERP</div>
      </Ring>
      <h1 className="page-title">Retarget ERP</h1>
      <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
        Vazifalar, deadline eslatmalari, KPI, davomat va loyihalar — hammasi Telegram ichida. Ilova Telegram orqali ochiladi.
      </p>
      {bot && (
        <a className="btn primary" href={`https://t.me/${bot}`}>
          Telegramda ochish
        </a>
      )}
    </div>
  );
}
