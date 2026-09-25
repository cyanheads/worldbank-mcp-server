# worldbank-mcp-server - Directory Structure

Generated on: 2026-09-25 17:06:29

```text
worldbank-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── worldbank-country.resource.ts
│   │   │       └── worldbank-indicator.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── worldbank-get-country.tool.ts
│   │       │   ├── worldbank-get-data.tool.ts
│   │       │   ├── worldbank-get-indicator.tool.ts
│   │       │   ├── worldbank-get-poverty.tool.ts
│   │       │   ├── worldbank-list-countries.tool.ts
│   │       │   ├── worldbank-list-sources.tool.ts
│   │       │   ├── worldbank-list-topics.tool.ts
│   │       │   ├── worldbank-search-indicators.tool.ts
│   │       │   └── worldbank-search-projects.tool.ts
│   │       ├── page-past-end-notice.ts
│   │       └── page-size-reduced-notice.ts
│   ├── services/
│   │   ├── pip/
│   │   │   ├── pip-service.ts
│   │   │   └── types.ts
│   │   ├── projects/
│   │   │   ├── portfolio-country-codes.ts
│   │   │   ├── projects-service.ts
│   │   │   └── types.ts
│   │   ├── worldbank/
│   │   │   ├── identifiers.ts
│   │   │   ├── latest-values.ts
│   │   │   ├── periods.ts
│   │   │   ├── source-scoped.ts
│   │   │   ├── types.ts
│   │   │   └── worldbank-service.ts
│   │   ├── response-budget.ts
│   │   └── shared-load.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   └── indicator-ranking-catalog.json
│   ├── prompts/
│   ├── resources/
│   │   ├── worldbank-country.resource.test.ts
│   │   └── worldbank-indicator.resource.test.ts
│   ├── services/
│   │   ├── pip/
│   │   │   └── pip-service.test.ts
│   │   ├── projects/
│   │   │   ├── projects-service-http.test.ts
│   │   │   └── projects-service.test.ts
│   │   └── worldbank/
│   │       ├── latest-values.test.ts
│   │       ├── source-scoped-data.test.ts
│   │       ├── source-scoped.test.ts
│   │       └── worldbank-service.test.ts
│   └── tools/
│       ├── page-size-reduced-notice.test.ts
│       ├── service-errors-on-the-wire.test.ts
│       ├── worldbank-get-country.tool.test.ts
│       ├── worldbank-get-data-countries.test.ts
│       ├── worldbank-get-data-frequency.test.ts
│       ├── worldbank-get-data-latest.test.ts
│       ├── worldbank-get-data-page-cap.test.ts
│       ├── worldbank-get-data.tool.test.ts
│       ├── worldbank-get-indicator.tool.test.ts
│       ├── worldbank-get-poverty-routing.test.ts
│       ├── worldbank-get-poverty.tool.test.ts
│       ├── worldbank-list-countries-page-cap.test.ts
│       ├── worldbank-list-countries.tool.test.ts
│       ├── worldbank-list-sources.tool.test.ts
│       ├── worldbank-list-topics.tool.test.ts
│       ├── worldbank-search-indicators.tool.test.ts
│       ├── worldbank-search-projects-countries.test.ts
│       └── worldbank-search-projects.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
