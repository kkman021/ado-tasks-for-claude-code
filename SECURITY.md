# Security Policy

## Supported versions

Only the latest release of `ado-tasks` receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately through GitHub's
**Security → Report a vulnerability** form on this repository (private vulnerability reporting).

Include the affected version, the steps to reproduce, and the impact you observed. You will get
an acknowledgement within 7 days. Please allow time for a fix before disclosing publicly.

## How the mod handles credentials

- **Storage.** The Azure DevOps PAT is stored only in the `env` block of the repository's
  `.claude/settings.local.json`. Before writing it, the mod adds that file to `.gitignore`.
  `.claude/ado.json`, which is meant to be committed, holds only the name of the variable.
- **Lookup.** The token is read from that file (falling back to Claude Code's local settings),
  never from the process environment.
- **Transmission.** The token is sent only as HTTP Basic authentication to the Azure DevOps
  collection named in `.claude/ado.json` and to `vssps.dev.azure.com` for identity lookups,
  over HTTPS.
- **Untrusted code.** The `claude-go-pr` skill builds and tests pull request code with the PAT
  variable removed from the environment, refuses forked pull requests and branch names that a
  shell could interpret, and pushes fast-forward only.
- **Writes.** Every write to Azure DevOps asks for confirmation unless the repository turns that
  confirmation off in `.claude/ado.json`.
- **Cached personal data.** `.claude/ado-members.json` caches project members' names and email
  addresses. Keep it out of version control.

## Recommendations for users

- Create a PAT with only the scopes you use and a short expiry.
- Scope the PAT to the single organization that owns the project.
- Revoke the PAT in Azure DevOps when you stop using the mod or suspect it leaked.
