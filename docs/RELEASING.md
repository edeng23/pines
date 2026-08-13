# Releasing

Releases are cut by merging a version bump to `main`. When a push to `main`
carries a `package.json` version that has no `v*` tag yet,
`.github/workflows/release.yml` does the rest: builds, runs the suite,
re-checks the tarball, publishes to npm with provenance, and creates the tag
and GitHub release itself.

```sh
# on a branch: bump "version" in package.json, commit, open a PR, merge it.
# that's the whole ceremony — the workflow tags and publishes on the merge.
```

Merges that don't change the version no-op at the workflow's first step.
Pushing a `v*` tag by hand still works too (same guarded path, and the tag
must match `package.json`) — useful for releasing an older commit.

## One-time bootstrap

The workflow authenticates to npm with OIDC trusted publishing, which means no
`NPM_TOKEN` secret lives in the repo. It has one catch: **OIDC cannot perform a
package's first publish.** npm only lets you attach a trusted publisher to a
package that already exists, and the package cannot exist until something
publishes it. npm/cli#8544 tracks this; PyPI allows pre-registering a publisher
for a package that does not exist yet, npm does not.

So the first release is manual, once, from a machine:

1. `npm login`
2. `pnpm install && pnpm build`
3. `npm publish --access public`
   (`--access public` matters: scoped packages default to restricted, which
   would publish it private and fail for everyone running `npx @edeng23/pines`.)

Then attach the trusted publisher so every later release is automated:

4. Go to `https://www.npmjs.com/package/@edeng23/pines/access`
5. Under **Trusted Publisher**, choose GitHub Actions and enter:
   - Organization or user: `edeng23`
   - Repository: `pines`
   - Workflow filename: `release.yml`
   - Environment: leave blank
6. Merge a version bump to `main`, to confirm the automated path end to end.

After step 5, no npm credential is needed on any machine or in any secret.

## Notes

- npm never lets a version number be reused, even after an unpublish, and the
  unpublish window is only 72 hours. The workflow's guards (tag must match
  `package.json`; an already-tagged version never re-releases) exist because
  getting this wrong costs a version number permanently.
- The publish step passes `--ignore-scripts` to skip `prepublishOnly`. Its
  `typecheck` and `test` already ran as explicit steps in the same job; running
  them twice only doubles exposure to the timing flakes in the daemon and
  extension-status suites.
- If a release fails *after* the npm publish but before the GitHub release,
  just re-run the workflow (or push any commit to `main`): the publish step
  skips versions npm already has, and the release step then repairs the
  missing tag + GitHub release idempotently.
