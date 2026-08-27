# Security Policy

## The threat model, stated plainly

claude-autosend exists to run a coding agent on your machine without you sitting there. Anyone who can reach its HTTP API can schedule arbitrary prompts into `claude` on your host. Treat it as a local developer tool, never as a service.

### What the project does to keep that contained

- **Binds to `127.0.0.1` by default.** The server is not reachable from your network unless you change `HOST` on purpose.
- **No authentication is implemented.** That is a consequence of the above, not an oversight — loopback is the boundary. If you expose this beyond loopback you must put your own authentication and TLS in front of it.
- **`--dangerously-skip-permissions` is opt-in.** `CLAUDE_FLAGS` is empty by default, so Claude Code's approval prompts stay on until you deliberately disable them.
- **Prompts travel by temp file, not by command line.** They are written to the OS temp directory, read into a PowerShell variable, and deleted after use. This avoids shell-escaping bugs and keeps prompt text out of process arguments.
- **Every interpolated value is quoted as a PowerShell literal.** PID input is parsed as an integer before it reaches a script.

### What you are accepting when you run it

- Scheduled prompts execute with **your** user privileges, in the directory you configured.
- With `CLAUDE_FLAGS=--dangerously-skip-permissions`, an unattended agent can modify, delete, or commit files without asking. Point `CLAUDE_WORKDIR` at a repository you can restore, and commit before you go to bed.
- Existing-window delivery uses the clipboard and `SendKeys`. It **overwrites your clipboard** and types into whatever window ends up focused. Do not use it on a machine someone else is actively using.

### Hardening checklist

- [ ] Keep `HOST=127.0.0.1`
- [ ] Point `CLAUDE_WORKDIR` at a git repository with a clean tree
- [ ] Turn on `--dangerously-skip-permissions` only for prompts whose blast radius you accept
- [ ] Stop the server when you are not using it
- [ ] Never commit your `.env`

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/Rafaelrr5/claude-autosend/security/advisories/new) rather than opening a public issue.

Expect an initial response within 7 days. This is a personal project maintained in spare time — there is no SLA, and that is stated up front rather than implied.
