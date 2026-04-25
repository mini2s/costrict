# CoStrict Change Log

> For the complete history, please visit [CHANGELOG_ARCHIVE.md](./CHANGELOG_ARCHIVE.md)

## [2.7.6]

- Unify error handling across providers and improve retry UX (#1156)
- Add Deepseek-v4 model support for Costrict provider
- Add GPT-5.5 model support
- Optimize skills prompts

## [2.7.5]

- Fix security-review skills subdir

## [2.7.4]

- Add copy login URL to clipboard feature in auth service
- Update Auto model message formatting processing for Costrict provider

## [2.7.3]

- Add previous checkpoint navigation controls
- Add Claude Opus 4.7 model support for Vertex AI
- Increase telemetry data limits
- Update deploy config
- Sync roocode [last commit](https://github.com/RooCodeInc/Roo-Code/commit/2bb826039b0ae509bf3dd4424c888e25b21c8543)
- Fix known issues

## [2.7.2]

- Optimize ContextSyncService with pause/resume mechanism for better performance
- Add test coverage for CLI wrap components (ContextSyncService, TerminalManager)
- Update dependencies and apply security patches including vite, drizzle-orm, and basic-ftp
- Update API provider specifications and i18n support
- Fix known issues

## [2.7.1]

- Update docs
- Add provider profile
- Add security review internationalization support and subreview mode
- Remove codebase-indexer and migrate to runtime-config
- Sync roocode [last commit](https://github.com/RooCodeInc/Roo-Code/commit/cb836567180a3ff1da6d082f3178b90c3bd22a70)
- Fix known issues

## [2.7.0]

- Optimize performance
- Optimize ChatView component rendering
- Refactor provider settings to support custom values via ContextProxy
- Fix CodeReviewService createTask mode parameter passing
- Fix known issues
