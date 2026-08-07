# Releasing

Releases are cut by pushing a tag. `.github/workflows/release.yml` does the rest:
it verifies the tag against `package.json`, builds, runs the suite, re-checks the
tarball, publishes to npm with provenance, and opens the GitHub release.

```sh
# bump "version" in package.json first, and commit it
git tag v0.2.0
git push origin v0.2.0
```

Nothing publishes on a branch push. Only a `v*` tag triggers the workflow.

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
6. Tag `v0.1.0` and push it, to confirm the automated path works end to end.

After step 5, no npm credential is needed on any machine or in any secret.

## Notes

- npm never lets a version number be reused, even after an unpublish, and the
  unpublish window is only 72 hours. The workflow's tag-vs-`package.json` check
  exists because getting this wrong costs a version number permanently.
- The publish step passes `--ignore-scripts` to skip `prepublishOnly`. Its
  `typecheck` and `test` already ran as explicit steps in the same job; running
  them twice only doubles exposure to the timing flakes in the daemon and
  extension-status suites.
- If a release fails *after* the npm publish but before the GitHub release, do
  not retag. Create the GitHub release by hand:
  `gh release create v0.2.0 --generate-notes`.
