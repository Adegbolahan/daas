import { mockCredentials, mockErrorHandler, mockServices } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import express from 'express';
import request from 'supertest';
import { DaasApiError } from './DaasClient';
import { createRouter, USER_TOKEN_HEADER } from './router';

const ui = {
  gitlabHost: 'gitlab.acme.io',
  scaffolderPath: '/create',
  templates: { create: 'a', update: 'b', onboard: 'c' },
  secretsScope: 'api://daas/.default',
};

async function app(
  opts: { result?: AuthorizeResult.ALLOW | AuthorizeResult.DENY; client?: Record<string, jest.Mock> } = {},
) {
  const client = {
    getPlatform: jest.fn(async () => ({ stages: [], teams: [] })),
    listDeployments: jest.fn(async () => []),
    preview: jest.fn(async () => ({ valid: true })),
    listSecrets: jest.fn(async () => [{ name: 'DB' }]),
    putSecret: jest.fn(async () => ({ key: 'payments_svc_DB', provider: 'gcp' })),
    deleteSecret: jest.fn(async () => ({})),
    ...opts.client,
  };
  const router = await createRouter({
    client: client as any,
    ui,
    httpAuth: mockServices.httpAuth(),
    auth: mockServices.auth(),
    permissions: mockServices.permissions({ result: opts.result ?? AuthorizeResult.ALLOW }),
    logger: mockServices.logger.mock(),
  });
  const server = express().use(router).use(mockErrorHandler());
  return { server, client };
}

describe('daas router', () => {
  it('serves the UI config and relays reads', async () => {
    const { server, client } = await app();
    expect((await request(server).get('/ui-config')).body).toEqual(ui);
    await request(server).get('/deployments?team=payments&limit=abc').expect(200);
    expect(client.listDeployments).toHaveBeenCalledWith({
      team: 'payments',
      app: undefined,
      environment: undefined,
      limit: 50,
    });
  });

  it('denies reads without the daas.read permission', async () => {
    const { server } = await app({ result: AuthorizeResult.DENY });
    await request(server).get('/platform').expect(403);
  });

  it('validates preview input', async () => {
    const { server } = await app();
    await request(server).post('/preview').send({ spec: 'name: x' }).expect(400);
    await request(server)
      .post('/preview')
      .send({ spec: 'name: x', team: 'payments', environment: 'production' })
      .expect(200);
  });

  it('forwards the user token for secrets and requires it', async () => {
    const { server, client } = await app();
    await request(server).get('/secrets/production/payments/svc').expect(400);
    await request(server)
      .put('/secrets/production/payments/svc/DB')
      .set(USER_TOKEN_HEADER, 'entra-token')
      .send({ value: 's3cret' })
      .expect(200);
    expect(client.putSecret).toHaveBeenCalledWith('entra-token', 'production', 'payments', 'svc', 'DB', {
      value: 's3cret',
      provider: undefined,
    });
  });

  it('refuses secret calls from other services', async () => {
    const { server } = await app();
    await request(server)
      .get('/secrets/production/payments/svc')
      .set('authorization', mockCredentials.service.header())
      .set(USER_TOKEN_HEADER, 'x')
      .expect(403);
  });

  it('passes DAAS errors through with their status', async () => {
    const { server } = await app({
      client: {
        listSecrets: jest.fn(async () => {
          throw new DaasApiError(403, 'not a secret writer for payments/production');
        }),
      },
    });
    const res = await request(server).get('/secrets/production/payments/svc').set(USER_TOKEN_HEADER, 't').expect(403);
    expect(res.body.error.message).toContain('not a secret writer');
  });
});
