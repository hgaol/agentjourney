# Distributing and Publishing AgentJourney

## Status

AgentJourney currently runs from a pnpm workspace with `pnpm dev`. This document defines the path to a single public npm package that can be tried with `npx`, installed globally for regular use, and published through a provenance-producing release workflow.

This document is an implementation and release guide, not a statement that a package has already been published. [ADR 0045](adr/0045-run-from-source-with-pnpm-for-now.md) remains the current decision until the distribution work is completed and a replacement ADR is accepted.

## Distribution decision

Publish **one platform package** named `agentjourney`, if the name remains available. Do not publish the internal `@agentjourney/*` workspace modules as a family of public libraries.

Target user commands:

```bash
# Try the prerelease without a global installation
npx --yes agentjourney@next

# Equivalent pnpm command
pnpm dlx agentjourney@next

# Regular installation after a stable release
npm install --global agentjourney
agentjourney
```

`npx` downloads package code from the npm registry, but AgentJourney runtime data remains local. The application must not add accounts, cloud storage, telemetry, or agent control as part of distribution.

The command should run in the foreground, open the local browser interface by default, and stop cleanly on `Ctrl+C`. Removing or updating the npm package must not remove the archive under `~/.agentjourney`.

## Supported environments

The first npm release should support the environments already targeted by the source tree:

- macOS x64 and arm64;
- Linux x64 and arm64;
- native Windows x64;
- WSL as its own Host Environment.

Node.js remains an external prerequisite for the npm distribution. Keep the existing minimum of Node `>=22.19.0` unless release testing establishes a higher floor. A later standalone executable or desktop installer can use Node Single Executable Applications or another wrapper, but that is a separate distribution channel and should not block npm delivery.

## Package architecture

### One public package

Add a dedicated publishable workspace, for example:

