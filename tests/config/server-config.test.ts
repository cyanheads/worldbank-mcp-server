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

describe('page size clamp configuration', () => {
  it.each([
    ['unset', undefined, true],
    ['blank', '', true],
    ['an unsubstituted placeholder', `\${WORLDBANK_CLAMP_LIMITS}`, true],
    ['true', 'true', true],
    ['false', 'false', false],
    ['0', '0', false],
    ['off', 'off', false],
  ])('reads %s (%s) as clampLimits %s', async (_label, value, expected) => {
    vi.stubEnv('WORLDBANK_CLAMP_LIMITS', value);
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig().clampLimits).toBe(expected);
  });

  it.each(['maybe', '2', 'strict'])('rejects %s, naming the variable', async (value) => {
    vi.stubEnv('WORLDBANK_CLAMP_LIMITS', value);
    const { getServerConfig } = await import('../../src/config/server-config.js');
    expect(getServerConfig).toThrow('WORLDBANK_CLAMP_LIMITS');
  });
});
