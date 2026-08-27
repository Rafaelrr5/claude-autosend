# Contributing

Thanks for taking a look. This is a small, focused tool and it should stay that way.

## Getting set up

```bash
git clone https://github.com/Rafaelrr5/claude-autosend.git
cd claude-autosend
npm install
cp .env.example .env
npm start
```

You need Windows, Node 18+, and the Claude Code CLI on your `PATH`.

## Before opening a pull request

There is no test suite yet. Verify by hand and say so in the PR description:

1. `npm run check` passes (syntax check on both JS files).
2. The server starts and the UI loads at `http://127.0.0.1:3847`.
3. `/api/time`, `/api/windows`, and `/api/schedules` all respond.
4. If you touched scheduling: create a schedule about a minute out and confirm it actually fires.

## Style

Match what is already there. Two-space indent, no build step, no framework, no transpiler. Dependencies are a cost — Express is the only one, and adding a second needs a reason in the PR.

Comments explain **why**, not what. If a line looks odd, the comment should say what would break without it.

## Good first contributions

- Translate the UI strings to English behind a language toggle (the code and docs are English, the interface is not).
- Persist schedules to disk so a server restart does not lose pending jobs.
- Add a real test for `msUntilTarget`, including the day-rollover case.
- Add GitHub Actions running `npm run check` on push.

## Reporting bugs

Include your Windows version, Node version, `claude --version`, and the server console output. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
