# Releasing `@drisp/cli`

Releases are driven by [release-please](https://github.com/googleapis/release-please).
You almost never cut a release by hand — you merge a PR and the pipeline does the rest.

## How it works

- **`.github/workflows/release.yml`** runs on every push to `main`. The `release-please`
  job maintains a standing **release PR** (titled `chore(main): release cli x.y.z`),
  recalculating the version and changelog from [Conventional Commits](https://www.conventionalcommits.org/).
- Merging that release PR creates the tag `cli-v<x.y.z>` + a GitHub Release, then the
  `publish` job runs CI and `npm publish` (which re-runs lint/typecheck/test/build via
  `prepublishOnly`).
- The release PR is opened with `RELEASE_PLEASE_TOKEN` (a fine-grained PAT with
  **Contents**, **Issues**, and **Pull requests** = Read & write) so it gets CI checks.

Only `feat:` (minor) and `fix:` / breaking (patch/major) commits trigger a release.
`chore:` / `docs:` / `test:` / `refactor:` / `ci:` / `style:` land on `main` but don't
cut a release on their own. `perf` / `refactor` / `revert` show in the changelog; the
rest are hidden (see `release-please-config.json`).

## Normal release

1. Merge feature/fix PRs to `main` as usual — the release PR maintains itself.
2. When ready to ship, open the release PR and sanity-check the version bump + changelog:
   ```sh
   gh pr list --repo drisplabs/cli --label "autorelease: pending"
   ```
3. Merge it **with `--admin`** (the merge queue + disabled auto-merge means a plain merge
   won't go through):
   ```sh
   gh pr merge <PR#> --repo drisplabs/cli --squash --admin
   ```
4. Wait ~1–3 min, then verify:
   ```sh
   npm view @drisp/cli version            # → x.y.z
   gh release view cli-v<x.y.z> --repo drisplabs/cli
   ```

> The **npmjs.com webpage headline lags** behind the registry (cache, minutes to ~1h).
> Trust `npm view @drisp/cli version`, not the website front page.

## Recovery & out-of-band releases

`manual-release.yml` is the escape hatch. It bumps `package.json` + the release-please
manifest, runs the full verification suite, `npm publish`es, tags `cli-v<version>`,
pushes, and drafts a GitHub Release — reusing the tag/release if they already exist.

**npm publish got skipped** (tag + GitHub Release exist, but npm is behind — see the
failure mode in #72). Re-publish the exact stuck version:

```sh
gh workflow run manual-release.yml --repo drisplabs/cli -f version=<x.y.z> -f dry_run=false
```

**Hotfix / out-of-band release** without waiting for the release PR:

```sh
gh workflow run manual-release.yml --repo drisplabs/cli -f version=patch   # or minor | major | 1.2.3
```

> ⚠️ Only run `manual-release.yml` when **no release PR is open** — close it first, or
> the manual tag and release-please will fight over the same version. `manual-release.yml`
> updates the release-please manifest, so once it's done release-please picks up cleanly
> from the new baseline.

Add `-f dry_run=true` to run lint/typecheck/test/build/`npm pack --dry-run` without
publishing.

## Quick reference

| Goal                    | Action                                                     |
| ----------------------- | ---------------------------------------------------------- |
| Routine release         | Merge the release PR with `--admin`                        |
| See what will ship      | Open the `autorelease: pending` PR                         |
| npm stuck behind GitHub | `manual-release.yml -f version=<stuck version>`            |
| Emergency hotfix        | `manual-release.yml -f version=patch` (no open release PR) |
| Confirm published       | `npm view @drisp/cli version`                              |
