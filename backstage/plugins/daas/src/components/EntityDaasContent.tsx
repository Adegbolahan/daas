import { useEntity } from '@backstage/plugin-catalog-react';
import { DAAS_APP_ANNOTATION, parseAppAnnotation } from '../entity';
import { AppDetail } from './AppPage';
import { EmptyState } from './ui';

/** The "Deployments" tab on a catalog component annotated with daas.io/app: <team>/<app>. */
export function EntityDaasContent() {
  const { entity } = useEntity();
  const ref = parseAppAnnotation(entity);
  if (!ref) {
    return (
      <EmptyState title="Not deployed with DAAS">
        Add the annotation <code>{DAAS_APP_ANNOTATION}: &lt;team&gt;/&lt;app&gt;</code> to this entity.
      </EmptyState>
    );
  }
  return (
    <div className="daas">
      <AppDetail team={ref.team} app={ref.app} embedded />
    </div>
  );
}

export default EntityDaasContent;
