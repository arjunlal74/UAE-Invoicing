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

/** Save a server-rendered PDF to disk under the filename the API chose. */
export async function downloadPdf(path: string): Promise<void> {
  const { blob, filename } = await apiBlob(path);
  downloadBlob(blob, filename);
}

/**
 * Print a server-rendered PDF.
 *
 * Asks for `disposition=inline` and hands the bytes to a hidden iframe, because
 * a PDF served as an attachment goes to the downloads folder and never reaches
 * a print dialog. Printing the rendered PDF rather than the page it came from
 * means the paper copy and the downloaded file are the same document — a print
 * stylesheet over the React view would be a second layout to keep in step.
 */
export async function printPdf(path: string): Promise<void> {
  const { blob } = await apiBlob(`${path}${path.includes('?') ? '&' : '?'}disposition=inline`);

  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';

  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      // Safari will not print a PDF out of an iframe. Opening it gives the user
      // the viewer's own print control, which is one click rather than none.
      window.open(url, '_blank', 'noopener');
    }
    // There is no event for "the print dialog closed", and revoking the URL
    // while the dialog is still open leaves it printing a blank page. A long
    // timer costs one object URL for a minute; getting this wrong costs the
    // print job.
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  frame.src = url;
  document.body.appendChild(frame);
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
