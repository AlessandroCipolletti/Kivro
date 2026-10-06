import type { PrismaClient } from '@kivro/database';
import type { StripeBilling } from '@kivro/billing';
import type { ObjectStore } from '@kivro/storage';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';
import type { AccountMailer } from './account-mail.js';

export interface ApiContext {
  db: PrismaClient;
  storage: ObjectStore;
  billing: StripeBilling | null;
  config: ApiConfig;
  app: FastifyInstance;
  wake: () => Promise<void>;
  tickPlans?: () => Promise<void>;
  initializeInferenceRouting?: () => Promise<void>;
  mailer?: AccountMailer | null;
}
