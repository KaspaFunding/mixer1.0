# Mining Pool Integration

Drop your existing Bun/TypeScript mining pool here.

Recommended structure:

- src/ — your TS sources (entrypoint recommended: index.ts)
- config/ — runtime configs (e.g. config.json, .env.example)
- templates/ — any template files the pool uses
- bunfig.toml — if your project requires Bun-specific config

Notes:
- Keep your current working code; we will add a Node/Electron integration layer afterwards.
- If your entrypoint is not src/index.ts, note the correct path here.
- If the pool listens on specific ports, add them to this README so we can expose them in the GUI.

After you drop the files:
- Tell me the entrypoint and any required env/config.
- I’ll wire build/run (ts → js) and add a Mining Pool GUI tab with start/stop/status.
