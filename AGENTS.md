# Conduit agent guidance

- Keep host integration semantically neutral. Product workflows and policy stay in consumers.
- Never guess host paths, credentials, or configuration; require explicit caller bindings.
- Capability limitations must be executable conformance evidence, not unsupported prose.
- Installation receipts must never contain asset contents or secrets.
- Run `npm run verify` and Veritas readiness before delivery.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
