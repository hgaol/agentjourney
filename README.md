# AgentJourney

[Website](https://hgaol.github.io/agentjourney/) · [Interactive demo](https://hgaol.github.io/agentjourney/demo/) · [GitHub](https://github.com/hgaol/agentjourney)

AgentJourney is a local-only platform for preserving, reviewing, and replaying histories from Claude Code, OpenAI Codex CLI, Pi, and the standalone GitHub Copilot CLI.

It passively scans approved history locations or imports selected native files. AgentJourney never launches, wraps, intercepts, or controls a coding agent. Source files remain read-only; exact Source Bundles are copied into an **unencrypted** independent archive.

## Development

Requirements: Node.js 22.19+ and pnpm 10+. Local MP4 export uses Playwright Chromium, installed Google Chrome or Microsoft Edge, or optional Safari-compatible Playwright WebKit. FFmpeg is resolved from `AGENTJOURNEY_FFMPEG_EXECUTABLE` or the system `PATH`; AgentJourney does not distribute FFmpeg binaries, and missing FFmpeg does not prevent archive and review startup.

```bash
pnpm install
pnpm dev
```

Open <http://127.0.0.1:4317/>. The local host redirects to the Vite UI with a local bootstrap token. Opening Vite's `http://127.0.0.1:5173/` URL directly also routes through the host automatically.

For a non-default host port, set both `AGENTJOURNEY_PORT` and the matching browser-visible `VITE_AGENTJOURNEY_HOST_ORIGIN`.

Validation:

```bash
pnpm typecheck
pnpm test
pnpm e2e
pnpm build
pnpm check:local-adapters  # reads recent local histories; uploads nothing
```

By default data is stored under `~/.agentjourney`. Override it with `AGENTJOURNEY_DATA_DIR=/path`.

## Distribution artifact

The repository can build and exercise the single-package npm alpha locally:

```bash
pnpm release:verify
```

This creates an ignored tarball and CycloneDX SBOM under `release/`, installs the tarball without optional dependencies, invokes its `npx` binary, serves the embedded production SPA, exercises QuickJS Renderer and Source Adapter plugins, and verifies persistence across restart, uninstall, and reinstall. Public npm publication remains blocked until the npm package name is claimed/confirmed and the publishing package's fail-closed `private` guard is removed.

See [Distribution and publishing](docs/distribution-and-publishing.md).

## Capture

### Scan an agent history root

1. Open **Sources**.
2. Approve a detected Source Root.
3. Preview each candidate's session date, source size, and estimated turns, plus aggregate files and date range.
4. Select the exact Capture Scope.
5. Capture it manually, or explicitly change that source to automatic scanning.

Manual is the default Scan Policy. Automatic roots are reconciled in batched Capture Cycles.

### Import native files

The Sources page accepts individual native files or a directory. Files are transported locally as a ZIP, preserved byte-for-byte, and interpreted by the selected Source Adapter.

### Import an AgentJourney archive

Settings imports checksummed, data-only `.agentjourney` Journey Packages. Imported Interpretations retain external provenance and can be reinterpreted with a compatible local adapter.

## Review and Replay

Each Journey opens in a **Terminal Replay Debugger**: terminal-native transcript center, Thread/Turn rail left, Activity inspector right, and timestamp-driven replay dock below. Replay reconstructs prompts, reasoning chunks, tools, results, state changes, and subagent lanes from persisted evidence; it does not send prompts to or control the source agent.

- Search Canonical Activity by phrase or prefix and filter by Source Agent, Activity kind, Tool Capability, Project, and date.
- Inspect exact Source Evidence or search within a selected Source Bundle.
- Presentation Redaction masks high-confidence credentials without modifying evidence.
- Browse immutable Journey Revisions and separately versioned Interpretations.
- Choose event steps, evidenced Recorded Streaming, or clearly labeled Simulated TUI Streaming during Replay; configure content streaming independently from Timeline Speed between 0.5× and 16×, while untimed control records use explicit Source-Order Placement; simulate final Human Input typing by default (or select instant prompts) in the native composer before visual submission with an independent 0.5×–4× Typing Speed; oversized pasted material is inserted in one clearly labeled simulated-paste step, and nothing is sent to an agent.
- Compare revisions or interpretations by stable Evidence Anchor.
- Add display titles, tags, Projects, bookmarks, and reviewer notes through a separate Review Overlay.
- Review the complete Journey immediately, or enter Replay to restart at frame zero and automatically progress through evidenced timing, Delivery Traces, Agent Threads, and compressed idle gaps with a live speed-aware remaining-time estimate.
- Inspect factual Coverage Reports and capability-based Fidelity Manifests.

## Renderers

Every Journey defaults to the renderer associated with its Source Agent. The same Canonical Activity can be switched among neutral, Claude Code, Codex, Pi, Copilot, or locally installed renderers. Source-native styles reproduce terminal hierarchy, prompts, markers, density, and reasoning treatment rather than merely recoloring generic cards. The Claude Code, Codex, GitHub Copilot CLI, and Pi packs use screenshot- and live-ANSI-calibrated palettes with source-shaped prompts, tools, editors, and footer chrome.

Built-in renderers are Style Pack plugins rather than hardcoded page variants. Third-party JavaScript renderers execute in capability-free QuickJS and return a validated declarative tree; trusted code renders that tree inside an opaque-origin iframe with scoped plugin CSS. Plugins receive only the selected Stage Document—not Source Evidence or archive access.

See [Plugin authoring](docs/plugins.md).

## Archive and export

- SQLite stores metadata, graphs, overlays, settings, and FTS5 indexes.
- Compressed content-addressed objects preserve exact source bytes and deduplicate revisions.
- Verification checks object hashes, Interpretations, permissions, and search-index consistency.
- Explicit Retention Policies can remove old revisions; no pruning occurs by default.
- Deleting a Journey can retain a content-free Capture Exclusion to prevent surprise re-import.
- `.agentjourney` packages are lossless, unencrypted, checksummed, data-only, and re-importable.
- HTML Presentation Exports are escaped, redacted by default, self-contained, and contain no third-party executable code.
- Replay Video Exports are locally rendered, silent H.264 MP4 files with selectable Style Pack, rendering engine, 720p/1080p/1440p quality, 0.5×–16× speed, 30/60 fps, streaming mode, and redaction, with live phase, percentage, and rendered-frame progress.

See [Archive and package format](docs/archive-format.md).

## Project structure

```text
apps/host                    local host module and loopback interface
apps/distribution            single-package CLI, production Web assets, and npm metadata
apps/web                     React Platform Shell and Journey Stage host
packages/activity-graph      partial ordering, Turns, Replay frames, comparisons
packages/archive             deep archive, search, lifecycle, and package module
packages/contracts           JSON Schema and generated TypeScript contracts
packages/plugin-sdk          adapter/renderer interfaces and conformance tools
packages/plugin-runtime      package registry, QuickJS adapter sandbox
packages/builtin-adapters    Claude, Codex, Pi, and Copilot adapters
packages/builtin-renderers   neutral and source-native Style Packs
packages/portability         shared interactive Stage and sanitized presentation rendering
packages/test-fixtures       sanitized native-history fixtures
```

## Documentation

- [Product spec](docs/product-spec.md)
- [Usage guide](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Completed implementation plan](docs/implementation-plan.md)
- [Plugin authoring](docs/plugins.md)
- [Archive and package format](docs/archive-format.md)
- [Distribution and publishing](docs/distribution-and-publishing.md)
- [Domain language](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Landscape research](docs/research/coding-agent-session-viewers.md)
