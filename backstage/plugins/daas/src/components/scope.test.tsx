import { mockApis, renderInTestApp } from '@backstage/frontend-test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { fireEvent, screen } from '@testing-library/react';
import { MockDaasApi } from '../../dev/fixtures';
import { daasApiRef } from '../api';
import { rootRouteRef } from '../routes';
import { DaasRoot } from './DaasRoot';
import { EntityTeamContent } from './EntityTeamContent';

const member = (...groups: string[]) =>
  mockApis.identity({ userEntityRef: 'user:default/ada', ownershipEntityRefs: groups.map(g => `group:default/${g}`) });

describe('my teams', () => {
  it('starts on the user’s teams and can switch to all', async () => {
    await renderInTestApp(<DaasRoot />, {
      apis: [[daasApiRef, new MockDaasApi()], member('payments')],
      mountedRoutes: { '/daas': rootRouteRef },
      mountPath: '/daas/*',
      initialRouteEntries: ['/daas/teams'],
    });
    const mine = await screen.findByRole('radio', { name: /my teams · payments/i });
    expect(mine).toHaveAttribute('aria-checked', 'true');
    await screen.findByRole('link', { name: 'Team payments' });
    expect(screen.queryByRole('link', { name: 'Team search' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /all teams/i }));
    expect(await screen.findByRole('link', { name: 'Team search' })).toBeInTheDocument();
  });

  it('shows everything, without a switch, for users in no DAAS team', async () => {
    await renderInTestApp(<DaasRoot />, {
      apis: [[daasApiRef, new MockDaasApi()], member()],
      mountedRoutes: { '/daas': rootRouteRef },
      mountPath: '/daas/*',
      initialRouteEntries: ['/daas/teams'],
    });
    expect(await screen.findByRole('link', { name: 'Team search' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /all teams/i })).not.toBeInTheDocument();
  });
});

describe('Group entity tab', () => {
  const group = (name: string, annotations?: Record<string, string>) => ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name, annotations },
    spec: { type: 'team', children: [] },
  });

  it('shows the DAAS team matching the Group (by annotation or name)', async () => {
    await renderInTestApp(
      <EntityProvider entity={group('team-payments', { 'daas.io/team': 'payments' })}>
        <EntityTeamContent />
      </EntityProvider>,
      { apis: [[daasApiRef, new MockDaasApi()]], mountedRoutes: { '/daas': rootRouteRef } },
    );
    expect(await screen.findByText('Where it runs')).toBeInTheDocument();
    expect(screen.getAllByText('payments-prod-euw1').length).toBeGreaterThan(0);
  });

  it('offers onboarding for a Group that isn’t a DAAS team', async () => {
    await renderInTestApp(
      <EntityProvider entity={group('marketing')}>
        <EntityTeamContent />
      </EntityProvider>,
      { apis: [[daasApiRef, new MockDaasApi()]], mountedRoutes: { '/daas': rootRouteRef } },
    );
    expect(await screen.findByText(/isn’t onboarded to DAAS/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /onboard the team/i })).toHaveAttribute(
      'href',
      '/create/templates/default/daas-onboard-team',
    );
  });
});
