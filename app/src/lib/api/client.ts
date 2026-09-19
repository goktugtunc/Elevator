import { env } from '@/lib/env';
import { STORAGE_KEYS, secureStorage } from '@/lib/storage';

/**
 * Backend HTTP istemcisi. Tüm çağrılar JSON; JWT varsa Authorization başlığına eklenir.
 * Endpoint listesi: ./endpoints.ts (gelistirme-notlari §3.6 ile birebir).
 *
 * 401 gelirse `authBridge` üzerinden bir kez SEP-10 yenilemesi denenir (FE-04);
 * yenileme başarısızsa oturum kapatılır ve hata ekrana düşer.
 */
export class ApiError extends Error {
  constructor(
    /** HTTP durum kodu; 0 = ağ hatası (sunucuya hiç ulaşılamadı). */
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Oturum store'u ile istemci arasındaki köprü (döngüsel import olmasın diye).
 * `session.ts` uygulama açılışında kendini kaydeder.
 */
export interface AuthBridge {
  /** 401 sonrası yeni JWT almayı dener; alınamazsa null. */
  refresh(): Promise<string | null>;
  /** Yenileme başarısız oldu → oturumu kapat, girişe yönlendir. */
  onSessionExpired(): void;
}

let authBridge: AuthBridge | null = null;

export function registerAuthBridge(bridge: AuthBridge): void {
  authBridge = bridge;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | undefined>;
  /** İçeride kullanılır: 401 sonrası tekrar denemede sonsuz döngüyü engeller. */
  retried?: boolean;
}

async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, query, retried = false } = options;
  const url = new URL(path, env.apiBaseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const jwt = await secureStorage.get(STORAGE_KEYS.jwt);
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : `${method} ${path} başarısız`);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (res.status === 401 && auth && !retried && authBridge) {
    const token = await authBridge.refresh().catch(() => null);
    if (token) return request<T>(method, path, { ...options, retried: true });
    authBridge.onSessionExpired();
  }

  if (!res.ok) {
    const serverMessage =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : '';
    const message = serverMessage || `${method} ${path} → ${res.status}`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const http = {
  get: <T>(path: string, query?: Record<string, string | number | undefined>, auth = true) =>
    request<T>('GET', path, { query, auth }),
  post: <T>(path: string, body?: unknown, auth = true) => request<T>('POST', path, { body, auth }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
