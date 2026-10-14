# Conduit agent guidance

- Keep host integration semantically neutral. Product workflows and policy stay in consumers.
- Never guess host paths, credentials, or configuration; require explicit caller bindings.
- Capability limitations must be executable conformance evidence, not unsupported prose.
- Installation receipts must never contain asset contents or secrets.
- Install dependencies with `pnpm install`. The pnpm version is pinned in `package.json` (`packageManager`). Dependency install scripts are blocked by default; the only packages allowed to run one are listed under `allowBuilds` in `pnpm-workspace.yaml`, pinned by version. Scripts are still run with `npm run …` — that only invokes `package.json` scripts and does not depend on which tool installed `node_modules`.
- Run `npm run verify` and Veritas readiness before delivery.
- Docs are published with Corpus: `corpus.json` lists the published docs and MCP topics, and `npm run docs:check` is the gate. When you change code that a document `covers`, update that document.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `npx --no @kontourai/veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
