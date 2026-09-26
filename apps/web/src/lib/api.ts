export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'rt.token';
const COMPANY_KEY = 'rt.company';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* storage may be unavailable */
  }
}

export const session = {
  token: read(TOKEN_KEY),
  companyId: read(COMPANY_KEY),
  setToken(t: string | null) {
    this.token = t;
    write(TOKEN_KEY, t);
  },
  setCompany(id: string | null) {
    this.companyId = id;
    write(COMPANY_KEY, id);
  },
};

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
  const qs = init.query
    ? '?' +
      Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (session.companyId) headers['x-company-id'] = session.companyId;
  const res = await fetch(`${BASE}/api${path}${qs}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? 'Xatolik');
  return data as T;
}
