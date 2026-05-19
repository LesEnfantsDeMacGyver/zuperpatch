# Agent Instructions

- Always deploy after changes are committed locally. Use `npm run deploy:vps`; the VPS keeps a Git checkout in `/opt/zuperpatch`, pulls `origin/main`, builds there, and restarts the `zuperpatch` container.
- Do not add compatibility bridges or migration paths unless the user explicitly asks for them; this app is not public yet, so keep the code explicit and maintainable.
- When a feature is done, create a descriptive semantic commit with a message and body that explain the feature, then push it without waiting for an explicit reminder.
- Keep the realistic sample project at `samples/plan.zuperpatch.json`; use it for README screenshots, manual validation, and feature checks when a populated plan is useful.
