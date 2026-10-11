# Concepts

Conduit is the boundary between an agent product and the host it runs in. It
describes what a host can do, carries portable assets and lifecycle decisions
across that boundary, and records executable evidence of the result. This page
explains each building block and how they fit together. The
[Reference](reference.md) lists every export.

## What Conduit owns

Conduit owns three things:

- **Capability declarations.** Each host profile states, per lifecycle phase
  and per asset kind, how faithfully the host supports it.
- **Projection.** Adapters reduce an application's lifecycle decision and asset
  installation to what the host can actually do.
- **Conformance evidence.** Probes exercise an adapter and produce a stable,
  versioned report of what passed and what is limited.

Conduit does not define workflows, prompts, gates, evidence policy, model
routing, or application behavior. Those belong to the consuming product. In the
Kontour family, Flow Agents owns workflow and policy semantics, Station owns
orchestration, approvals, memory, and UI, Relay owns model invocation, and
Dispatch owns model routing. Conduit owns none of those.

Conduit also does not discover anything. It does not find home directories,
read or edit host configuration, load framework packages, or read credentials.
The caller supplies every binding.

## Hosts and adapters

A host is anywhere an agent runs: a CLI harness, an IDE agent, an SDK, or an
in-process framework. An adapter (`AgentHostAdapter`) is Conduit's view of one
host. Every adapter has:

