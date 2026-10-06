import {
  ApiBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
  microsoftAuthApiRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { RiRocketLine } from '@remixicon/react';
import { DaasClient, daasApiRef } from './api';
import { isDaasApp, isGroup } from './entity';
import { daasFormFields } from './fields';
import { rootRouteRef } from './routes';

export const daasApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: daasApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef, microsoftAuthApi: microsoftAuthApiRef },
      factory: deps => new DaasClient(deps),
    }),
});

export const daasPage = PageBlueprint.make({
  params: {
    path: '/daas',
    title: 'DAAS',
    icon: <RiRocketLine />,
    routeRef: rootRouteRef,
    loader: () => import('./components/DaasRoot').then(m => <m.DaasRoot />),
  },
});

export const daasEntityContent = EntityContentBlueprint.make({
  params: {
    path: 'daas',
    title: 'Deployments',
    filter: isDaasApp,
    loader: () => import('./components/EntityDaasContent').then(m => <m.EntityDaasContent />),
  },
});

export const daasTeamEntityContent = EntityContentBlueprint.make({
  name: 'team',
  params: {
    path: 'daas',
    title: 'Deployments',
    filter: isGroup,
    loader: () => import('./components/EntityTeamContent').then(m => <m.EntityTeamContent />),
  },
});

/**
 * DAAS for Backstage (new frontend system): the /daas page, a Deployments tab on catalog entities
 * annotated with daas.io/app and on Groups (the team view), and the scaffolder fields used by the generated templates.
 */
export default createFrontendPlugin({
  pluginId: 'daas',
  title: 'DAAS',
  icon: <RiRocketLine />,
  routes: { root: rootRouteRef },
  extensions: [daasApi, daasPage, daasEntityContent, daasTeamEntityContent, ...daasFormFields],
});
