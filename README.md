# Conduit

Conduit is the portable boundary between agent products and the places they run.
It describes lifecycle influence, context injection, blocking fidelity, and
installation of skills, agents, hooks, prompts, commands, and context assets.

Conduit does not define workflows, prompts, gates, evidence policy, model
routing, or application behavior. Products own those semantics; host adapters
only project them and report limitations through conformance evidence.

Two adapter shapes ship initially:

- `createManifestHarnessAdapter` for filesystem/config-driven harnesses. The
  caller owns every target mapping and write operation.
- `createInProcessHostAdapter` for SDKs and frameworks with programmatic
  lifecycle and asset-registration surfaces.

`probeHostConformance()` produces executable capability evidence. Installation
receipts contain asset identities, kinds, targets, and SHA-256 digests, never
asset contents or credentials.
