# Repository workflow

- Commit your completed changes after the relevant checks pass. Do not leave finished work uncommitted unless Domi explicitly asks you to.
- Keep commits focused and include only your own changes. Do not push unless asked.

## Package scripts

- Use `dev` for watched development, `build` for a one-time release build, and `start` to run an existing build without watching or rebuilding. Name app installation commands explicitly, such as `install:linux`; keep `pnpm install` for dependencies.
- Give frontend-only commands a `:web` suffix. Document whether each command builds, watches, launches, or installs. Prepare required runtime dependencies automatically from the commands that need them.
