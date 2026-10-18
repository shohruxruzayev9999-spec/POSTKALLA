import { ApiError } from './api';

/**
 * Read-only demo build (VITE_DEMO=1): answers API calls from responses recorded against a seeded
 * dev server and injected as window.__DEMO_DATA__. Changes are refused — nothing is saved.
 */
type Recorded = Record<string, { status: number; body: unknown }>;
const data = ((window as unknown as { __DEMO_DATA__?: Recorded }).__DEMO_DATA__ ?? {}) as Recorded;

export async function demoApi<T>(method: string, path: string, qs: string): Promise<T> {
  if (method !== 'GET' && path !== '/auth/dev') throw new ApiError(400, 'DEMO', 'Bu demo: o‘zgarishlar saqlanmaydi');
  const exact = data[`${method} ${path}${qs}`];
  const loose = exact ?? Object.entries(data).find(([k]) => k.split('?')[0] === `${method} ${path}`)?.[1];
  if (!loose || loose.status >= 400) throw new ApiError(404, 'DEMO', 'Demo’da bu ma’lumot yo‘q');
  return structuredClone(loose.body) as T;
}
