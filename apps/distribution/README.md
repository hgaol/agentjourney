# AgentJourney

AgentJourney is a local-first platform for preserving, finding, reviewing, replaying, and exporting histories produced by coding agents.

## Prerequisites

- Node.js 22.19 or newer
- macOS, Linux, native Windows, or WSL

## Try the prerelease

```bash
npx --yes agentjourney@next
```

For regular use after a stable release:

```bash
npm install --global agentjourney
agentjourney
```

## Options

```text
agentjourney [start]
  --port <number>
  --data-dir <path>
  --no-open
  --version
  --help
```

The host binds only to `127.0.0.1`. The archive defaults to `~/.agentjourney` and remains there when the npm package is updated or removed.

## Privacy

AgentJourney has no accounts, cloud storage, or telemetry and never launches or controls coding agents. It passively reads histories only from user-approved Source Roots. The local archive is intentionally unencrypted and may contain credentials or private source code.

MP4 export uses a compatible local browser and separately installed FFmpeg. AgentJourney discovers `AGENTJOURNEY_FFMPEG_EXECUTABLE` or `ffmpeg` on `PATH` and does not distribute media binaries. Missing video dependencies do not prevent archive and review features from starting.

Install FFmpeg with the package manager appropriate to the host, for example `brew install ffmpeg`, `sudo apt install ffmpeg`, or `winget install Gyan.FFmpeg`.
