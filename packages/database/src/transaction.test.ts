import { describe, expect, it } from 'vitest';
import { Prisma, isSerializationConflict } from './index.js';

describe('serializable transaction conflicts', () => {
  const error = (code: string, sqlState?: string) => new Prisma.PrismaClientKnownRequestError('Synthetic database error',
    { code, clientVersion: 'test', ...(sqlState ? { meta: { code: sqlState } } : {}) });
  it('retries ORM and raw PostgreSQL serialization/deadlock conflicts only', () => {
    expect(isSerializationConflict(error('P2034'))).toBe(true);
    expect(isSerializationConflict(error('P2010', '40001'))).toBe(true);
    expect(isSerializationConflict(error('P2010', '40P01'))).toBe(true);
    expect(isSerializationConflict(error('P2010', '23505'))).toBe(false);
    expect(isSerializationConflict(error('P2002'))).toBe(false);
    expect(isSerializationConflict(new Error('40001'))).toBe(false);
  });
});
