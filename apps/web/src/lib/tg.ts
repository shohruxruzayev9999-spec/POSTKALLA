/** Thin, optional wrapper around Telegram.WebApp — the app also runs in a normal browser (dev, desktop). */
interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name: string } };
  colorScheme: 'light' | 'dark';
  platform: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  requestWriteAccess?(cb?: (ok: boolean) => void): void;
  disableVerticalSwipes?(): void;
  HapticFeedback?: { impactOccurred(s: 'light' | 'medium' | 'heavy'): void; notificationOccurred(t: 'success' | 'error' | 'warning'): void };
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  LocationManager?: {
    isInited: boolean;
    isLocationAvailable: boolean;
    init(cb?: () => void): void;
    getLocation(cb: (loc: { latitude: number; longitude: number } | null) => void): void;
  };
  onEvent(e: string, cb: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TgWebApp };
  }
}

export const tg: TgWebApp | null = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;

export function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
}

export function haptic(kind: 'light' | 'success' | 'error' = 'light') {
  const h = tg?.HapticFeedback;
  if (!h) return;
  if (kind === 'light') h.impactOccurred('light');
  else h.notificationOccurred(kind);
}

export function applyChrome(theme: 'dark' | 'light') {
  const color = theme === 'dark' ? '#07090A' : '#F5F5F7';
  tg?.setHeaderColor?.(color);
  tg?.setBackgroundColor?.(color);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export function shareLink(url: string, text: string) {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (tg) tg.openTelegramLink(share);
  else if (navigator.share) void navigator.share({ url, text }).catch(() => undefined);
  else void navigator.clipboard?.writeText(url);
}

/** Location from Telegram's LocationManager, falling back to the browser. */
export function getLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    const lm = tg?.LocationManager;
    const browser = () => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 12_000 },
      );
    };
    if (!lm) return browser();
    const ask = () =>
      lm.isLocationAvailable ? lm.getLocation((l) => resolve(l ? { lat: l.latitude, lng: l.longitude } : null)) : browser();
    if (lm.isInited) ask();
    else lm.init(ask);
  });
}
