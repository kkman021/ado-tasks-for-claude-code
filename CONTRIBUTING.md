# Contributing

## Layout

```
.claude-plugin/marketplace.json   marketplace manifest (this repository is the marketplace)
plugins/ado-tasks/
  .claude-plugin/plugin.json      plugin manifest
  hooks/hooks.json                names the hooks module
  hooks/register.tsx              commands, tools, panel UI
  hooks/ado.ts                    Azure DevOps requests and pure helpers
  hooks/tree.ts                   work item and pull request tree layout
  skills/claude-go/               work item → code skill
  skills/claude-go-pr/            review findings → fixes skill
  tests/                          tests run by `claude plugin test`
  types/index.d.ts                the mod's own types
```

## Local development

1. Clone the repository.
2. Load the plugin from the working copy, for example by adding the clone as a local marketplace:

   ```bash
   claude plugin marketplace add ./
   claude plugin install ado-tasks@ado-tasks-for-claude-code
   ```

3. Start Claude Code once. When it loads the mod, it writes the API type declarations to
   `plugins/ado-tasks/.claude-plugin/types/`. That folder is ignored by git and regenerated after
   each Claude Code update. `plugins/ado-tasks/tsconfig.json` extends the `tsconfig.json` written
   there, so type checking in an editor works only after this step.

## Checks

Run both before opening a pull request:

```bash
claude plugin validate plugins/ado-tasks
claude plugin test plugins/ado-tasks
```

CI runs the same commands.

## Rules

- Keep Azure DevOps calls in `hooks/ado.ts` as request builders and pure parsers; keep engine
  calls (`$.fs`, `$.http`, `$.ui`) in `hooks/register.tsx`.
- Every new write action needs a `confirm` key in `WRITE_ACTIONS`, a confirmation prompt, and a
  test that the request is not sent when the confirmation is refused.
- Add a test for every behavior change.
- Test data uses the fictional organizations `contoso` and `fabrikam` and `@corp.com` addresses.
  Never commit real organization names, project names, people or tokens.
- Bump `version` in `plugins/ado-tasks/.claude-plugin/plugin.json` and add a `CHANGELOG.md` entry
  for each release.

## Releasing

```bash
claude plugin validate plugins/ado-tasks --profile directory
claude plugin test plugins/ado-tasks
claude plugin tag plugins/ado-tasks --push
```

`claude plugin tag` checks that `plugin.json` and `marketplace.json` agree and creates the
`ado-tasks--v<version>` tag.
