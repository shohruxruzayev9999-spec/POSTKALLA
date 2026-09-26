import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import type { AppContext, CompanyRef, Scope, User } from '../lib/types';
import { applyChrome, haptic, tg } from '../lib/tg';

// ---------------------------------------------------------------- router (hash based)
export type Route = { name: string; id?: string };

function parse(): Route {
  const [name = 'home', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'home', id };
}
const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
let cached = parse();
let cachedHash = location.hash;
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => {
    if (location.hash !== cachedHash) {
      cachedHash = location.hash;
      cached = parse();
    }
    return cached;
  });
}
export function go(name: string, id?: string) {
  location.hash = `/${name}${id ? `/${id}` : ''}`;
}

// ---------------------------------------------------------------- theme
type Theme = 'dark' | 'light';
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('rt.theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* ignore */
  }
  if (tg) return tg.colorScheme;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ---------------------------------------------------------------- app state
interface Session {
  user: User;
  companies: CompanyRef[];
  ctx: AppContext;
}

interface State {
  session: Session;
  theme: Theme;
  setTheme(t: Theme): void;
  toast(msg: string, kind?: 'ok' | 'error'): void;
  fail(e: unknown): void;
  /** UI hint only — the server checks again. */
  can(action: string, scope?: Scope): boolean;
  isManager: boolean;
  switchCompany(id: string): void;
}

const Ctx = createContext<State | null>(null);

export function useApp(): State {
  const s = useContext(Ctx);
  if (!s) throw new Error('no app state');
  return s;
}

export function useThemeBoot() {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyChrome(theme);
  }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem('rt.theme', t);
    } catch {
      /* ignore */
    }
  }, []);
  return { theme, setTheme };
}

export function AppProvider({ session, theme, setTheme, onSwitchCompany, children }: { session: Session; theme: Theme; setTheme(t: Theme): void; onSwitchCompany(id: string): void; children: ReactNode }) {
  const [toastState, setToast] = useState<{ msg: string; kind: 'ok' | 'error'; key: number } | null>(null);
  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    haptic(kind === 'ok' ? 'success' : 'error');
    setToast({ msg, kind, key: Date.now() });
  }, []);
  useEffect(() => {
    if (!toastState) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toastState]);

  const value = useMemo<State>(() => {
    const perms = session.ctx.permissions;
    const can = (action: string, scope?: Scope) => {
      const s = perms[action] ?? [];
      return scope ? s.includes(scope) : s.length > 0;
    };
    return {
      session,
      theme,
      setTheme,
      toast,
      fail: (e: unknown) => toast(e instanceof ApiError ? e.message : 'Tarmoq xatosi. Qayta urinib ko‘ring', 'error'),
      can,
      isManager: ['OWNER', 'ADMIN', 'HR', 'PM', 'DEPT_HEAD', 'FINANCE'].some((r) => session.ctx.roles.includes(r)),
      switchCompany: onSwitchCompany,
    };
  }, [session, theme, setTheme, toast, onSwitchCompany]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {toastState && (
        <div key={toastState.key} className={`toast ${toastState.kind === 'error' ? 'error' : ''}`} role="status">
          {toastState.msg}
        </div>
      )}
    </Ctx.Provider>
  );
}
