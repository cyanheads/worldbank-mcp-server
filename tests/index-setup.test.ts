/**
 * @fileoverview The entry point's setup(): the server config is validated before
 * any service is initialized, so an invalid WORLDBANK_* variable stops startup.
 * @module tests/index-setup.test
 */
import { createInMemoryStorage } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';

type AppOptions = { setup: (core: { config: unknown; storage: unknown }) => void };

const app = vi.hoisted(() => ({ options: undefined as AppOptions | undefined }));
vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(async (options: AppOptions) => {
    app.options = options;
  }),
}));

const inits = vi.hoisted(() => ({ worldbank: vi.fn(), pip: vi.fn(), projects: vi.fn() }));
vi.mock('@/services/worldbank/worldbank-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/worldbank/worldbank-service.js')>()),
  initWorldBankApiService: inits.worldbank,
}));
vi.mock('@/services/pip/pip-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/pip/pip-service.js')>()),
  initPipService: inits.pip,
}));
vi.mock('@/services/projects/projects-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/projects/projects-service.js')>()),
  initProjectsService: inits.projects,
}));

it('stops setup on an invalid WORLDBANK_CLAMP_LIMITS before initializing any service', async () => {
  vi.stubEnv('WORLDBANK_CLAMP_LIMITS', 'maybe');
  await import('@/index.js');

  expect(() => app.options?.setup({ config: {}, storage: createInMemoryStorage() })).toThrow(
    'WORLDBANK_CLAMP_LIMITS',
  );
  expect(inits.worldbank).not.toHaveBeenCalled();
  expect(inits.pip).not.toHaveBeenCalled();
  expect(inits.projects).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
