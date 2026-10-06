import { Config } from '@backstage/config';
import { ResponseError } from '@backstage/errors';
import type {
  AppView,
  DaasSchemas,
  DeploymentRecord,
  PlatformView,
  PreviewResult,
  SecretListItem,
} from '@internal/plugin-daas-common';

const enc = encodeURIComponent;

type TokenCache = { token: string; expiresAt: number };

/** A non-2xx answer from DAAS, with its status and `detail` (FastAPI's error body) preserved. */
export class DaasApiError extends Error {
  readonly name = 'DaasApiError';
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(DaasApiError.describe(status, detail));
  }

  static describe(status: number, detail: unknown): string {
    if (typeof detail === 'string') return detail;
    const errors = (detail as { errors?: unknown })?.errors;
    if (Array.isArray(errors)) return errors.join('; ');
    return `DAAS returned HTTP ${status}`;
  }

  static async fromResponse(res: Response): Promise<DaasApiError> {
    const text = await res.text();
    let detail: unknown = text;
    try {
      detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
    } catch {
      /* not JSON */
    }
    return new DaasApiError(res.status, detail);
  }
}

/**
 * Talks to the DAAS API. Read calls use the backend's own identity (Entra client credentials,
 * or dev headers); secret calls pass the signed-in user's Entra token through untouched, so
 * DAAS applies its own per-team, per-stage role check.
 */
export class DaasClient {
  private cache?: TokenCache;

  static fromConfig(config: Config, fetchImpl: typeof fetch = fetch): DaasClient {
    const c = config.getConfig('daas');
    const entra = c.getOptionalConfig('auth.entra');
    return new DaasClient({
      baseUrl: c.getString('baseUrl').replace(/\/+$/, ''),
      entra: entra
        ? {
            tenantId: entra.getString('tenantId'),
            clientId: entra.getString('clientId'),
            clientSecret: entra.getString('clientSecret'),
            scope: entra.getOptionalString('scope') ?? 'api://daas/.default',
          }
        : undefined,
      devHeaders: (c.getOptional<Record<string, string>>('auth.devHeaders') ?? {}) as Record<string, string>,
      fetchImpl,
    });
  }

  constructor(
    private readonly opts: {
      baseUrl: string;
      entra?: { tenantId: string; clientId: string; clientSecret: string; scope: string };
      devHeaders?: Record<string, string>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  /** Bearer token for the backend's own identity (cached until a minute before expiry). */
  private async serviceHeaders(): Promise<Record<string, string>> {
    const e = this.opts.entra;
    if (!e) return { ...(this.opts.devHeaders ?? {}) };
    if (!this.cache || this.cache.expiresAt < Date.now() + 60_000) {
      const res = await this.fetch(`https://login.microsoftonline.com/${e.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: e.clientId,
          client_secret: e.clientSecret,
          scope: e.scope,
        }),
      });
      if (!res.ok) throw await ResponseError.fromResponse(res);
      const j = (await res.json()) as { access_token: string; expires_in: number };
      this.cache = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    }
    return { authorization: `Bearer ${this.cache.token}` };
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await this.fetch(`${this.opts.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? (await this.serviceHeaders())),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) throw await DaasApiError.fromResponse(res);
    return (await res.json()) as T;
  }

  getSchemas(): Promise<DaasSchemas> {
    return this.call('/v1/schemas');
  }

  getPlatform(): Promise<PlatformView> {
    return this.call('/v1/platform');
  }

  async listApps(team?: string): Promise<AppView[]> {
    const q = team ? `?team=${encodeURIComponent(team)}` : '';
    return (await this.call<{ apps: AppView[] }>(`/v1/apps${q}`)).apps;
  }

  async listDeployments(filter: { team?: string; app?: string; environment?: string; limit?: number }) {
    const q = new URLSearchParams(
      Object.entries(filter).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
    );
    return (await this.call<{ deployments: DeploymentRecord[] }>(`/v1/deployments?${q}`)).deployments;
  }

  getAppSpec(team: string, app: string, environment?: string) {
    const q = environment ? `?environment=${encodeURIComponent(environment)}` : '';
    return this.call<{ spec: string; deploymentId: string; environment: string; project?: string }>(
      `/v1/apps/${encodeURIComponent(team)}/${encodeURIComponent(app)}/spec${q}`,
    );
  }

  preview(body: { spec: string; team: string; environment: string }): Promise<PreviewResult> {
    return this.call('/v1/preview', { method: 'POST', body });
  }

  // ---- secrets: always as the user ----

  private user(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async listSecrets(userToken: string, stage: string, team: string, app: string) {
    return (
      await this.call<{ secrets: SecretListItem[] }>(`/v1/secrets/${enc(stage)}/${enc(team)}/${enc(app)}`, {
        headers: this.opts.entra ? this.user(userToken) : { ...this.opts.devHeaders },
      })
    ).secrets;
  }

  putSecret(
    userToken: string,
    stage: string,
    team: string,
    app: string,
    name: string,
    body: { value: string; provider?: 'gcp' | 'aws' },
  ) {
    return this.call<{ key: string; provider: string; stage: string }>(
      `/v1/secrets/${enc(stage)}/${enc(team)}/${enc(app)}/${enc(name)}`,
      { method: 'PUT', body, headers: this.opts.entra ? this.user(userToken) : { ...this.opts.devHeaders } },
    );
  }

  deleteSecret(userToken: string, stage: string, team: string, app: string, name: string, provider?: string) {
    const q = provider ? `?provider=${enc(provider)}` : '';
    return this.call<{ deleted: string }>(`/v1/secrets/${enc(stage)}/${enc(team)}/${enc(app)}/${enc(name)}${q}`, {
      method: 'DELETE',
      headers: this.opts.entra ? this.user(userToken) : { ...this.opts.devHeaders },
    });
  }
}