- `id`, the host profile name, such as `codex`.
- `capabilities()`, the host's declared [capability
  fidelity](#capability-fidelity).
- `install(assets)`, which installs [portable
  assets](#portable-assets-and-installation-receipts) and returns a receipt.
- `project(event, outcome)`, which applies [outcome
  projection](#outcome-projection) to a lifecycle decision.

There are two adapter shapes:

- **Manifest harness adapters** (`createManifestHarnessAdapter`) are for hosts
  configured through files, such as Claude Code, Codex, OpenCode, Pi, and Kiro.
  The caller supplies `resolveTarget` and `write`.
- **In-process host adapters** (`createInProcessHostAdapter`) are for SDKs and
  frameworks with programmatic hooks, such as Strands and VoltAgent. The caller
  supplies `applyOutcome` and, optionally, `installAsset`.

A named adapter such as `createCodexAdapter` is a capability profile plus the
caller's bindings. It is not evidence that Conduit loaded, configured, or
authenticated the host.

## Capability fidelity

Every capability is one of five fidelity values:

| Fidelity | Can influence execution |
| --- | --- |
| `native` | Yes |
| `approximated` | Yes |
| `observational` | No |
| `static-only` | No |
| `unavailable` | No |

`native` and `approximated` can affect what the host does. `observational`,
`static-only`, and `unavailable` are projected without dynamic influence.
Shipped profiles use `approximated` where the host supports a capability
through a neighboring surface: Claude Code's `before-model` phase is projected
through prompt submission hooks, and OpenCode's `stop` is derived from session
lifecycle events. Context assets on several hosts are `static-only` because
they are static instructions.

`HostCapabilities` declares fidelity in three places:

- `lifecycle`: one value per [lifecycle phase](#lifecycle-phases-and-influence),
  saying whether the host raises that event at all.
- `influence`: per phase, a `decision` fidelity (can the host block?) and a
  `contextInjection` fidelity (can the host add model context?).
- `install`: one value per asset kind.

## Lifecycle phases and influence

Conduit uses five lifecycle phases: `session-start`, `before-model`,
`before-tool`, `after-tool`, and `stop`.

Decision and context injection are declared separately for each phase. This
prevents a host that can deny a tool call before it runs from appearing able to
deny at session start or after a tool result.

Older callers declared influence with two aggregate fields, `blocking` and
`contextInjection`. Both are deprecated but still accepted.
`normalizeCapabilities()` resolves each phase deterministically: it uses
`influence[phase]` when present, and otherwise uses `blocking` as the phase's
`decision` and `contextInjection` as the phase's `contextInjection`.

## Outcome projection

An application evaluates a `LifecycleEvent` (a `phase`, a `sessionId`, and
optional `context`) and returns a `LifecycleOutcome`: a `decision` of `allow`,
`deny`, or `observe`, an optional `reason`, and optional `modelContext`.

`project(event, outcome)` checks the normalized capabilities for the event's
phase. The first rule that applies decides the result:

1. If the phase's `lifecycle` fidelity is `unavailable`, the result is
   `{ decision: "observe", reason: "lifecycle phase unavailable" }`. The
   original reason and context are dropped.
2. If the outcome is `deny` and the phase's `decision` fidelity cannot
   influence execution, the decision becomes `observe`. The reason is kept, or
   set to `host cannot block`. Because this rule returns, any `modelContext` on
   the outcome is passed through unchanged.
3. If the outcome has `modelContext` and the phase's `contextInjection`
   fidelity cannot influence execution, `modelContext` is removed. The reason is
   kept, or set to `host cannot inject context`.
4. Otherwise the outcome is returned unchanged.

In-process adapters first pass the outcome through the caller's
`applyOutcome`, then apply the same rules to what it returns.

## Portable assets and installation receipts

A `PortableAsset` has an `id`, a `kind`, its `content`, and an optional
`targetHint` that your `resolveTarget` can read. The six kinds are `skill`,
`agent`, `hook`, `prompt`, `command`, and `context`.

`install(assets)` returns an `InstallationReceipt` with the adapter's `hostId`
and two lists:

- `installed`: the `id`, `kind`, and `digest` (`sha256:` followed by the hex
  SHA-256 of the content) of each installed asset.
- `skipped`: the `id`, `kind`, and `reason` of each skipped asset.

A manifest harness adapter skips an asset as `unsupported` when its kind's
install fidelity is `unavailable`, and as `unmapped` when `resolveTarget`
returns no target. An in-process adapter skips an asset as `unsupported` when
its kind is `unavailable` or no `installAsset` binding was supplied. Any other
fidelity, including `static-only`, installs the asset.

Receipts never contain asset content, the target the caller resolved, or
credentials.

## Caller bindings

Every host-specific action goes through a function the caller supplies:

| Binding | Used by | Purpose |
| --- | --- | --- |
| `resolveTarget(asset)` | Manifest harness adapters | Choose where an asset goes, or return `undefined` |
| `write(target, content)` | Manifest harness adapters | Perform the write |
| `installAsset(asset)` | In-process adapters (optional) | Register an asset with the framework |
| `applyOutcome(event, outcome)` | In-process adapters | Translate an outcome into the framework's hook result |
| `LifecycleRegistrar.register(phase, handler)` | `bindAdapterLifecycle` | Attach a Conduit handler to the framework's own hook |
| `evaluate(event)` | Lifecycle binding helpers | The application's policy decision |

`evaluate` stays in the application, so workflow, approval, evidence, and model
routing policy never enter Conduit.

## Conformance evidence

`probeHostConformance(adapter)` runs executable checks against an adapter:

- `capability-completeness`: all five phases, both influence values per phase,
  and all six asset kinds are declared with valid fidelity values.
- `install-fidelity`: installing one probe asset of each kind installs exactly
  the kinds whose fidelity is not `unavailable`.
- `secret-free-install-receipt`: the receipt names the probe assets but contains
  none of their content.
- `lifecycle-<phase>`, `decision-<phase>`, and `context-<phase>` for each phase:
  `project` downgrades allow, deny, and context outcomes exactly as the declared
  capabilities say it should.

`createConformanceReport(inputs)` probes each adapter and builds a
`ConformanceReport`. Each adapter entry records its evidence scope, adapter and
host identity and version, normalized capabilities, sorted probe results, and
sorted `limitations`. Adapters are sorted by id and nothing in the report is
timestamped, so the same inputs always serialize to the same bytes.

`limitations` merges two sources and removes duplicates:

- Derived limitations from `deriveConformanceLimitations()`: one
  `capability.<path>=<fidelity>` entry for every capability that is not
  `native`, such as `capability.influence.stop.decision=unavailable`, and one
  `probe.<check>=fail` entry for every failed probe.
- Optional explanatory prose that the caller passes in.

Native capabilities and passing probes produce no limitation.

The report has `schemaVersion: "2"`, which records per-phase influence.
`parseConformanceReport()` accepts only that version and throws
`UnsupportedConformanceSchemaVersionError` for any other, rather than
reinterpreting older evidence.

## Evidence scope

Each report entry has an `evidenceScope`:

- `adapter-contract` evidence proves Conduit's projection and redaction
  contract with stand-in bindings. It does not exercise a live host. The
  committed [host conformance matrix](host-conformance.md) is entirely
  `adapter-contract` evidence, with host id and version recorded as `unbound`.
- `host-bound` evidence is generated by a consumer with its actual host
  identity, host version, and real bindings.

Use `host-bound` evidence, not the committed matrix, to choose a host at
runtime.
