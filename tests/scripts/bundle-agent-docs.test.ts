/**
 * @fileoverview Bundle pruning must preserve dependency runtime skills modules.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

describe('bundle agent documentation pruning', () => {
  it('keeps SDK runtime skills while stripping package-root author documentation', () => {
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
      'node_modules/example/dist/skills/runtime.js',
      'skills/worldbank-data/SKILL.md',
    ];
    const docs = [
      'node_modules/example/skills/author/SKILL.md',
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/parent/node_modules/example/.claude/skills/author/SKILL.md',
      'node_modules/example/.agents/skills/author/SKILL.md',
      'node_modules/example/SKILL.md',
    ];
    expect(filterAgentDocEntries([...runtime, ...docs])).toEqual(docs);
  });

  it('uses the same package-root selector in the packaging validator', () => {
    const source = readFileSync(
      new URL('../../scripts/lint-packaging.ts', import.meta.url),
      'utf8',
    );
    const declaration = source.match(/export const AGENT_DOC_ENTRY =\s*([^;]+);/);
    expect(declaration?.[1]).toBe(AGENT_DOC_ENTRY.toString());
  });
});
