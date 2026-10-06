import { ButtonLink, HeaderPage } from '@backstage/ui';
import { RiAddLine, RiTeamLine } from '@remixicon/react';
import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useLinks } from '../routes';
import { ScopeProvider, ScopeToggle } from '../scope';

const TABS = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'teams', label: 'Teams', path: '/teams' },
  { id: 'apps', label: 'Apps', path: '/apps' },
  { id: 'deployments', label: 'Deployments', path: '/deployments' },
  { id: 'secrets', label: 'Secrets', path: '/secrets' },
];

/** Secondary header with the DAAS sections as tabs, and the two "start something" actions. */
export function DaasLayout({ children }: { children: ReactNode }) {
  const links = useLinks();
  const { pathname } = useLocation();
  const rest = pathname.startsWith(links.base) ? pathname.slice(links.base.length) : pathname;
  const active = TABS.slice(1).find(t => rest.startsWith(t.path))?.id ?? 'overview';
  const create = links.createApp();
  const onboard = links.onboardTeam();
  return (
    <ScopeProvider>
      <div className="daas">
        <HeaderPage
          title="Deployments"
          tabs={TABS.map(t => ({
            id: t.id,
            label: t.label,
            href: `${links.base}${t.path}`,
          }))}
          activeTabId={active}
          customActions={
            <>
              {onboard && (
                <ButtonLink href={onboard} variant="secondary" size="small" iconStart={<RiTeamLine />}>
                  Onboard team
                </ButtonLink>
              )}
              {create && (
                <ButtonLink href={create} variant="primary" size="small" iconStart={<RiAddLine />}>
                  New app
                </ButtonLink>
              )}
            </>
          }
        />
        <div className="daas-body">
          <div className="daas-scopebar">
            <ScopeToggle />
          </div>
          {children}
        </div>
      </div>
    </ScopeProvider>
  );
}
