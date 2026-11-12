# Getting started

This guide installs Conduit, binds one host adapter, installs portable assets
through it, routes a lifecycle decision through it, and produces conformance
evidence for your binding. For the ideas behind each step, read
[Concepts](concepts.md). For every export, read the [Reference](reference.md).

## Install

Conduit is published to npm as `@kontourai/conduit`. It is an ES module
package (`"type": "module"`, `import` exports only) and requires Node 22 or
newer.

```sh
npm install @kontourai/conduit
```

The package has no runtime dependencies. It does not depend on any host or
framework package, so installing it does not pull in Claude Code, Codex, Pi,
Kiro, Strands, or VoltAgent.

Three entrypoints are exported:

| Import | Contents |
| --- | --- |
| `@kontourai/conduit` | Core contracts, both adapter shapes, the Claude Code, Codex, OpenCode, Strands, and VoltAgent profiles, lifecycle binding, and conformance evidence |
| `@kontourai/conduit/pi` | The Pi profile and Pi extension lifecycle handlers |
| `@kontourai/conduit/kiro` | The Kiro CLI profile and the Kiro hook evaluator |

The package also exports the committed reference evidence
(`@kontourai/conduit/conformance/host-conformance.json`) and its JSON Schema
(`@kontourai/conduit/schemas/host-conformance.schema.json`).

## Bind a local harness

A local harness, such as Claude Code, Codex, or OpenCode, is configured through
files. Conduit never decides where those files live. You supply two bindings:

- `resolveTarget(asset)` returns where an asset goes, or `undefined` if you have
  no place for it.
- `write(target, content)` performs the write. It may be async.

```ts
import { createCodexAdapter } from "@kontourai/conduit";

const codex = createCodexAdapter({
  resolveTarget: asset => configuredTargets[asset.kind]?.(asset.id),
  write: (target, content) => hostConfigWriter(target, content),
});
```

`configuredTargets` and `hostConfigWriter` are yours. Conduit does not discover
home directories, read credentials, or edit host configuration on its own.

## Install portable assets

An asset is an `id`, a `kind` (`skill`, `agent`, `hook`, `prompt`, `command`,
or `context`), and its `content`.

```ts
const receipt = await codex.install([
  { id: "governance-hook", kind: "hook", content: hookConfig },
  { id: "review", kind: "agent", content: agentDefinition },
]);
```

The adapter writes each asset whose kind the host supports and that your
`resolveTarget` maps. The receipt lists what was installed and what was skipped:

- `installed` entries carry the asset `id`, `kind`, and a `sha256:` digest of the
  content.
- `skipped` entries carry the `id`, `kind`, and a `reason`: `unsupported` when
  the host profile marks that kind `unavailable`, or `unmapped` when
  `resolveTarget` returned nothing.

In the example above the Codex profile marks `agent` as `unavailable`, so
`review` is skipped as `unsupported`. The receipt never contains asset content
or the target your binding resolved, so it is safe to log or store.

## Project a lifecycle decision

Your application decides what should happen at each lifecycle phase. The
adapter then reduces that decision to what the host can actually do:

```ts
const outcome = await codex.project(
  { phase: "before-tool", sessionId },
  { decision: "deny", reason: "policy denied", modelContext: "Review the rule first." },
);
```

If the host cannot act on the phase, cannot block there, or cannot inject
context there, the adapter downgrades the outcome instead of claiming an effect
that will not happen. [Outcome projection](concepts.md#outcome-projection)
lists the exact rules.

## Bind an in-process framework

For an SDK or framework that runs inside your process, use the framework
adapters. You supply `applyOutcome`, which turns a projected outcome into the
framework's own hook result, and optionally `installAsset`.

```ts
import { bindAdapterLifecycle, createStrandsAdapter } from "@kontourai/conduit";

const adapter = createStrandsAdapter({
  installAsset: asset => registerWithApplication(asset),
  applyOutcome: (event, outcome) => strandsHookBridge(event, outcome),
});

const dispose = bindAdapterLifecycle({
  adapter,
  registrar: {
    register(phase, handler) {
      return applicationHooks.on(phase, frameworkEvent =>
        handler(toConduitEvent(phase, frameworkEvent)),
      );
    },
  },
  evaluate: event => applicationPolicy.evaluate(event),
});
```

`bindAdapterLifecycle` registers one handler per phase the host supports and
returns a function that removes them. [Framework lifecycle
bindings](framework-bindings.md) covers this pattern in more detail. Pi and Kiro
have their own helpers, described in the [Reference](reference.md#pi-entrypoint).

## Record evidence for your binding

The committed matrix in [Host conformance matrix](host-conformance.md) only
proves Conduit's side of each adapter. Before you rely on a host for runtime
selection, generate `host-bound` evidence with your real bindings and the real
host version:

```ts
import {
  createConformanceReport,
  renderConformanceMatrix,
  serializeConformanceReport,
} from "@kontourai/conduit";

const report = await createConformanceReport([
  {
    adapter: codex,
    evidenceScope: "host-bound",
    adapterVersion: conduitVersion,
    hostId: "codex",
    hostVersion: installedCodexVersion,
  },
]);

const json = serializeConformanceReport(report);
const markdown = renderConformanceMatrix(report);
```

The probes call `project` on your adapter for every phase. They never install
probe assets through it: for an adapter created by a Conduit factory, they run
its `resolveTarget` mapping and fidelity rules but not its `write` or
`installAsset` binding, so probing an adapter bound to a real host leaves that
host unchanged. `resolveTarget` must therefore be a pure path mapping. The
probe uses the install path the factory built, so reassigning the adapter's
`install` property has no effect on it.

Because that default path performs no I/O, a `write` or `installAsset` that
fails, or writes the wrong thing, goes undetected: the install checks still
pass. The report says so. Its entry has `installEvidence: "inert"` and the
limitation `probe.install-io=not-exercised`.

To exercise your install I/O as well, bind a second adapter to a disposable
target and pass it as `installSandbox`, either to `probeHostConformance(adapter,
{ installSandbox })` or on the `EvidenceInput`. Its report entry has
`installEvidence: "sandbox"`. The sandbox must have the same id and
capabilities as the adapter under test and must be a separate object. An
adapter that was not created by a Conduit factory, or a spread copy of one, is
refused with `UnsafeConformanceProbeError` unless you pass a sandbox.

Keeping the sandbox's I/O disposable is your responsibility. When Conduit built
both adapters, the probe makes a best-effort check that the sandbox does not
install where the adapter under test would:

- It calls each `resolveTarget` once per probe asset, installs to exactly the
  sandbox targets it checked, and refuses (`target-resolution-failed`, with the
  original error as `cause`) if either resolver throws.
- It compares targets after resolving relative paths, `.` segments, and
  duplicate separators, following symlinks in the nearest existing ancestor,
  and folding case when that ancestor's filesystem looks names up
  case-insensitively. Any overlap is refused (`sandbox-overlaps-adapter`).
- It refuses an in-process sandbox that shares the adapter's `installAsset`
  function.

The check does not catch:

- An in-process installer wrapped in a new function, such as
  `asset => installAsset(asset)`, since only function identity is compared.
- A `write` that ignores its target or writes somewhere else as well.
- A hand-written sandbox, whose targets the probe cannot see.
- Aliasing that survives normalization, such as hard links, bind mounts,
  network paths, Unicode normalization differences, or a target that is not a
  filesystem path.

Every check that fails, and every capability that is not `native`, appears in
the report's `limitations`. See [Conformance evidence](concepts.md#conformance-evidence).
