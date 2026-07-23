# Conduit

Conduit is the portable boundary between agent products and the places they run.
It describes lifecycle events, phase-specific context injection and decision
fidelity, and
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
receipts contain asset identities, kinds, and SHA-256 digests, never asset
contents, host-resolved targets, or credentials.

`deriveConformanceLimitations()` converts every non-native capability fidelity
and failed executable probe into a stable, product-neutral limitation. Reports
merge those derived entries with optional host-authored explanatory prose,
deduplicate them, and use the same sorted list for JSON and Markdown evidence.
Native capabilities and passing probes do not produce limitations.

## Shipped host profiles

Conduit includes `createClaudeCodeAdapter`, `createCodexAdapter`, and
`createOpenCodeAdapter` for local harnesses, plus `createStrandsAdapter` and
`createVoltAgentAdapter` for in-process frameworks. The optional
`@kontourai/conduit/pi` entrypoint adds Pi 0.80.6+ extension lifecycle binding.
The optional `@kontourai/conduit/kiro` entrypoint maps Kiro CLI 2.13+ custom
agent hooks without making Kiro a package dependency.
Local adapters require
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

Every lifecycle phase has separate `decision` and `contextInjection` fidelity.
This prevents a host with native pre-tool denial, for example, from appearing
to support denial at session start or after a tool result. `native` and
`approximated` can affect execution; `observational`, `static-only`, and
`unavailable` are projected without dynamic influence. The deprecated
aggregate `blocking` and `contextInjection` fields remain accepted for source
compatibility. `normalizeCapabilities()` migrates them deterministically to
all phases when an older caller omits `influence`.

Reference rows are explicitly `adapter-contract` evidence: they prove the
projection and redaction contract, not a live host. A consumer records
`host-bound` evidence with its actual host identity, version, and real bindings
before using the matrix for runtime selection.

Pi consumers register the dependency-free handlers returned by
`createPiLifecycleHandlers()` with the public `session_start`,
`before_agent_start`, `tool_call`, `tool_result`, and `agent_settled` extension
events. The host supplies its stable session identity and application
evaluator. Tool denials preserve the evaluator's reason, and model context is
appended without rewriting its content. Installation remains caller-bound
through `createPiAdapter()`.

```ts
import {
  createPiAdapter,
  createPiLifecycleHandlers,
} from "@kontourai/conduit/pi";

export default function conduitExtension(pi) {
  const handlers = createPiLifecycleHandlers({
    adapter: createPiAdapter({
      resolveTarget: asset => configuredTargets[asset.kind]?.(asset.id),
      write: (target, content) => hostConfigWriter(target, content),
    }),
    sessionId: (_phase, _event, context) => context.sessionManager.getSessionId(),
    evaluate: event => applicationPolicy.evaluate(event),
  });
  pi.on("session_start", handlers.sessionStart);
  pi.on("before_agent_start", handlers.beforeAgentStart);
  pi.on("tool_call", handlers.toolCall);
  pi.on("tool_result", handlers.toolResult);
  pi.on("agent_settled", handlers.agentSettled);
}
```

Kiro CLI consumers decode the hook event received on stdin, evaluate it through
`evaluateKiroHook()`, and write the returned streams and exit code unchanged.
The bridge maps `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`,
and `stop` to Conduit's lifecycle. The application remains responsible for
policy evaluation and for registering its executable bridge in a Kiro custom
agent configuration.

```ts
import {
  createKiroAdapter,
  evaluateKiroHook,
} from "@kontourai/conduit/kiro";

const result = await evaluateKiroHook({
  adapter: createKiroAdapter({
    resolveTarget: asset => configuredTargets[asset.kind]?.(asset.id),
    write: (target, content) => hostConfigWriter(target, content),
  }),
  evaluate: event => applicationPolicy.evaluate(event),
}, JSON.parse(await readStdin()));

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
```

Kiro CLI context files are startup resources, command assets have no native
resource kind, and blocking is enforceable by the documented hook protocol at
pre-tool and stop. The generated evidence records these limitations rather than
generalizing from Kiro IDE hooks or another host.

## Executable support evidence

`npm run conformance:generate` executes common probes and writes stable,
timestamp-free JSON in `conformance/host-conformance.json` plus the generated
matrix in `docs/host-conformance.md`. `npm run conformance:check` fails when
either artifact is stale and runs inside `npm run verify` and CI.
The published `schemas/host-conformance.schema.json` defines the versioned
machine-readable result contract. Schema version 2 records phase influence;
`parseConformanceReport()` rejects other versions with
`UnsupportedConformanceSchemaVersionError` instead of silently reinterpreting
evidence.

Reference host versions name the verified extension seam (`public-hooks`,
`public-config`, `public-plugin-api`, or `caller-bound`) rather than making an
unverified package-version claim. Consumers can generate evidence with the
exact host version they bind.
