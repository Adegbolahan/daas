import { LoggerService, SchedulerServiceTaskRunner } from '@backstage/backend-plugin-api';
import { EntityProvider, EntityProviderConnection } from '@backstage/plugin-catalog-node';
import { DaasClient } from '../service/DaasClient';
import { buildTemplates, TemplateSettings } from '@internal/plugin-daas-common';

/** Keeps the generated DAAS templates in the catalog, in step with the DAAS schemas and platform. */
export class DaasTemplateProvider implements EntityProvider {
  private connection?: EntityProviderConnection;

  constructor(
    private readonly client: DaasClient,
    private readonly settings: TemplateSettings,
    private readonly logger: LoggerService,
    private readonly taskRunner: SchedulerServiceTaskRunner,
  ) {}

  getProviderName(): string {
    return 'daas-templates';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.taskRunner.run({
      id: `${this.getProviderName()}:refresh`,
      fn: async () => {
        try {
          await this.refresh();
        } catch (e) {
          // Keep the last good templates; the next run retries.
          this.logger.warn(`DAAS templates not refreshed: ${(e as Error).message}`);
        }
      },
    });
  }

  async refresh(): Promise<void> {
    if (!this.connection) throw new Error('not connected');
    const [schemas, platform] = await Promise.all([this.client.getSchemas(), this.client.getPlatform()]);
    const entities = buildTemplates(schemas, platform, this.settings);
    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({ entity, locationKey: this.getProviderName() })),
    });
    this.logger.info(`DAAS templates refreshed (${entities.length})`);
  }
}
