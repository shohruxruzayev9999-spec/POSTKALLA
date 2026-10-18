import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, session as store } from './lib/api';
import type { AppContext, CompanyRef, MyJoinStatus, User } from './lib/types';
import { tg } from './lib/tg';
import { Home } from './pages/Home';
import { Onboarding } from './pages/Onboarding';
import { InviteAccept } from './pages/InviteAccept';
import { Attendance } from './pages/Attendance';
import { MemberProfile } from './pages/MemberProfile';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';
import { Shoots } from './pages/Shoots';
import { Section } from './pages/Section';
import { Finance } from './pages/Finance';
import { OnboardingDocs } from './pages/OnboardingDocs';
import { Reports } from './pages/Reports';
import { Digest } from './pages/Digest';
import { Billing } from './pages/Billing';
import { Tasks } from './pages/Tasks';
import { Team } from './pages/Team';
import { Icon, Ring } from './ui/kit';
import { AppProvider, go, useApp, useRoute, useThemeBoot } from './ui/state';

interface AuthResult {
  token: string;
  user: User;
  companies: CompanyRef[];
  joinRequests?: MyJoinStatus[];
  startParam: string | null;
}

type Boot =
  | { stage: 'loading' }
  | { stage: 'outside' }
  | { stage: 'error'; message: string }
  | { stage: 'ready'; user: User; companies: CompanyRef[]; joinRequests?: MyJoinStatus[]; startParam: string | null };

