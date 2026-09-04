# Security

## The threat model, stated plainly

Bubbly runs an AI agent that **reads and writes your files and runs commands on
your machine**. That is what it is for. Everything below follows from taking
that seriously rather than from pretending otherwise.

### What Bubbly protects against

**Reaching the agent from outside.** The backend binds to `127.0.0.1` only, and
rejects WebSocket upgrades and cross-origin requests from anything that is not
Bubbly. Without that second check, any web page open in your browser could drive
the agent, because a browser can reach `localhost` regardless of what a server
binds to.

**Escaping the workspace.** Every path is resolved and checked against the
workspace root, locally (`resolveSafePath`) and remotely
(`resolveRemotePath`). Both reject `..` traversal, absolute paths outside the
root, and the prefix trick where `/home/u/app-secrets` looks like it is inside
`/home/u/app`.

**Destructive commands.** A denylist refuses `rm -rf /`, fork bombs, `mkfs`,
piped-curl installs and similar, at every permission level.

**Credential leakage.** Secrets are never written to the database, never
returned by an API, never logged, and never included in an error message. Git
output is passed through a redactor before it reaches a log or the UI.

**Losing work.** Every prompt takes a workspace checkpoint you can revert to.

### What Bubbly does not protect against

**A model that decides to do something harmful.** Approvals and the destructive
command list are mitigations, not guarantees. In **Autonomous** mode there is no
approval step at all, which is the point of it — use it in a workspace where the
worst case is acceptable, and prefer a repository with a clean git state.

**Prompt injection from content the agent reads.** A file, a web page or an
issue body can contain instructions aimed at the agent. Bubbly does not execute
such content, and the agent is told to treat what it reads as data — but
treat any workspace containing untrusted content as you would treat running its
code.

**Another process running as you.** The key file fallback protects against other
*users* on the machine and against a stray backup. It does not protect against
something already running with your privileges. Set a vault passphrase if you
need that.

## Credentials

| Where | What |
|---|---|
| OS keychain | The vault's master key, when running the desktop app (DPAPI / Keychain / libsecret via Electron `safeStorage`). |
| `~/.bubbly/vault.json` | Secrets, individually encrypted with AES-256-GCM. |
| `~/.bubbly/vault.key` | The master key when there is no keychain — `0600`, ACL-restricted on Windows. |
| Nowhere | Anything, if you use an ssh-agent or `gh` — Bubbly never sees a secret at all. |

Bubbly prefers credentials you already have: `ssh-agent`, `~/.ssh` keys,
`~/.ssh/config`, your git credential helper, `gh`/`glab`. It asks for a token
only when none of those can answer.

**API keys for model providers** are currently stored in the settings table
rather than the vault, for backward compatibility with existing installs. They
are not returned in full by the settings API. Moving them into the vault is
tracked work.

## Reporting a vulnerability

Open a **private security advisory** on the repository rather than a public
issue. Include what an attacker can do, and the smallest sequence that
demonstrates it.

Please do report:

- a path that escapes the workspace root, locally or over SSH
- a way to reach the backend from another origin or another machine
- a credential appearing in a log, an API response or an error message
- a command that bypasses the approval policy
- injection through a tool argument into a shell, a query or a path

Please do not report, as they are documented behaviour rather than defects:

- the agent doing something destructive that you approved
- the agent doing something destructive in Autonomous mode
- the key file being readable by your own user account
- the ability to run arbitrary commands — that is the product

## Running it safely

- Keep **Guarded** or **Balanced** unless you are deliberately running unattended.
- Run in a git repository with a clean tree, so a bad change is one `git
  checkout` away from gone.
- Do not expose the backend port. It has no authentication because it is not
  meant to be reachable; putting it behind a proxy makes it a remote code
  execution service.
- For SSH workspaces, prefer an agent-backed key and give the account only the
  access the work needs. The agent has exactly the permissions that account has.
