# Reference

This page lists Conduit's public surface: the package entrypoints, types,
adapter factories, host profiles, lifecycle helpers, conformance API, and the
repository's npm scripts. [Concepts](concepts.md) explains how the pieces fit
together.

## Entrypoints

| Import | Exports |
| --- | --- |
| `@kontourai/conduit` | Core types, `createManifestHarnessAdapter`, `createInProcessHostAdapter`, the Claude Code, Codex, OpenCode, Strands, and VoltAgent profiles and factories, `bindAdapterLifecycle`, and the conformance API |
| `@kontourai/conduit/pi` | `piCapabilities`, `createPiAdapter`, `createPiLifecycleHandlers`, and Pi binding types |
| `@kontourai/conduit/kiro` | `kiroCapabilities`, `createKiroAdapter`, `evaluateKiroHook`, `UnsupportedKiroHookEventError`, and Kiro hook types |
| `@kontourai/conduit/conformance/host-conformance.json` | The committed reference conformance report |
| `@kontourai/conduit/schemas/host-conformance.schema.json` | JSON Schema for conformance reports |

All code entrypoints are ES modules with TypeScript declarations. The package
requires Node 22 or newer.

## Core types

| Type | Shape |
| --- | --- |
| `IntegrationFidelity` | `"native" \| "approximated" \| "observational" \| "static-only" \| "unavailable"` |
| `LifecyclePhase` | `"session-start" \| "before-model" \| "before-tool" \| "after-tool" \| "stop"` |
| `AssetKind` | `"skill" \| "agent" \| "hook" \| "prompt" \| "command" \| "context"` |
| `LifecycleInfluence` | `{ decision, contextInjection }`, both `IntegrationFidelity` |
| `HostCapabilities` | `lifecycle` (per phase), optional `influence` (per phase), `contextInjection` and `blocking` (deprecated but required), and `install` (per asset kind) |
| `NormalizedHostCapabilities` | `lifecycle`, `influence`, and `install`, all explicit |
| `PortableAsset` | `{ id, kind, content, targetHint? }` |
| `InstallationReceipt` | `{ hostId, installed: { id, kind, digest }[], skipped: { id, kind, reason }[] }` |
| `LifecycleEvent` | `{ phase, sessionId, context? }` |
| `LifecycleOutcome` | `{ decision: "allow" \| "deny" \| "observe", reason?, modelContext? }` |
| `AgentHostAdapter` | `{ id, capabilities(), install(assets), project(event, outcome) }` |

`install` and `project` return promises. An installation receipt and its
`installed` and `skipped` arrays are frozen, but the freeze is shallow: the
entries inside the arrays are not frozen.

## Adapter factories

### createManifestHarnessAdapter

```ts
createManifestHarnessAdapter(options: ManifestHarnessOptions): AgentHostAdapter
```

`ManifestHarnessOptions` is `{ id, capabilities, resolveTarget(asset), write(target, content) }`.
`resolveTarget` returns a target string or `undefined`. `write` may return a
promise, which `install` awaits.

`install` calls `resolveTarget` for each asset, in order. It skips the asset
with reason `unsupported` if the kind's install fidelity is `unavailable`, or
`unmapped` if no target was returned. Otherwise it calls `write` and records the
asset's digest.

### createInProcessHostAdapter

```ts
createInProcessHostAdapter(options: InProcessHostOptions): AgentHostAdapter
```

`InProcessHostOptions` is `{ id, capabilities, installAsset?(asset), applyOutcome(event, outcome) }`.