```text
apps/distribution/
├── package.json
├── src/
│   └── cli.ts
├── dist/
│   ├── cli.js
│   └── web/
│       ├── index.html
│       └── assets/...
├── README.md
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

The package should contain:

1. one Node CLI entry point;
2. the bundled AgentJourney host and internal workspace implementation;
3. the production Vite Web build;
4. only the runtime dependencies that cannot safely be bundled;
5. package documentation and required license notices.

The package must not contain:

- `.agentjourney/` archives;
- local auth tokens or settings;
- native source histories;
- test results, traces, screenshots, or temporary MP4 frames;
- test fixtures;
- development plugin directories;
- `.env` files;
- Git metadata;
- unpublished planning or implementation artifacts.

Use the package `files` allowlist rather than relying only on `.npmignore`.

### Keep internal modules private

The existing host build leaves imports such as `@agentjourney/archive` and `@agentjourney/plugin-runtime` external. That output cannot run when installed as a single npm package unless those private workspace modules are separately published.

For distribution, configure the CLI/host bundle to include every `@agentjourney/*` workspace dependency. Keep asset-bearing third-party packages external where bundling would break runtime lookup. Verify the resulting bundle rather than assuming the development `tsup` output is publishable.

A suitable bundling policy is:

- **bundle:** all `@agentjourney/*` modules and ordinary pure-JavaScript dependencies;
- **externalize and declare:** QuickJS/WASM packages, the selected FFmpeg integration, and Playwright browser-launching packages;
- **copy:** the production Web assets;
- **never include:** Playwright browser downloads.

The final decision must be proven by installing the packed tarball into an empty directory with no workspace symlinks.

## Required host refactor

### Extract startup from the executable module

`apps/host/src/main.ts` currently creates dependencies and starts listening at module evaluation time. Extract a callable module such as:

```ts
interface StartAgentJourneyOptions {
  dataDirectory: string;
  port: number;
  openBrowser: boolean;
}

interface RunningAgentJourney {
  url: string;
  close(): Promise<void>;
}

function startAgentJourney(
  options: StartAgentJourneyOptions
): Promise<RunningAgentJourney>;
```

The CLI should be a thin adapter over this interface. Tests should start the same host module without spawning the CLI.

### Serve the production Web UI

The published package must run one process and one loopback origin. It must not require Vite.

Development remains:

```text
Host :4317 → redirects to Vite :5173
```

Published operation becomes:

```text
AgentJourney :4317
├── /api/v1/*
├── /assets/*
└── SPA index.html
```

Use Fastify's static-file plugin or an equivalently bounded implementation. Resolve Web assets relative to the installed package with `import.meta.url`, never the caller's current working directory.

The authenticated bootstrap URL should still carry the installation secret only long enough for the Web client to exchange it for its local session and remove it from browser history. The host must remain bound to `127.0.0.1`; do not add a public `--host 0.0.0.0` option to the initial CLI.

## CLI interface

The no-argument command should start AgentJourney:

```text
agentjourney [start]

Options:
  --port <number>       Loopback port; default 4317
  --data-dir <path>     Archive/config root; default ~/.agentjourney
  --no-open             Print the local URL without opening a browser
  --version             Print package version and exit
  --help                Print usage and exit
```

Recommended behavior:

- Reject invalid ports and relative ambiguity in `--data-dir`.
- Create the data directory with restrictive permissions where supported.
- If the configured port belongs to a compatible AgentJourney process, open that instance instead of starting a duplicate.
- If another application owns the port, report a clear error and suggest `--port`.
- Open the browser with a cross-platform library or tested macOS/Linux/Windows adapters.
- Print the non-secret base URL; do not print credentials in routine logs.
- Handle `SIGINT` and `SIGTERM` by stopping scanning, closing Fastify, closing SQLite, and deleting no archive data.
- Do not launch, wrap, or send input to a coding agent.

## Proposed package metadata

The publishing package should start with an alpha version and explicit metadata:

```json
{
  "name": "agentjourney",
  "version": "0.1.0-alpha.1",
  "description": "Local-first forensic review and replay for coding-agent histories",
  "license": "<chosen-project-license>",
  "type": "module",
  "bin": {
    "agentjourney": "dist/cli.js"
  },
  "files": [
    "dist/**",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ],
  "engines": {
    "node": ">=22.19.0"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/<owner>/<repository>.git"
  },
  "bugs": {
    "url": "https://github.com/<owner>/<repository>/issues"
  },
  "homepage": "https://github.com/<owner>/<repository>#readme",
  "keywords": [
    "coding-agent",
    "claude-code",
    "codex",
    "copilot",
    "pi",
    "replay",
    "local-first"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

The CLI file must begin with:

```js
#!/usr/bin/env node
```

Do not set `private: true` on the publishing package. Keep the monorepo root and internal workspaces private.

No Git remote is currently configured in this checkout. Configure the canonical repository before publishing, and make `repository.url` match its case-sensitive GitHub location so npm provenance can link the package to the correct source.

## Licensing and third-party review

A project `LICENSE` file is currently absent. Choosing and adding the AgentJourney license is a release blocker; dependency licenses do not license AgentJourney's own code.

Generate and review `THIRD_PARTY_NOTICES.md` and a machine-readable software bill of materials for every release artifact. Pay particular attention to runtime binaries and code copied into the Web bundle.

The current FFmpeg dependency needs an explicit distribution decision:

- `@ffmpeg-installer/ffmpeg@1.1.0` selects platform packages through optional dependencies;
- its Linux x64 package identifies a 2018 FFmpeg build and declares GPLv3;
- the available package matrix does not include native Windows arm64;
- a static top-level import may prevent the rest of AgentJourney from starting on an unsupported platform.

Before public release, either replace this dependency with a maintained and legally reviewed strategy or make MP4 a capability that can be unavailable without preventing archive/review startup. Prefer system FFmpeg discovery plus a clear diagnostic; dynamically load the fallback implementation only when an export is requested.

`playwright-core` does not provide a browser installation by itself. The npm install must not silently download a browser. MP4 export should continue to discover installed Chromium, Chrome, or Edge and explain the optional Playwright browser-install command when none is available.

QuickJS depends on separately packaged WASM artifacts. Tarball smoke tests must exercise both Renderer and Source Adapter sandbox startup to prove those files resolve after npm installation.

Astryx and other Web dependencies should be compiled into static Web assets during release. They should not become runtime dependencies of the public CLI merely because the monorepo Web workspace uses them at build time.

## Build pipeline

Add one deterministic command, for example:

```bash
pnpm release:pack
```

It should:

1. require a clean Git worktree;
2. verify the package version and release tag agree;
3. run contract generation;
4. run strict TypeScript checks;
5. run unit and integration tests;
6. build the production Web application;
7. bundle the CLI/host with internal workspaces included;
8. copy Web assets into the publishing package;
9. copy README, LICENSE, and third-party notices;
10. remove source maps if the release policy excludes them;
11. run package-content and secret checks;
12. create the npm tarball with `npm pack`;
13. install and execute that tarball in a clean temporary environment.

Do not build the tarball from a developer's existing `apps/web/dist` directory without rebuilding it from the tagged source.

## Tarball verification

Inspect the exact artifact npm will receive:

```bash
cd apps/distribution
npm pack --dry-run --json
npm pack
```

Automate assertions over the JSON file list and unpacked tarball:

- one executable `bin` target exists;
- every referenced Web asset exists;
- no workspace protocol remains in the packed `package.json`;
- no import of a private `@agentjourney/*` package remains in the CLI bundle;
- no absolute build-machine paths remain;
- no archive, auth token, source fixture, `.env`, or test trace is present;
- package and unpacked sizes stay under recorded budgets;
- the package version equals the Git tag.

A clean-install smoke test should use the tarball, not the repository:

```bash
mkdir /tmp/agentjourney-smoke
cd /tmp/agentjourney-smoke
npm init -y
npm install /path/to/agentjourney-0.1.0-alpha.1.tgz
npx agentjourney --version
npx agentjourney --no-open --data-dir ./data --port 4318
```

Drive startup/health/shutdown with a cross-platform Node test rather than POSIX-only shell process management. The test should verify:

- `/api/v1/health` becomes ready;
- the production SPA and hashed assets load from the host;
- direct SPA navigation falls back to `index.html`;
- local authorization completes;
- one fixture can be imported and reviewed;
- QuickJS sandbox evaluation works;
- `Ctrl+C`/termination closes cleanly;
- restarting with the same data directory retains the Journey;
- uninstalling the package does not remove that data directory.

## Release channels

Use npm dist-tags deliberately:

| Version | npm dist-tag | User command |
|---|---|---|
| `0.1.0-alpha.N` | `next` | `npx --yes agentjourney@next` |
| `0.1.0-beta.N` | `next` | `npx --yes agentjourney@next` |
| `0.1.0` and later stable | `latest` | `npx --yes agentjourney@latest` |

Never publish development commits to `latest`. Never reuse or overwrite a published version. Commit the version change, tag that exact commit as `v<version>`, and create a matching GitHub Release.

The npm registry returned `E404` for `agentjourney` on 2026-09-04, so the unscoped name appeared unused at that moment. This is not a reservation; check again immediately before the first publication and keep a scoped fallback such as `@<owner>/agentjourney` if ownership cannot be established.

## First publication

Trusted Publisher settings normally live on an existing npm package page, so the first package version needs a bootstrap publication path.

Recommended bootstrap:

1. create and secure the npm owner account with 2FA;
2. verify the final package name again;
3. build and inspect `0.1.0-alpha.1` from a clean tagged commit;
4. publish the first alpha manually with 2FA, or through a one-use granular automation token from the protected release workflow;
5. publish it under `next`, not `latest`;
6. configure npm Trusted Publishing for the exact repository and workflow filename;
7. remove the bootstrap token;
8. use OIDC Trusted Publishing for every subsequent release.

Example bootstrap command after reviewing the tarball:

```bash
npm publish ./agentjourney-0.1.0-alpha.1.tgz \
  --access public \
  --tag next
```

A local manual publication cannot generate CI-backed provenance. If provenance on the first version is required, perform the bootstrap through a GitHub-hosted release job with a narrowly scoped one-use token and `--provenance`, then delete that token.

## Trusted Publishing and provenance

Use npm Trusted Publishing with GitHub Actions rather than storing a long-lived npm write token. npm currently requires npm CLI `>=11.5.1`, Node `>=22.14.0`, a supported cloud-hosted runner, and `id-token: write` for this flow.

Configure the npm package's Trusted Publisher with:

- GitHub organization/user;
- repository name;
- exact workflow filename, such as `publish.yml`;
- an optional protected GitHub environment, such as `npm`;
- direct `npm publish` or staged-publish permission according to release policy.

A release workflow can follow this shape:

```yaml
name: Publish npm package

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

concurrency:
  group: npm-publish-${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    if: startsWith(github.event.release.tag_name, 'v')
    runs-on: ubuntu-latest
    environment: npm
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}

      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - name: Install npm with Trusted Publishing support
        run: npm install --global npm@^11.5.1

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm e2e
      - run: pnpm release:pack

      - name: Verify tag and choose dist-tag
        id: release
        shell: bash
        run: |
          VERSION=$(node -p "require('./apps/distribution/package.json').version")
          test "v$VERSION" = "${{ github.event.release.tag_name }}"
          if [[ "$VERSION" == *-* ]]; then
            echo "tag=next" >> "$GITHUB_OUTPUT"
          else
            echo "tag=latest" >> "$GITHUB_OUTPUT"
          fi

      - name: Publish with OIDC
        run: npm publish ./apps/distribution --access public --tag "${{ steps.release.outputs.tag }}"
```

Trusted Publishing automatically produces provenance for supported GitHub-hosted workflows. If a token-based transitional workflow is used instead, add `--provenance` and ensure the package's case-sensitive `repository` metadata matches the build repository.

Protect the `npm` GitHub environment with required reviewers for stable releases. Do not run the publish job on ordinary pushes or pull requests.

## Release procedure

### Before tagging

1. Confirm `main` is green on Linux, macOS, native Windows, and browser CI.
2. Run local compatibility checks for Claude Code, Codex CLI, Pi, and Copilot CLI without uploading source data.
3. Review changes since the previous release.
4. Update package version and changelog.
5. Verify package name ownership and npm account access.
6. Verify license and third-party notices.
7. Run `pnpm release:pack` and inspect the tarball.
8. Run tarball smoke tests on every supported OS.
9. Confirm no local archive or credential appears in the package listing.
10. Merge the release commit and tag it as `v<version>`.

### Publishing

1. Create the GitHub Release from the existing tag.
2. Let the protected Trusted Publishing workflow build from that tag.
3. Verify npm reports the expected version and dist-tag.
4. Verify provenance/signatures.
5. Install from npm in fresh macOS, Linux, and Windows environments.
6. Run `agentjourney --version` and a foreground start/stop smoke test.

### After publishing

```bash
npm view agentjourney@0.1.0-alpha.1 \
  name version dist-tags dist.integrity dist.shasum repository

npm audit signatures
npx --yes agentjourney@next --version
```

Also verify:

- `npx --yes agentjourney@next --no-open` starts the local host;
- the browser UI loads without Vite;
- the archive persists across reinstall and version upgrade;
- MP4 availability is correctly reported for each OS/browser/FFmpeg combination;
- no runtime request leaves the loopback origin except an explicit package installation performed by the user.

## Rollback and incident response

Published npm versions are immutable. If a release is defective:

1. stop promoting it;
2. move the affected dist-tag to the last good version where appropriate;
3. deprecate the bad version with a specific message;
4. publish a new patch/prerelease version;
5. document whether archive migration or rollback is safe.

Example:

```bash
npm deprecate agentjourney@0.1.0-alpha.3 \
  "Known startup defect; upgrade to 0.1.0-alpha.4"

npm dist-tag add agentjourney@0.1.0-alpha.2 next
```

Avoid unpublishing except for a genuine security/legal emergency and only within npm policy. Never tell users to delete `~/.agentjourney` as a package rollback step.

For a compromised release workflow:

- disable the npm Trusted Publisher;
- disable the GitHub environment/workflow;
- deprecate affected versions;
- rotate any bootstrap or read-capable credentials;
- publish an incident statement and a verified replacement release.

## CI and release acceptance matrix

| Capability | Linux | macOS | Windows | WSL |
|---|---:|---:|---:|---:|
| Tarball install and `--version` | Required | Required | Required | Manual gate initially |
| Host start/health/stop | Required | Required | Required | Required before stable |
| Production SPA and authorization | Required | Required | Required | Required before stable |
| Archive persistence across upgrade | Required | Required | Required | Required before stable |
| QuickJS renderer/adapter sandbox | Required | Required | Required | Required before stable |
| Manual passive discovery | Required | Required | Required | Required before stable |
| Automatic scan lifecycle | Required | Required | Required | Required before stable |
| MP4 capability detection | Required | Required | Required | Required before stable |
| MP4 encode where supported | Required | Required | Required | Documented matrix |
| Interactive HTML export/preview | Required | Required | Required | Required before stable |

Native Windows and WSL must use separate test data directories and must not be treated as one Host Environment.

## Privacy and security requirements

Publishing must not weaken AgentJourney's runtime contract:

- bind only to loopback;
- retain local authenticated bootstrap and CSRF protection;
- keep archives intentionally unencrypted and clearly disclose that fact;
- perform no telemetry or update checks;
- never upload Journey content in compatibility checks;
- never launch or control coding agents;
- default scans to manual;
- default presentation exports to redacted;
- keep executable plugins sandboxed;
- keep Journey Packages data-only;
- make package updates explicit user actions through npm/pnpm.

The npm registry, GitHub Releases, Sigstore, and transparency logs necessarily receive public package/release metadata and package code. They must never receive user Journey content.

## Implementation milestones

### Milestone A — Package skeleton

- Choose project license.
- Configure canonical Git remote and repository metadata.
- Create the publishable `agentjourney` workspace and CLI.
- Refactor host startup behind a callable interface.
- Add version/help argument handling.

### Milestone B — One-process production runtime

- Serve built Web assets from Fastify.
- Preserve local auth bootstrap on one origin.
- Open the browser cross-platform.
- Add clean shutdown and port-conflict behavior.

### Milestone C — Self-contained bundle

- Bundle all private workspace modules.
- Externalize only verified asset-bearing runtime packages.
- Resolve QuickJS/WASM from a clean installation.
- Make FFmpeg optional or replace the current distribution strategy.
- Add content allowlist and size budgets.

### Milestone D — Tarball verification

- Add `release:pack`.
- Install the tarball in clean temporary projects.
- Add Linux/macOS/Windows smoke jobs.
- Add persistence, sandbox, and production-SPA checks.

### Milestone E — Alpha publication

- Publish `0.1.0-alpha.1` under `next`.
- Configure Trusted Publishing.
- Remove bootstrap tokens.
- Verify provenance and fresh `npx` installation.

### Milestone F — Stable publication

- Resolve alpha feedback and dependency licensing.
- Complete WSL and supported MP4 matrices.
- Publish `0.1.0` under `latest`.
- Document upgrade, deprecation, and support policy.

## Release blockers

Do not publish the first public alpha until all of these are resolved:

- [ ] AgentJourney project license selected and committed
- [ ] Canonical Git remote configured
- [ ] `agentjourney` npm name ownership confirmed
- [ ] Private workspace imports bundled out of the artifact
- [ ] Production Web UI served without Vite
- [ ] Clean tarball install starts on Linux, macOS, and Windows
- [ ] QuickJS/WASM works from the packed installation
- [ ] FFmpeg licensing, age, optionality, and platform coverage reviewed
- [ ] Package file allowlist and secret scan pass
- [ ] Local auth and loopback-only binding pass from the package
- [ ] Archive survives reinstall and upgrade
- [ ] Alpha publishes under `next`, not `latest`

## Primary references

- npm, [Creating and publishing unscoped public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- npm, [`package.json` fields, including `files`, `bin`, `engines`, and `publishConfig`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- npm, [`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
- npm, [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
- npm, [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- npm, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- npm, [`npx`](https://docs.npmjs.com/cli/v11/commands/npx/)
- pnpm, [`pnpm publish`](https://pnpm.io/cli/publish)
- pnpm, [Workspace protocol and publishing behavior](https://pnpm.io/workspaces)
- Fastify, [`@fastify/static`](https://github.com/fastify/fastify-static)
- Node.js, [`node:sqlite`](https://nodejs.org/api/sqlite.html)
- Node.js, [Single executable applications](https://nodejs.org/api/single-executable-applications.html)
