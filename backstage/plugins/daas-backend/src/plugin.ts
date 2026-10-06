import { coreServices, createBackendModule, createBackendPlugin } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { daasPermissions } from '@internal/plugin-daas-common';
import { createWriteSpecAction } from './actions/writeSpec';
import { createWriteTeamAction } from './actions/writeTeam';
import { DaasClient } from './service/DaasClient';
import { createRouter } from './service/router';
import { DaasTemplateProvider } from './templates/DaasTemplateProvider';

/**
 * The DAAS backend plugin: /api/daas, a proxy to the DAAS API with Backstage auth and permissions.
 *
 * @public
 */
export const daasPlugin = createBackendPlugin({
  pluginId: 'daas',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        auth: coreServices.auth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ httpRouter, httpAuth, auth, permissions, permissionsRegistry, config, logger }) {
        permissionsRegistry.addPermissions(daasPermissions);
        const client = DaasClient.fromConfig(config);
        const ui = {
          gitlabHost: config.getString('daas.gitlab.host'),
          scaffolderPath: config.getOptionalString('daas.ui.scaffolderPath') ?? '/create',
          templates: {
            create: 'template:default/daas-create-app',
            update: 'template:default/daas-update-app',
            onboard: 'template:default/daas-onboard-team',
          },
          secretsScope:
            config.getOptionalString('daas.ui.secretsScope') ??
            (config.has('daas.auth.entra') ? 'api://daas/.default' : ''),
        };
        httpRouter.use(await createRouter({ client, ui, httpAuth, auth, permissions, logger }));
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
      },
    });
  },
});

/**
 * Catalog module: keeps the DAAS templates (create app, update app, onboard team) generated from
 * the DAAS schemas and platform, refreshed on a schedule.
 *
 * @public
 */
export const catalogModuleDaasTemplates = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'daas-templates',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
      },
      async init({ catalog, config, logger, scheduler }) {
        const minutes = config.getOptionalNumber('daas.templates.refreshMinutes') ?? 10;
        const provider = new DaasTemplateProvider(
          DaasClient.fromConfig(config),
          {
            daasBaseUrl: config.getString('daas.baseUrl'),
            owner: config.getOptionalString('daas.templates.owner') ?? 'group:default/platform',
            gitlabHost: config.getString('daas.gitlab.host'),
            platformRepoUrl: config.getString('daas.gitlab.platformRepoUrl'),
          },
          logger,
          scheduler.createScheduledTaskRunner({
            frequency: { minutes },
            timeout: { minutes: 2 },
            initialDelay: { seconds: 15 },
          }),
        );
        catalog.addEntityProvider(provider);
      },
    });
  },
});

/**
 * Scaffolder module: the `daas:spec:write` and `daas:team:write` actions used by the templates.
 *
 * @public
 */
export const scaffolderModuleDaas = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'daas',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        reader: coreServices.urlReader,
      },
      async init({ scaffolder, config, logger, reader }) {
        const client = DaasClient.fromConfig(config);
        const daasUrl = config.getOptionalString('daas.publicUrl') ?? config.getString('daas.baseUrl');
        scaffolder.addActions(
          createWriteSpecAction({
            client,
            reader,
            logger,
            ci: {
              componentProject: config.getOptionalString('daas.gitlab.componentProject') ?? 'platform/daas-deploy',
              componentVersion: config.getOptionalString('daas.gitlab.componentVersion') ?? '1.0.0',
              apiUrl: daasUrl,
            },
          }),
          createWriteTeamAction({
            client,
            platformDir: config.getOptionalString('daas.gitlab.platformDir') ?? 'platform',
          }),
        );
      },
    });
  },
});
