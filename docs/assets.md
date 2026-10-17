# Assets (logo and registry icons)

This repository does not ship a logo file in-tree by default. If you publish or list the MCP server in a registry that expects branding:

- Add a square PNG or SVG under `assets/` (for example `assets/perpbrain-logo.png`).
- Prefer a simple mark on a transparent or solid background; keep the file small for README and registry UIs.
- Reference the path from registry metadata when the schema supports an `icon` or `logo` field (see [server.json](../server.json) and the MCP Registry schema you target).
- Do not embed exchange keys, wallet addresses, or promotional claims in artwork copy.

Simulation-only positioning applies to all public assets: no live-trading promises, and no wording that implies guaranteed outcomes. Align footers with: limits you set; losses are still possible.
