/**
 * @fileoverview Validate page counts at the environment boundary.
 * @module tests/config/server-config.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('default page size configuration', () => {
  it.each(['0', '-1', '1.5'])('rejects %s before a request can use it', async (value) => {
    vi.stubEnv('WORLDBANK_DEFAULT_PER_PAGE', value);
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig).toThrow('WORLDBANK_DEFAULT_PER_PAGE');
  });

  it.each(['', `\${WORLDBANK_DEFAULT_PER_PAGE}`])('treats %s as unset', async (value) => {
    vi.stubEnv('WORLDBANK_DEFAULT_PER_PAGE', value);
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig().defaultPerPage).toBe(50);
  });

  it('accepts a positive integral page size', async () => {
    vi.stubEnv('WORLDBANK_DEFAULT_PER_PAGE', '200');
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig().defaultPerPage).toBe(200);
  });
});
