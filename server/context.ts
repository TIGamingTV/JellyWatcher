import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';
import type { SecretBox } from './security/crypto.js';
import { ActivityService } from './services/activity.js';
import { ConnectionService } from './services/connections.js';
import { IntegrationStore } from './services/integrations.js';
import { JobRunner } from './services/jobs.js';
import { ListService } from './services/lists.js';
import { Matcher } from './services/matcher.js';
import { metadataSource, type MetadataSource } from './services/metadata.js';
import { SettingsStore } from './services/settings.js';
import { StatusService } from './services/status.js';
import { TitleService } from './services/titles.js';

/** Composition root: every service the routes and jobs need, built once per process. */
export class AppContext {
  readonly settings: SettingsStore;
  readonly integrations: IntegrationStore;
  readonly connections: ConnectionService;
  readonly titles: TitleService;
  readonly lists: ListService;
  readonly matcher: Matcher;
  readonly status: StatusService;
  readonly activity: ActivityService;
  readonly jobs: JobRunner;

  constructor(
    readonly config: AppConfig,
    readonly db: DB,
    readonly box: SecretBox,
    readonly log: Logger,
  ) {
    this.settings = new SettingsStore(db);
    const instanceId = this.settings.instanceId();
    this.integrations = new IntegrationStore(db, box, config.version, () => instanceId);
    this.connections = new ConnectionService(db, box);
    this.titles = new TitleService(db);
    this.lists = new ListService(db);
    this.matcher = new Matcher(db, this.titles, log.child({ component: 'matcher' }));
    this.status = new StatusService(db, this.integrations, this.settings);
    this.activity = new ActivityService(db);
    this.jobs = new JobRunner(db, log.child({ component: 'jobs' }));
  }

  metadata(): MetadataSource | null {
    return metadataSource(this.integrations);
  }
}
