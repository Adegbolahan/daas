import { Route, Routes } from 'react-router-dom';
import { AppPage } from './AppPage';
import { AppsPage } from './AppsPage';
import { DaasLayout } from './DaasLayout';
import { DeploymentsPage } from './DeploymentsPage';
import { OverviewPage } from './OverviewPage';
import { SecretsPage } from './SecretsPage';
import { TeamPage, TeamsPage } from './TeamsPage';
import { EmptyState } from './ui';

export function DaasRoot() {
  return (
    <DaasLayout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/teams/:team" element={<TeamPage />} />
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/apps/:team/:app" element={<AppPage />} />
        <Route path="/deployments" element={<DeploymentsPage />} />
        <Route path="/secrets" element={<SecretsPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Routes>
    </DaasLayout>
  );
}

export default DaasRoot;
