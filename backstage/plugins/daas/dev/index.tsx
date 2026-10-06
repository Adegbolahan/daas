// The harness is a standalone app, so it loads the BUI styles itself.
// eslint-disable-next-line @backstage/no-ui-css-imports-in-non-frontend
import '@backstage/ui/css/styles.css';
import { createApp } from '@backstage/frontend-defaults';
import { ApiBlueprint, createFrontendModule, PageBlueprint } from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint, SignInPageProps } from '@backstage/plugin-app-react';
import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import daasPlugin from '../src';
import { daasApiRef } from '../src/api';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { catalogApiMock } from '@backstage/plugin-catalog-react/testUtils';
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import { scaffolderApiRef } from '@backstage/plugin-scaffolder-react';
import { catalogEntities, devIdentity } from './catalog';
import { MockDaasApi } from './fixtures';
import { daasTemplates, MockScaffolderApi } from './scaffolderMock';

/**
 * Dev harness: the DAAS plugin on in-memory data, plus a playground for the scaffolder fields.
 *   yarn workspace @internal/plugin-daas start
 */
const daas = new MockDaasApi();
const templates = daasTemplates();

const devModule = createFrontendModule({
  pluginId: 'daas',
  extensions: [
    ApiBlueprint.make({
      params: defineParams => defineParams({ api: daasApiRef, deps: {}, factory: () => daas }),
    }),
    PageBlueprint.make({
      name: 'fields',
      params: {
        path: '/daas-fields',
        title: 'DAAS fields',
        loader: () => import('./FieldsPlayground').then(m => <m.FieldsPlayground />),
      },
    }),
  ],
});

// The real catalog and scaffolder pages, on in-memory entities and a scaffolder that runs the
// generated DAAS templates against the mock API.
const catalogDev = createFrontendModule({
  pluginId: 'catalog',
  extensions: [
    ApiBlueprint.make({
      params: defineParams =>
        defineParams({
          api: catalogApiRef,
          deps: {},
          factory: () => catalogApiMock({ entities: [...catalogEntities, ...templates] }),
        }),
    }),
  ],
});

const scaffolderDev = createFrontendModule({
  pluginId: 'scaffolder',
  extensions: [
    ApiBlueprint.make({
      params: defineParams =>
        defineParams({ api: scaffolderApiRef, deps: {}, factory: () => new MockScaffolderApi(daas) as any }),
    }),
  ],
});

// No auth backend in the harness: sign straight in as a local dev user.
function DevSignIn({ onSignInSuccess }: SignInPageProps) {
  useEffect(() => {
    onSignInSuccess({
      getProfileInfo: async () => ({ displayName: 'Dev User', email: 'dev@example.com' }),
      getBackstageIdentity: async () => ({ type: 'user', ...devIdentity }),
      getCredentials: async () => ({}),
      signOut: async () => {},
    });
  }, [onSignInSuccess]);
  return null;
}

const devSignIn = createFrontendModule({
  pluginId: 'app',
  extensions: [SignInPageBlueprint.make({ params: { loader: async () => DevSignIn } })],
});

const app = createApp({
  features: [daasPlugin, devModule, catalogPlugin, catalogDev, scaffolderPlugin, scaffolderDev, devSignIn],
});

ReactDOM.createRoot(document.getElementById('root')!).render(app.createRoot());
