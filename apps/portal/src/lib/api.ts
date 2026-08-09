import { useAuthStore } from '../stores/auth';

/**
 * API client.
 *
 * Two things it must get right: attaching the access token, and transparently
 * refreshing it when it expires. Access tokens live 15 minutes, so a user
 * editing a large batch will cross that boundary mid-session — without a
 * refresh they would lose unsaved grid state to a sudden redirect.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  /** Skip the refresh-and-retry dance (used by the refresh call itself). */
  noRetry?: boolean;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Refresh the session, collapsing concurrent attempts into one request.
 * The dashboard fires several queries at once; without this a single expiry
 * would trigger a burst of refreshes, and token rotation means all but the
 * first would fail and log the user out.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken, setSession, clear } = useAuthStore.getState();
    if (!refreshToken) return false;

    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        clear();
        return false;
      }
      const session = await response.json();
      setSession(session);
      return true;
    } catch {
      clear();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { accessToken } = useAuthStore.getState();

  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.formData ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    signal: options.signal,
  });

  if (response.status === 401 && !options.noRetry && accessToken) {
    if (await refreshSession()) {
      return api<T>(path, { ...options, noRetry: true });
    }
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

/** Fetch a binary response (templates, XML, source workbooks). */
export async function apiBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const { accessToken } = useAuthStore.getState();

  let response = await fetch(path, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });

  if (response.status === 401 && (await refreshSession())) {
    const { accessToken: refreshed } = useAuthStore.getState();
    response = await fetch(path, {
      headers: refreshed ? { authorization: `Bearer ${refreshed}` } : {},
    });
  }

  if (!response.ok) {
    throw new ApiError(response.status, 'DOWNLOAD_FAILED', 'That file could not be downloaded.');
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);

  return { blob: await response.blob(), filename: match?.[1] ?? 'download' };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}
