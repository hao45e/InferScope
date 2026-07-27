# Contributing

## Before you open a PR

```bash
cd src-tauri && cargo test && cargo clippy   # must be zero warnings
npx tsc --noEmit
```

CI (`.github/workflows/ci.yml`) runs these same checks — plus a check that
`package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` all
report the same version — on every push and pull request to `main`.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer(s)]
```

`scope` is optional and usually a rough area of the codebase (`bench`,
`ui`, `history`, `ci`, ...).

| Type | Use for |
|---|---|
| `feat` | A new user-facing feature |
| `fix` | A bug fix |
| `perf` | A performance improvement |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `style` | Formatting, whitespace — no code meaning change |
| `test` | Adding or correcting tests |
| `build` | Build system, dependencies, packaging |
| `ci` | CI/CD workflow changes |
| `chore` | Everything else (housekeeping, version bumps) |

Breaking changes: add `!` after the type/scope (`feat!: ...`) **and** a
`BREAKING CHANGE:` footer explaining what breaks and how to migrate.

```
feat(bench): add p99.9 latency percentile

fix(history): correct delta sign in comparison table

feat(config)!: rename `max_retries` to `retry_count` in BenchConfig

BREAKING CHANGE: saved configs from before this version use `max_retries`
and will fail to deserialize; delete `~/.config/inferscope/last_config.json`
or migrate the key manually.
```

Why this matters here: the commit type is what decides the next version
number at release time — see [RELEASING.md](./RELEASING.md).

## Opening a PR

- Keep PRs scoped to one change; unrelated cleanup belongs in its own PR.
- Update `CHANGELOG.md` under `[Unreleased]` for any user-facing change
  (see [RELEASING.md](./RELEASING.md) for the format).
- Match existing conventions: comments in Chinese, identifiers in English
  (see `CLAUDE.md`).