`install` skips an asset with reason `unsupported` if `installAsset` is missing
or the kind's install fidelity is `unavailable`, and otherwise calls
`installAsset`. `project` awaits `applyOutcome` and then applies [outcome
projection](concepts.md#outcome-projection) to its result.

### Named factories

Each named factory fixes the adapter `id` and capability profile and takes only
the caller's bindings.

| Factory | Entrypoint | `id` | Binding type |
| --- | --- | --- | --- |
| `createClaudeCodeAdapter` | `@kontourai/conduit` | `claude-code` | `LocalHarnessBinding` |
| `createCodexAdapter` | `@kontourai/conduit` | `codex` | `LocalHarnessBinding` |
| `createOpenCodeAdapter` | `@kontourai/conduit` | `opencode` | `LocalHarnessBinding` |
| `createPiAdapter` | `@kontourai/conduit/pi` | `pi` | `LocalHarnessBinding` |
| `createKiroAdapter` | `@kontourai/conduit/kiro` | `kiro` | `LocalHarnessBinding` |
| `createStrandsAdapter` | `@kontourai/conduit` | `strands` | `FrameworkBridge` |
| `createVoltAgentAdapter` | `@kontourai/conduit` | `voltagent` | `FrameworkBridge` |

`LocalHarnessBinding` is `{ resolveTarget, write }`. `FrameworkBridge` is
`{ installAsset?, applyOutcome }`.

## Host profiles

Each profile is exported as a frozen `HostCapabilities` constant:
`claudeCodeCapabilities`, `codexCapabilities`, `openCodeCapabilities`,
`strandsCapabilities`, and `voltAgentCapabilities` from the main entrypoint,
`piCapabilities` from `/pi`, and `kiroCapabilities` from `/kiro`.

Lifecycle, decision, and context fidelity for every phase is listed in the
[host conformance matrix](host-conformance.md). Install fidelity per asset kind:

| Profile | skill | agent | hook | prompt | command | context |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | native | native | native | native | native | static-only |
| codex | native | unavailable | approximated | static-only | unavailable | static-only |
| opencode | native | native | native | native | native | native |
| pi | native | unavailable | native | native | approximated | static-only |
| kiro | native | native | native | native | unavailable | static-only |
| strands | approximated | approximated | native | native | approximated | native |
| voltagent | approximated | native | native | native | approximated | native |

Notes recorded in the source and the committed evidence:

- **Codex** exposes no lifecycle surface except `before-tool`, which can block
  and inject context, and an `observational` `stop`. Its `hook` install is
  `approximated` because a copied project hook is not active until Codex trusts
  its exact definition.
- **Pi** targets Pi 0.80.6 and later extensions. It can block at `before-tool`
  and inject context at `before-model`.
- **Kiro** targets Kiro CLI 2.13 and later custom-agent hooks, not standalone
  IDE hook files. It can block at `before-tool` and `stop`, and inject context
  at `session-start` and `before-model`.
- **Strands** and **VoltAgent** are caller-bound. Conduit does not depend on
  either framework package.

## Lifecycle binding

### bindAdapterLifecycle

```ts
bindAdapterLifecycle(options: LifecycleBindingOptions): () => void
```

`LifecycleBindingOptions` is `{ adapter, registrar, evaluate(event) }`, where
`registrar` is a `LifecycleRegistrar`:

```ts
interface LifecycleRegistrar {
  register(phase: LifecyclePhase, handler: LifecycleHandler): void | (() => void);
}
type LifecycleHandler = (event: LifecycleEvent) => Promise<LifecycleOutcome>;
```

For each phase whose `lifecycle` fidelity is not `unavailable`, it calls
`registrar.register` once with a handler that runs `evaluate` and then
`adapter.project`. The handler throws if it receives an event for a different
phase. The returned function calls every disposer that `register` returned, in
reverse registration order. It reverses its disposer list in place, so calling
it a second time runs every disposer again, in registration order.

## Pi entrypoint

### createPiLifecycleHandlers

```ts
createPiLifecycleHandlers(options: PiExtensionBindingOptions): PiLifecycleHandlers
```

`PiExtensionBindingOptions` is `{ adapter, sessionId(phase, event, context), evaluate(event) }`.
`sessionId` returns the host's session identity. Each handler builds a
`LifecycleEvent` with `context: { hostEvent: event }`, runs `evaluate`, and
projects the result through the adapter.

| Handler | Register on Pi event | Phase | Returns |
| --- | --- | --- | --- |
| `sessionStart` | `session_start` | `session-start` | nothing |
| `beforeAgentStart` | `before_agent_start` | `before-model` | `{ systemPrompt }` with the projected `modelContext` appended after a blank line, or `undefined` when there is none |
| `toolCall` | `tool_call` | `before-tool` | `{ block: true, reason }` when the projected decision is `deny`, otherwise `undefined` |
| `toolResult` | `tool_result` | `after-tool` | nothing |
| `agentSettled` | `agent_settled` | `stop` | nothing |

Installation goes through `createPiAdapter`, which needs explicit
`resolveTarget` and `write` bindings.

## Kiro entrypoint

### evaluateKiroHook

```ts
evaluateKiroHook(options: KiroHookBindingOptions, event: KiroHookEvent): Promise<KiroHookResult>
```

`KiroHookBindingOptions` is `{ adapter, evaluate(event) }`. `KiroHookEvent` is
the decoded hook JSON: `hook_event_name`, `cwd`, `session_id`, and the optional
`prompt`, `tool_name`, `tool_input`, `tool_response`, and
`assistant_response`. The caller reads and parses stdin, then writes the result's
`stdout` and `stderr` unchanged and exits with `exitCode`.

Hook events map to phases as follows. `session_id` becomes the event's
`sessionId`, and the hook event is passed as `context.hostEvent`.

| Kiro hook | Phase |
| --- | --- |
| `agentSpawn` | `session-start` |
| `userPromptSubmit` | `before-model` |
| `preToolUse` | `before-tool` |
| `postToolUse` | `after-tool` |
| `stop` | `stop` |

Any other `hook_event_name` is refused: `evaluateKiroHook` rejects with
`UnsupportedKiroHookEventError` (`code: "UNSUPPORTED_KIRO_HOOK_EVENT"`, with
the received name in `hookEventName`) before `evaluate` runs. Conduit does not
guess a phase for an event it cannot classify. The caller decides how its hook
process reports the error; exiting with a status other than `0` or `2` makes
Kiro treat it as a hook failure rather than a block.

The projected outcome becomes a `KiroHookResult`:

| Hook and projected outcome | Result |
| --- | --- |
| `preToolUse` denied | `exitCode: 2`, `stderr` set to the reason, or `Tool use denied` |
| `stop` denied | `exitCode: 0`, `stdout` set to `{"decision":"block","reason":...}`, with reason defaulting to `Completion denied` |
| `agentSpawn` or `userPromptSubmit` with `modelContext` | `exitCode: 0`, `stdout` set to the context |
| Anything else | `exitCode: 0` |

Installation goes through `createKiroAdapter`, which needs explicit
`resolveTarget` and `write` bindings. Registering the executable bridge in a
Kiro custom-agent configuration is the application's job.

## Conformance API

| Export | Purpose |
| --- | --- |
| `probeHostConformance(adapter)` | Run the executable probes, including the per-phase `lifecycle-`, `decision-`, `context-`, and `decision-context-` checks listed in [Concepts](concepts.md#conformance-evidence), and return `ConformanceResult[]` (`{ check, status: "pass" \| "fail", detail? }`) |
| `createConformanceReport(inputs)` | Probe each `EvidenceInput` and return a `ConformanceReport` sorted by adapter id |
| `deriveConformanceLimitations(capabilities, results)` | Return the sorted `capability.*` and `probe.*` limitations |
| `normalizeCapabilities(capabilities)` | Resolve legacy aggregate fields into explicit per-phase influence |
| `serializeConformanceReport(report)` | JSON with two-space indentation and a trailing newline |
| `parseConformanceReport(serialized)` | Parse a report; throws `UnsupportedConformanceSchemaVersionError` unless `schemaVersion` is `"2"` |
| `renderConformanceMatrix(report)` | Render the Markdown matrix used in [host-conformance.md](host-conformance.md) |

`EvidenceInput` is `{ adapter, evidenceScope, adapterVersion, hostId, hostVersion, limitations? }`.
`evidenceScope` is `"adapter-contract"` or `"host-bound"`.

`ConformanceReport` is `{ schemaVersion: "2", adapters: AdapterConformanceEvidence[] }`.
Each `AdapterConformanceEvidence` has `evidenceScope`, `adapterId`,
`adapterVersion`, `hostId`, `hostVersion`, normalized `capabilities`,
`limitations`, and `results`.

`UnsupportedConformanceSchemaVersionError` has `code`
`UNSUPPORTED_CONFORMANCE_SCHEMA_VERSION` and a `schemaVersion` property holding
the version it found. `parseConformanceReport` checks only the schema version;
it does not validate the rest of the report against the JSON Schema.

## Repository scripts

These npm scripts run in a checkout of this repository.

| Script | What it does |
| --- | --- |
| `npm run build` | Remove `dist/` and compile with `tsc` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Build, then run the compiled tests. It fails if fewer than 3 test files are found. |
| `npm run conformance:generate` | Build, then rewrite `conformance/host-conformance.json` and `docs/host-conformance.md` from the shipped profiles |
| `npm run conformance:check` | Build, then fail if either generated artifact is stale |
| `npm run verify` | Typecheck, test, conformance check, and `npm pack --dry-run` |
| `npm run docs:check` | Run the docs-kit gate on the published docs |
| `npm run docs:build` | Build the documentation site |
| `npm run veritas:readiness` | Run `veritas readiness --working-tree` |
