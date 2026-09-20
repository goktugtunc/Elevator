import { env } from '@/lib/env';
import { debugError, debugLog } from '@/lib/log';
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
    /** Sunucunun makine okunur hata kodu (ör. "http_error", "validation_error"). */
    public readonly code?: string,
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

/** Sunucu boolean sorgu parametreleri de alıyor (unread_only, refresh, movements…). */
export type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  body?: unknown;
  auth?: boolean;
  query?: QueryParams;
  /** İçeride kullanılır: 401 sonrası tekrar denemede sonsuz döngüyü engeller. */
  retried?: boolean;
  /** İçeride kullanılır: ağ hatasında yalnızca bir kez yeniden denenir. */
  networkRetried?: boolean;
}

async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, query, retried = false, networkRetried = false } = options;
  // Not: `new URL(path, base)` taban yolundaki öneki (/api/v1) yutar; elle birleştiriyoruz.
  const url = new URL(`${env.apiBaseUrl.replace(/\/+$/, '')}${path}`);
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
    // Cüzdan uygulamasından dönüldüğü anda Android ilk isteği düzenli olarak
    // "UnknownHostException" ile düşürüyor; ağ birkaç yüz milisaniye sonra
    // geri geliyor. Tek bir yeniden deneme, imzalanmış işlemin gönderiminin
    // bu yüzden kaybolmasını engelliyor. İkinci kez düşerse hata gerçektir.
    if (!networkRetried) {
      debugLog('api', `${method} ${url.pathname} — ağ düştü, bir kez yeniden deneniyor`);
      await new Promise((r) => setTimeout(r, 600));
      return request<T>(method, path, { ...options, networkRetried: true });
    }
    debugError('api', `${method} ${url.pathname} — sunucuya ulaşılamadı`, err);
    throw new ApiError(0, err instanceof Error ? err.message : `${method} ${path} failed`);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;

  if (res.status === 401 && auth && !retried && authBridge) {
    const token = await authBridge.refresh().catch(() => null);
    if (token) return request<T>(method, path, { ...options, retried: true });
    authBridge.onSessionExpired();
  }

  if (!res.ok) {
    const envelope = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const serverMessage = envelope && 'message' in envelope ? String(envelope.message) : '';
    const code = envelope && typeof envelope.code === 'string' ? envelope.code : undefined;
    const message = serverMessage || `${method} ${path} → ${res.status}`;
    debugError(
      'api',
      `${method} ${url.pathname} → ${res.status}`,
      new ApiError(res.status, message, data, code),
    );
    throw new ApiError(res.status, message, data, code);
  }
  debugLog('api', `${method} ${url.pathname} → ${res.status}`);
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
  get: <T>(path: string, query?: QueryParams, auth = true) =>
    request<T>('GET', path, { query, auth }),
  post: <T>(path: string, body?: unknown, auth = true) => request<T>('POST', path, { body, auth }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
