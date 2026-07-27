# Releasing

InferScope follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`)
and [Keep a Changelog](https://keepachangelog.com/).

## Choosing the next version

Look at the commits (see [CONTRIBUTING.md](./CONTRIBUTING.md) for the commit
convention) since the last tag:

| If the commits since last release include... | Bump |
|---|---|
| any `!` breaking change / `BREAKING CHANGE:` footer | **MAJOR** — `x.0.0` |
| any `feat` (and no breaking change) | **MINOR** — `0.x.0` |
| only `fix` / `perf` / `refactor` / `docs` / etc. | **PATCH** — `0.0.x` |

Pre-1.0 (current: `0.x.y`), a breaking change bumps **MINOR** instead of
MAJOR, per SemVer's pre-release rule — `0.MINOR.PATCH`.

```bash
git log v0.1.0..HEAD --oneline
```

## Release checklist

1. **Update the changelog.** Move everything under `## [Unreleased]` in
   `CHANGELOG.md` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
2. **Bump the version in all three places** — they must match exactly
   (CI enforces this):
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `src-tauri/tauri.conf.json` → `"version"`
3. **Commit:**
   ```bash
   git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md
   git commit -m "chore(release): vX.Y.Z"
   ```
4. **Tag and push:**
   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
5. **CI takes over.** Pushing the tag triggers
   `.github/workflows/release.yml`, which builds installers for macOS
   (Apple Silicon + Intel), Windows, and Linux, and uploads them to a
   **draft** GitHub Release named after the tag.
6. **Review and publish.** Open the draft release on GitHub, paste the
   new `CHANGELOG.md` section into the release notes (replacing the
   default body), verify all platform artifacts are attached, then
   click **Publish**.

## Patch/hotfix releases

Same flow — a `fix`-only set of commits just gets a PATCH bump
(`0.1.0` → `0.1.1`). There is no separate release branch; tag off `main`.