async function authenticate(): Promise<Boot> {
  if (tg) {
    const r = await api<AuthResult>('/auth/telegram', { method: 'POST', body: { initData: tg.initData } });
    store.setToken(r.token);
    return { stage: 'ready', user: r.user, companies: r.companies, joinRequests: r.joinRequests, startParam: r.startParam };
  }
  const dev = new URLSearchParams(location.search).get('dev');
  if (dev && import.meta.env.DEV) {
    const r = await api<AuthResult>('/auth/dev', { method: 'POST', body: { telegramId: Number(dev), firstName: `Dev ${dev}` } });
    store.setToken(r.token);
    return { stage: 'ready', user: r.user, companies: r.companies, joinRequests: r.joinRequests, startParam: new URLSearchParams(location.search).get('start') };
  }
  if (store.token) {
    try {
      const r = await api<{ user: User; companies: CompanyRef[]; joinRequests?: MyJoinStatus[] }>('/me');
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
  const [creatingCompany, setCreatingCompany] = useState(false);
  const qc = useQueryClient();

  const start = useCallback(async () => {
    try {
      const b = await authenticate();
      setBoot(b);
      if (b.stage !== 'ready') return;
      if (b.startParam?.startsWith('inv_')) setInvite(b.startParam.slice(4));
      if (b.startParam?.startsWith('task_')) go('tasks', b.startParam.slice(5));
      if (b.startParam === 'digest') go('digest');
      if (b.startParam === 'join_requests') go('team');
      if (b.startParam === 'billing') go('billing');
      if (b.startParam?.startsWith('rep_')) go('reports', b.startParam.slice(4));
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
  if (!companyId && !creatingCompany) return <NotInTeam requests={boot.joinRequests ?? []} onRecheck={start} onCreate={() => setCreatingCompany(true)} />;
  if (!companyId) return <Onboarding user={boot.user} onCreated={(id) => reloadCompanies(id)} />;
  if (ctxQuery.isError) return <Splash error={(ctxQuery.error as Error).message} onRetry={() => ctxQuery.refetch()} />;

  return (
    <AppProvider session={{ user: boot.user, companies: boot.companies, ctx: ctxQuery.data! }} theme={theme} setTheme={setTheme} onSwitchCompany={switchCompany}>
      <Shell />
    </AppProvider>
  );
}

interface NavItem {
  name: string;
  label: string;
  icon: string;
  section: 'main' | 'work' | 'admin';
  when?: (can: (a: string, s?: never) => boolean, ctx: { roles: string[]; headOfDepartmentIds: string[] }) => boolean;
}

/** Every section of the app. The sidebar shows them all; the phone tab bar shows the first four + "Ko'proq". */
export const NAV: NavItem[] = [
  { name: 'home', label: 'Bosh', icon: 'home', section: 'main' },
  { name: 'tasks', label: 'Vazifalar', icon: 'tasks', section: 'main' },
  { name: 'projects', label: 'Loyihalar', icon: 'folder', section: 'main' },
  { name: 'team', label: 'Jamoa', icon: 'team', section: 'main' },
  { name: 'attendance', label: 'Davomat', icon: 'clock', section: 'main' },
  { name: 'digest', label: 'AI tahlil', icon: 'sparkle', section: 'main', when: (_can, ctx) => ctx.roles.some((r) => ['OWNER', 'ADMIN', 'PM', 'MARKETER'].includes(r)) || ctx.headOfDepartmentIds.length > 0 },
  { name: 'design', label: 'Dizayn', icon: 'palette', section: 'work' },
  { name: 'media', label: 'Media', icon: 'film', section: 'work' },
  { name: 'shoots', label: 'Syomka', icon: 'camera', section: 'work' },
  { name: 'reports', label: 'Hisobotlar', icon: 'report', section: 'admin' },
  { name: 'onboarding', label: 'Onboarding', icon: 'book', section: 'admin' },
  { name: 'finance', label: 'Moliya', icon: 'wallet', section: 'admin', when: (can) => can('finance.view') },
  { name: 'billing', label: 'Obuna', icon: 'crown', section: 'admin', when: (can) => can('billing.manage') },
  { name: 'settings', label: 'Sozlamalar', icon: 'settings', section: 'admin', when: (can) => can('settings.company') || can('settings.department') },
];
const TABS = ['home', 'tasks', 'projects', 'team'];
const SECTION_LABEL = { main: '', work: 'Ishlab chiqarish', admin: 'Boshqaruv' } as const;

function Shell() {
  const route = useRoute();
  const { session, can } = useApp();
  const nav = NAV.filter((n) => !n.when || n.when(can as never, session.ctx));
  const page = (() => {
    switch (route.name) {
      case 'tasks':
        return <Tasks openId={route.id} />;
      case 'projects':
        return <Projects key={route.id ?? "list"} projectId={route.id} />;
      case 'team':
        return <Team openId={route.id} />;
      case 'profile':
        return <MemberProfile userId={session.user.id} />;
      case 'attendance':
        return <Attendance />;
      case 'shoots':
        return <Shoots />;
      case 'design':
        return <Section key="design" section="DESIGN" openId={route.id} />;
      case 'media':
        return <Section key="media" section="MEDIA" openId={route.id} />;
      case 'finance':
        return <Finance />;
      case 'billing':
        return <Billing />;
      case 'digest':
        return <Digest />;
      case 'reports':
        return <Reports key={route.id ?? 'all'} projectId={route.id} />;
      case 'onboarding':
        return <OnboardingDocs openId={route.id} />;
      case 'settings':
        return <Settings />;
      case 'more':
        return <More items={nav.filter((n) => !TABS.includes(n.name))} />;
      default:
        return <Home />;
    }
  })();
  const inMore = !TABS.includes(route.name) && route.name !== '' && route.name !== 'home';
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
        {(['main', 'work', 'admin'] as const).map((sec) => {
          const items = nav.filter((n) => n.section === sec);
          if (!items.length) return null;
          return (
            <div key={sec} className="stack" style={{ gap: 4 }}>
              {SECTION_LABEL[sec] && <div className="sidebar-sec">{SECTION_LABEL[sec]}</div>}
              {items.map((n) => (
                <button key={n.name} className={route.name === n.name ? 'on' : ''} onClick={() => go(n.name)}>
                  <Icon name={n.icon} /> {n.label}
                </button>
              ))}
            </div>
          );
        })}
      </aside>
      <main className="main">{page}</main>
      <nav className="tabbar">
        {nav
          .filter((n) => TABS.includes(n.name))
          .map((n) => (
            <button key={n.name} className={route.name === n.name || (n.name === 'home' && !route.name) ? 'on' : ''} onClick={() => go(n.name)}>
              <Icon name={n.icon} size={22} />
              {n.label}
            </button>
          ))}
        <button className={inMore ? 'on' : ''} onClick={() => go('more')}>
          <Icon name="grid" size={22} />
          Ko'proq
        </button>
      </nav>
    </div>
  );
}

function More({ items }: { items: NavItem[] }) {
  const { session, theme, setTheme } = useApp();
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1 className="page-title">Ko'proq</h1>
      <button className="card row" style={{ gap: 12, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => go('profile')}>
        <Icon name="user" size={22} />
        <div className="grow">
          <div className="b">Mening profilim</div>
          <div className="xs muted">KPI, davomat, vazifalar</div>
        </div>
        <Icon name="chevron" size={18} />
      </button>
      <div className="more-grid">
        {items.map((n) => (
          <button key={n.name} className="more-tile" onClick={() => go(n.name)}>
            <span className="more-ic"><Icon name={n.icon} size={22} /></span>
            <span className="b small">{n.label}</span>
          </button>
        ))}
      </div>
      <div className="card row between">
        <div>
          <div className="b">Mavzu</div>
          <div className="xs muted">{session.ctx.company.name}</div>
        </div>
        <div className="seg" style={{ width: 170 }}>
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>Tungi</button>
          <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>Kunduzgi</button>
        </div>
      </div>
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


/**
 * No self-registration: someone with no company sees whether a join request is waiting, or how
 * to get in through a team group. Company owners can still open a new company from here.
 */
function NotInTeam({ requests, onRecheck, onCreate }: { requests: MyJoinStatus[]; onRecheck: () => void; onCreate: () => void }) {
  const pending = requests.find((r) => r.status === 'PENDING');
  const rejected = !pending && requests.some((r) => r.status === 'REJECTED');
  const title = pending ? 'So‘rovingiz tasdiqlanmoqda' : rejected ? 'So‘rovingiz rad etildi' : 'Hozircha loyihada emassiz';
  const text = pending
    ? `Bot sizni «${pending.group ?? pending.company}» guruhidan topdi. Rahbar tasdiqlagach vazifa va loyihalaringiz shu yerda paydo bo‘ladi, Telegram’ga xabar keladi.`
    : rejected
      ? 'Rahbaringiz so‘rovni tasdiqlamadi. Savol bo‘lsa, unga murojaat qiling yoki guruhdagi tugmani qayta bosing.'
      : 'Rahbaringizdan sizni ishchi Telegram guruhiga qo‘shishini so‘rang, keyin guruhdagi «POSTKALLA’ga qo‘shilish» tugmasini bosing.';
  return (
    <div className="main" style={{ maxWidth: 460, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100%' }}>
      <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', gap: 14, padding: 24 }}>
        <Ring value={pending ? 35 : 0} size={84} stroke={9} tone={pending ? 'amber' : 'green'} />
        <div className="xb" style={{ fontSize: 19 }}>{title}</div>
        <div className="small muted" style={{ lineHeight: 1.6 }}>{text}</div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="btn primary" onClick={onRecheck}>Qayta tekshirish</button>
          {!pending && <button className="btn" onClick={onCreate}>Kompaniyamni ochish</button>}
        </div>
      </div>
    </div>
  );
}
