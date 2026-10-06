import { renderInTestApp } from '@backstage/frontend-test-utils';
import { screen, waitFor } from '@testing-library/react';
import { MockDaasApi } from '../../dev/fixtures';
import { daasApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { DaasRoot } from './DaasRoot';

function render(path: string) {
  return renderInTestApp(<DaasRoot />, {
    apis: [[daasApiRef, new MockDaasApi()]],
    mountedRoutes: { '/daas': rootRouteRef },
    mountPath: '/daas/*',
    initialRouteEntries: [path],
  });
}

describe('DAAS pages', () => {
  it('shows the platform overview', async () => {
    await render('/daas');
    expect(await screen.findByText('Promotion path')).toBeInTheDocument();
    expect(await screen.findByText('7 GKE · 5 EKS')).toBeInTheDocument();
    expect(screen.getAllByText('production').length).toBeGreaterThan(0);
  });

  it('shows an app and links “Edit” to the update template with its current spec', async () => {
    await render('/daas/apps/payments/checkout-api');
    const edit = await screen.findByRole('link', { name: /edit daas.yaml/i });
    const url = new URL(edit.getAttribute('href')!, 'http://x');
    expect(url.pathname).toBe('/create/templates/default/daas-update-app');
    const formData = JSON.parse(url.searchParams.get('formData')!);
    expect(formData).toMatchObject({
      team: 'payments',
      name: 'checkout-api',
      repoUrl: 'gitlab.acme.io?owner=acme%2Fpayments&repo=checkout-api',
    });
    expect(formData).not.toHaveProperty('apiVersion');
    expect(screen.getAllByText('checkout.pay.acme.io').length).toBe(2);
  });

  it('flags secrets declared in daas.yaml but not set', async () => {
    await render('/daas/secrets?team=payments&app=checkout-api&stage=production');
    expect(await screen.findByText('STRIPE_API_KEY')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Missing')).toBeInTheDocument());
    expect(screen.getByText('Set · not in daas.yaml')).toBeInTheDocument();
  });

  it('lists failed rollouts with the failing wave', async () => {
    await render('/daas/deployments?status=failed');
    expect(await screen.findByText(/image pull back-off/)).toBeInTheDocument();
    expect(screen.getByText('Unhealthy')).toBeInTheDocument();
  });
});
