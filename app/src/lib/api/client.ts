import { env } from '@/lib/env';
import { STORAGE_KEYS, secureStorage } from '@/lib/storage';

/**
 * Backend HTTP istemcisi. Tüm çağrılar JSON; JWT varsa Authorization başlığına eklenir.
 * Endpoint listesi: ./endpoints.ts (gelistirme-notlari §3.6 ile birebir).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(
  method: Method,
  path: string,
  options: {
    body?: unknown;
    auth?: boolean;
    query?: Record<string, string | number | undefined>;
  } = {},
): Promise<T> {
  const { body, auth = true, query } = options;
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

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? safeJson(text) : null;

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
