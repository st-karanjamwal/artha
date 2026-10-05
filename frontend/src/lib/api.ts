/** Thin client for the storage server. Only opaque encrypted bytes and auth data go over the wire. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Artha-Request', '1');
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  if (!res.ok) {
    let detail: unknown;
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail;
      if (typeof j.detail === 'string') msg = j.detail;
      else if (j.detail?.message) msg = j.detail.message;
      else if (Array.isArray(j.detail))
        msg = j.detail.map((d: { msg: string }) => d.msg).join('; ');
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg, detail);
  }
  return res;
}

const json = async <T>(path: string, init?: RequestInit): Promise<T> =>
  (await request(path, init)).json();
const post = <T>(path: string, body?: unknown) =>
  json<T>(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

export interface AuthStatus {
  setup_complete: boolean;
  authenticated: boolean;
}

export interface VaultMeta {
  exists: boolean;
  blob_version: number;
  updated_on?: string;
  size?: number;
}

export interface VaultVersion {
  blob_version: number;
  saved_on: string;
  size: number;
}

export interface BackupStatus {
  configured: boolean;
  schedule: string;
  retention: string;
  last_run?: string;
  last_success?: string;
  last_file?: string;
  last_result?: string;
  last_error?: string | null;
}

export const api = {
  authStatus: () => json<AuthStatus>('/auth/status'),
  setupStart: (setup_token: string, password: string) =>
    post<{ otpauth_uri: string; secret: string; qr_svg: string }>('/auth/setup', {
      setup_token,
      password,
    }),
  setupConfirm: (setup_token: string, code: string) =>
    post('/auth/setup/confirm', { setup_token, code }),
  login: (password: string, code: string) => post('/auth/login', { password, code }),
  logout: () => post('/auth/logout'),
  changeLoginPassword: (current_password: string, new_password: string, code: string) =>
    post('/auth/password', { current_password, new_password, code }),

  vaultMeta: () => json<VaultMeta>('/vault/meta'),
  async getVault(): Promise<{ bytes: Uint8Array; version: number }> {
    const res = await request('/vault');
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      version: Number(res.headers.get('X-Blob-Version')),
    };
  },
  putVault: (bytes: Uint8Array, expectedVersion: number) =>
    json<VaultMeta>('/vault', {
      method: 'PUT',
      headers: { 'If-Match': String(expectedVersion), 'Content-Type': 'application/octet-stream' },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
  versions: () => json<{ current_version: number; versions: VaultVersion[] }>('/vault/versions'),
  restoreVersion: (v: number) => post<VaultMeta>(`/vault/restore/${v}`),

  async amfiNav(
    force = false,
  ): Promise<{ text: string; fetchedAt: string | null; cache: string | null }> {
    const res = await request(`/public/amfi-nav${force ? '?force=true' : ''}`);
    return {
      text: await res.text(),
      fetchedAt: res.headers.get('X-Fetched-At'),
      cache: res.headers.get('X-Cache'),
    };
  },
  navHistory: (schemeCode: string) =>
    json<{ schemeCode: string; schemeName: string | null; data: { date: string; nav: string }[] }>(
      `/public/nav-history/${encodeURIComponent(schemeCode)}`,
    ),

  backupStatus: () => json<BackupStatus>('/backup/status'),
  backupRun: () => post<BackupStatus>('/backup/run'),
};
