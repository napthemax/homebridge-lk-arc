# Releasing homebridge-lk-arc

The npm user is **themax**. The GitHub owner is **napthemax**. Do not publish from CI until the trusted publisher below is in place. Do not create an npm token for GitHub Actions.

## First publish (manual)

Do this once, on your own machine, from a clean checkout of `main` at the commit you want on npm.

```bash
git clone https://github.com/napthemax/homebridge-lk-arc.git
cd homebridge-lk-arc
git checkout main
git pull
npm ci
npm run lint
npm run build
npm test
npm login
npm publish --access public
```

`npm login` opens a browser. Sign in as **themax** and approve the 2FA prompt. `publishConfig.access` is already `public`, and `--access public` repeats that for the first publish of a scoped-or-new package. The tarball is whatever `files` lists plus `package.json`: the built `dist/`, `config.schema.json`, README, changelog, and license.

Check the pack before you publish if you want to see that list locally:

```bash
npm pack --dry-run
```

## Trusted publisher

After `homebridge-lk-arc` exists on npm:

1. Open the package on npmjs.com.
2. Settings, then Trusted Publisher.
3. GitHub Actions.
4. Owner `napthemax`, repository `homebridge-lk-arc`, workflow filename `release.yml`.

That lets `.github/workflows/release.yml` publish with GitHub's OIDC token. The workflow has no `NPM_TOKEN` secret. It only runs when a `v*.*.*` tag is pushed, or when you start it by hand from the Actions tab on that tag. It does not run on ordinary pushes or pull requests.

The workflow installs npm 11.5.1 or newer (`npm i -g npm@latest`), runs lint, build, and tests, checks that the tag is `v` plus the `version` in `package.json`, then runs `npm publish`. `publishConfig.provenance` asks npm for a provenance attestation. If the trusted publisher is not configured yet, that publish fails and nothing is released.

Optional, after the trusted publisher works: in the package settings, enable **Require 2FA and disallow tokens**. Manual publishes then need 2FA, and an npm token cannot publish this package.

## Later releases

On `main`, with a clean tree:

1. Bump `version` in `package.json` (and the matching copy in `package-lock.json`) and add a `CHANGELOG.md` section.
2. Commit and push `main`.
3. Tag that commit and push the tag. The tag must be `v` plus the version, for example `v0.1.1` when `package.json` says `"version": "0.1.1"`.

```bash
git tag v0.1.1
git push origin v0.1.1
```

Pushing the tag starts the release workflow. You can also run the Release workflow from the Actions tab with the tag selected as the ref. A dispatch from a branch is rejected by the version check.
