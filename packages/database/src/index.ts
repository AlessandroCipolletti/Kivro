import { PrismaClient, Prisma } from '@prisma/client';

export { PrismaClient, Prisma };
export * from '@prisma/client';
export type Transaction = Prisma.TransactionClient;

export function createDatabase(url = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is required');
  return new PrismaClient({ datasources: { db: { url } } });
}

export function isSerializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code)));
}

export async function serializable<T>(db: PrismaClient, operation: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= 7) throw error;
      // Bounded exponential jitter avoids synchronized retries under independent
      // financial traffic while retaining a finite conflict response deadline.
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt) + Math.floor(Math.random() * 25)));
    }
  }
}

export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
