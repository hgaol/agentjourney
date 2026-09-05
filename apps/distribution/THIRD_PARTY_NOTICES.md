# Third-party notices

AgentJourney depends on and/or includes compiled code from open-source projects. Their licenses remain in force for their respective code.

Key runtime and Web dependencies include:

| Project | License |
|---|---|
| Ajv / ajv-formats | MIT |
| Astryx | MIT |
| Fastify and official Fastify plugins | MIT |
| fflate | MIT |
| open | MIT |
| picomatch | MIT |
| Playwright | Apache-2.0 |
| QuickJS Emscripten | MIT |
| React and React DOM | MIT |
| semver | ISC |
| StyleX | MIT |
| TanStack Query, Router, and Virtual | MIT |
| yaml | ISC |

MP4 export invokes a separately installed FFmpeg executable discovered through `AGENTJOURNEY_FFMPEG_EXECUTABLE` or the system `PATH`. AgentJourney does not distribute FFmpeg binaries. FFmpeg and codec licensing remains the responsibility of the selected external installation.

This file is a review aid. The release pipeline also generates a machine-readable CycloneDX software bill of materials from the clean installed package, which is the authoritative dependency inventory for that artifact.
