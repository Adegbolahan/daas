import { AuthService, HttpAuthService, LoggerService, PermissionsService } from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError } from '@backstage/errors';
import { AuthorizeResult, BasicPermission } from '@backstage/plugin-permission-common';
import { daasReadPermission, daasSecretsManagePermission } from '@internal/plugin-daas-common';
import express, { Request } from 'express';
import Router from 'express-promise-router';
import { DaasApiError, DaasClient } from './DaasClient';

/** Header the DAAS frontend uses to pass the signed-in user's Entra token for secret calls. */
export const USER_TOKEN_HEADER = 'x-daas-user-token';

export interface UiConfig {
  gitlabHost: string;
  scaffolderPath: string;
  templates: { create: string; update: string; onboard: string };
  secretsScope: string;
}

export async function createRouter(opts: {
  client: DaasClient;
  ui: UiConfig;
  httpAuth: HttpAuthService;
  auth: AuthService;
  permissions: PermissionsService;
  logger: LoggerService;
}): Promise<express.Router> {
  const { client, httpAuth, permissions, logger } = opts;
  const router = Router();
  router.use(express.json({ limit: '256kb' }));

  // Reads may come from users or other plugins; secret writes only ever from a signed-in user.
  async function allow(
    req: Request,
    permission: BasicPermission,
    principals: ('user' | 'service')[] = ['user', 'service'],
  ) {
    const credentials = await httpAuth.credentials(req, { allow: principals });
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision.result !== AuthorizeResult.ALLOW) throw new NotAllowedError(`missing ${permission.name}`);
    return credentials;
  }

  function userToken(req: Request): string {
    const t = req.header(USER_TOKEN_HEADER);
    if (!t) throw new InputError(`secret calls need the signed-in user's Entra token in ${USER_TOKEN_HEADER}`);
    return t;
  }

  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ui-config', async (req, res) => {
    await allow(req, daasReadPermission);
    res.json(opts.ui);
  });

  router.get('/platform', async (req, res) => {
    await allow(req, daasReadPermission);
    res.json(await client.getPlatform());
  });

  router.get('/schemas', async (req, res) => {
    await allow(req, daasReadPermission);
    res.json(await client.getSchemas());
  });

  router.get('/apps', async (req, res) => {
    await allow(req, daasReadPermission);
    res.json({ apps: await client.listApps(str(req.query.team)) });
  });

  router.get('/apps/:team/:app/spec', async (req, res) => {
    await allow(req, daasReadPermission);
    res.json(await client.getAppSpec(req.params.team, req.params.app, str(req.query.environment)));
  });

  router.get('/deployments', async (req, res) => {
    await allow(req, daasReadPermission);
    const limit = Number(req.query.limit ?? 50);
    res.json({
      deployments: await client.listDeployments({
        team: str(req.query.team),
        app: str(req.query.app),
        environment: str(req.query.environment),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  });

  router.post('/preview', async (req, res) => {
    await allow(req, daasReadPermission);
    const { spec, team, environment } = req.body ?? {};
    if (typeof spec !== 'string' || typeof team !== 'string' || typeof environment !== 'string') {
      throw new InputError('spec, team and environment are required strings');
    }
    res.json(await client.preview({ spec, team, environment }));
  });

  // ---- secrets: gated by a Backstage permission here, and by the user's Entra role in DAAS ----

  router.get('/secrets/:stage/:team/:app', async (req, res) => {
    await allow(req, daasSecretsManagePermission, ['user']);
    const { stage, team, app } = req.params;
    res.json({ secrets: await client.listSecrets(userToken(req), stage, team, app) });
  });

  router.put('/secrets/:stage/:team/:app/:name', async (req, res) => {
    const credentials = await allow(req, daasSecretsManagePermission, ['user']);
    const { stage, team, app, name } = req.params;
    const { value, provider } = req.body ?? {};
    if (typeof value !== 'string' || !value) throw new InputError('value is required');
    const out = await client.putSecret(userToken(req), stage, team, app, name, { value, provider });
    logger.info(
      `secret ${out.key} written in ${stage} by ${(credentials.principal as { userEntityRef?: string }).userEntityRef ?? 'unknown'}`,
    );
    res.json(out);
  });

  router.delete('/secrets/:stage/:team/:app/:name', async (req, res) => {
    await allow(req, daasSecretsManagePermission, ['user']);
    const { stage, team, app, name } = req.params;
    res.json(await client.deleteSecret(userToken(req), stage, team, app, name, str(req.query.provider)));
  });

  // Pass DAAS's own status codes and messages through (403 from its role checks, 404, 422 ...).
  router.use(((err, _req, res, next) => {
    if (err instanceof DaasApiError) {
      res.status(err.status).json({ error: { name: err.name, message: err.message }, detail: err.detail });
      return;
    }
    next(err);
  }) as express.ErrorRequestHandler);

  return router;
}
