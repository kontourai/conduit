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

## Shipped host profiles

Conduit includes `createClaudeCodeAdapter`, `createCodexAdapter`, and
`createOpenCodeAdapter` for local harnesses, plus `createStrandsAdapter` and
`createVoltAgentAdapter` for in-process frameworks. Local adapters require
explicit `resolveTarget` and `write` bindings. Framework adapters require an
explicit `applyOutcome` bridge and optionally accept `installAsset`.

The factories do not discover home directories, mutate configuration, load
framework packages, or read credentials. Applications bind the public
extension seams and own framework object lifetimes and version compatibility.
This keeps one portable definition selectable across runtimes without claiming
that every runtime exposes the same controls.

```ts
const local = createCodexAdapter({
  resolveTarget: asset => configuredTargets[asset.kind]?.(asset.id),
  write: (target, content) => hostConfigWriter(target, content),
});
const embedded = createStrandsAdapter({
  installAsset: asset => registerWithApplication(asset),
  applyOutcome: (event, outcome) => strandsHookBridge(event, outcome),
});
```

Capability values distinguish `native`, `approximated`, `observational`,
`static-only`, and `unavailable`. The Codex profile does not claim synchronous
tool blocking. Strands and VoltAgent remain caller-bound because Conduit does
not depend on their runtime packages.

## Executable support evidence

`npm run conformance:generate` executes common probes and writes stable,
timestamp-free JSON in `conformance/host-conformance.json` plus the generated
matrix in `docs/host-conformance.md`. `npm run conformance:check` fails when
either artifact is stale and runs inside `npm run verify` and CI.
The published `schemas/host-conformance.schema.json` defines the versioned
machine-readable result contract.

Reference host versions name the verified extension seam (`public-hooks`,
`public-config`, `public-plugin-api`, or `caller-bound`) rather than making an
unverified package-version claim. Consumers can generate evidence with the
exact host version they bind.
