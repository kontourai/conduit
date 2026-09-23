import { createHash } from "node:crypto";

export type IntegrationFidelity = "native" | "approximated" | "observational" | "static-only" | "unavailable";
export type LifecyclePhase = "session-start" | "before-model" | "before-tool" | "after-tool" | "stop";
export type AssetKind = "skill" | "agent" | "hook" | "prompt" | "command" | "context";

export interface LifecycleInfluence {
  decision: IntegrationFidelity;
  contextInjection: IntegrationFidelity;
}

export interface HostCapabilities {
  lifecycle: Readonly<Record<LifecyclePhase, IntegrationFidelity>>;
  /**
   * Phase-specific influence. When omitted, Conduit applies the documented
   * legacy migration from the aggregate fields below.
   */
  influence?: Readonly<Record<LifecyclePhase, Readonly<LifecycleInfluence>>>;
  /** @deprecated Use `influence[phase].contextInjection`. */
  contextInjection: IntegrationFidelity;
  /** @deprecated Use `influence[phase].decision`. */
  blocking: IntegrationFidelity;
  install: Readonly<Record<AssetKind, IntegrationFidelity>>;
}

export interface NormalizedHostCapabilities {
  lifecycle: Readonly<Record<LifecyclePhase, IntegrationFidelity>>;
  influence: Readonly<Record<LifecyclePhase, Readonly<LifecycleInfluence>>>;
  install: Readonly<Record<AssetKind, IntegrationFidelity>>;
}

export interface PortableAsset {
  id: string;
  kind: AssetKind;
  content: string;
  targetHint?: string;
}

export interface InstallationReceipt {
  hostId: string;
  installed: readonly { id: string; kind: AssetKind; digest: string }[];
  skipped: readonly { id: string; kind: AssetKind; reason: string }[];
}

export interface LifecycleEvent {
  phase: LifecyclePhase;
  sessionId: string;
  context?: Readonly<Record<string, unknown>>;
}

export interface LifecycleOutcome {
  decision: "allow" | "deny" | "observe";
  reason?: string;
  modelContext?: string;
}

export interface AgentHostAdapter {
  readonly id: string;
  capabilities(): HostCapabilities;
  install(assets: readonly PortableAsset[]): Promise<InstallationReceipt>;
  project(event: LifecycleEvent, outcome: LifecycleOutcome): Promise<LifecycleOutcome>;
}

export interface ManifestHarnessOptions {
  id: string;
  capabilities: HostCapabilities;
  resolveTarget(asset: PortableAsset): string | undefined;
  write(target: string, content: string): void | Promise<void>;
}

const projectCapability = (
  capabilities: HostCapabilities,
  event: LifecycleEvent,
  outcome: LifecycleOutcome,
): LifecycleOutcome => {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.lifecycle[event.phase] === "unavailable") {
    return Object.freeze({ decision: "observe", reason: "lifecycle phase unavailable" });
  }
  if (outcome.decision === "deny" && !canInfluence(normalized.influence[event.phase].decision)) {
    return Object.freeze({ ...outcome, decision: "observe", reason: outcome.reason ?? "host cannot block" });
  }
  if (outcome.modelContext && !canInfluence(normalized.influence[event.phase].contextInjection)) {
    return Object.freeze({ ...outcome, modelContext: undefined, reason: outcome.reason ?? "host cannot inject context" });
  }
  return outcome;
};

const canInfluence = (fidelity: IntegrationFidelity): boolean =>
  fidelity === "native" || fidelity === "approximated";

/** Harness adapter with host-owned path mapping and I/O. Conduit never guesses config locations. */
export function createManifestHarnessAdapter(options: ManifestHarnessOptions): AgentHostAdapter {
  return {
    id: options.id,
    capabilities: () => options.capabilities,
    async install(assets) {
      const installed: InstallationReceipt["installed"][number][] = [];
      const skipped: InstallationReceipt["skipped"][number][] = [];
      for (const asset of assets) {
        const fidelity = options.capabilities.install[asset.kind];
        const target = options.resolveTarget(asset);
        if (fidelity === "unavailable" || !target) {
          skipped.push({ id: asset.id, kind: asset.kind, reason: fidelity === "unavailable" ? "unsupported" : "unmapped" });
          continue;
        }
        await options.write(target, asset.content);
        installed.push({ id: asset.id, kind: asset.kind, digest: digest(asset.content) });
      }
      return Object.freeze({ hostId: options.id, installed: Object.freeze(installed), skipped: Object.freeze(skipped) });
    },
    async project(event, outcome) {
      return projectCapability(options.capabilities, event, outcome);
    },
  };
}

export interface InProcessHostOptions {
  id: string;
  capabilities: HostCapabilities;
  installAsset?(asset: PortableAsset): void | Promise<void>;
  applyOutcome(event: LifecycleEvent, outcome: LifecycleOutcome): LifecycleOutcome | Promise<LifecycleOutcome>;
}

/** SDK/framework adapter: the host supplies lifecycle influence and optional asset registration. */
export function createInProcessHostAdapter(options: InProcessHostOptions): AgentHostAdapter {
  return {
    id: options.id,
    capabilities: () => options.capabilities,
    async install(assets) {
      const installed: InstallationReceipt["installed"][number][] = [];
      const skipped: InstallationReceipt["skipped"][number][] = [];
      for (const asset of assets) {
        if (!options.installAsset || options.capabilities.install[asset.kind] === "unavailable") {
          skipped.push({ id: asset.id, kind: asset.kind, reason: "unsupported" });
        } else {
          await options.installAsset(asset);
          installed.push({ id: asset.id, kind: asset.kind, digest: digest(asset.content) });
        }
      }
      return Object.freeze({ hostId: options.id, installed: Object.freeze(installed), skipped: Object.freeze(skipped) });
    },
    async project(event, outcome) {
      return projectCapability(
        options.capabilities,
        event,
        await options.applyOutcome(event, outcome),
      );
    },
  };
}

export interface ConformanceResult { check: string; status: "pass" | "fail"; detail?: string }

export interface AdapterConformanceEvidence {
  /** What the executable probe actually exercised. */
  evidenceScope: "adapter-contract" | "host-bound";
  adapterId: string;
  adapterVersion: string;
  hostId: string;
  hostVersion: string;
  capabilities: NormalizedHostCapabilities;
  limitations: readonly string[];
  results: readonly ConformanceResult[];
}

export interface ConformanceReport {
  schemaVersion: "2";
  adapters: readonly AdapterConformanceEvidence[];
}

export class UnsupportedConformanceSchemaVersionError extends Error {
  readonly code = "UNSUPPORTED_CONFORMANCE_SCHEMA_VERSION";
  constructor(readonly schemaVersion: unknown) {
    super(`Unsupported Conduit conformance schema version: ${String(schemaVersion)}`);
    this.name = "UnsupportedConformanceSchemaVersionError";
  }
}

const fidelityLimit = (
  path: string,
  fidelity: IntegrationFidelity,
): string | undefined =>
  fidelity === "native" ? undefined : `capability.${path}=${fidelity}`;

/**
 * Derive stable, product-neutral limitations from declared fidelity and probe
 * results. Host profiles may add explanatory prose separately.
 */
export function deriveConformanceLimitations(
  capabilities: HostCapabilities,
  results: readonly ConformanceResult[],
): readonly string[] {
  const normalized = normalizeCapabilities(capabilities);
  const limitations = new Set<string>();
  for (const phase of [
    "session-start",
    "before-model",
    "before-tool",
    "after-tool",
    "stop",
  ] as const) {
    const limitation = fidelityLimit(
      `lifecycle.${phase}`,
      normalized.lifecycle[phase],
    );
    if (limitation) limitations.add(limitation);
    for (const key of ["decision", "contextInjection"] as const) {
      const influenceLimitation = fidelityLimit(
        `influence.${phase}.${key}`,
        normalized.influence[phase][key],
      );
      if (influenceLimitation) limitations.add(influenceLimitation);
    }
  }
  for (const kind of [
    "skill",
    "agent",
    "hook",
    "prompt",
    "command",
    "context",
  ] as const) {
    const limitation = fidelityLimit(
      `install.${kind}`,
      normalized.install[kind],
    );
    if (limitation) limitations.add(limitation);
  }
  for (const result of results) {
    if (result.status === "fail") limitations.add(`probe.${result.check}=fail`);
  }
  return Object.freeze([...limitations].sort());
}

export async function probeHostConformance(adapter: AgentHostAdapter): Promise<readonly ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const caps = normalizeCapabilities(adapter.capabilities());
  const validFidelities: readonly IntegrationFidelity[] = ["native", "approximated", "observational", "static-only", "unavailable"];
  const influenceValues = Object.values(caps.influence).flatMap(value => [value.decision, value.contextInjection]);
  const capabilityValues = [...Object.values(caps.lifecycle), ...influenceValues, ...Object.values(caps.install)];
  results.push({ check: "capability-completeness", status: Object.keys(caps.lifecycle).length === 5 && Object.keys(caps.influence).length === 5 && Object.keys(caps.install).length === 6 && capabilityValues.every(value => validFidelities.includes(value)) ? "pass" : "fail" });
  const kinds: readonly AssetKind[] = ["skill", "agent", "hook", "prompt", "command", "context"];
  const receipt = await adapter.install(kinds.map(kind => ({ id: `conformance-${kind}`, kind, content: `conduit-private-${kind}-content` })));
  const serializedReceipt = JSON.stringify(receipt);
  results.push({ check: "install-fidelity", status: kinds.every(kind => {
    const expectedInstalled = caps.install[kind] !== "unavailable";
    return receipt.installed.some(item => item.kind === kind) === expectedInstalled;
  }) ? "pass" : "fail" });
  results.push({ check: "secret-free-install-receipt", status: serializedReceipt.includes("conformance-context") && kinds.every(kind => !serializedReceipt.includes(`conduit-private-${kind}-content`)) && !serializedReceipt.includes('"content"') ? "pass" : "fail" });
  for (const phase of ["session-start", "before-model", "before-tool", "after-tool", "stop"] as const) {
    const projected = await adapter.project({ phase, sessionId: "conformance" }, { decision: "allow", reason: "phase probe" });
    const expected = caps.lifecycle[phase] === "unavailable" ? "observe" : "allow";
    results.push({ check: `lifecycle-${phase}`, status: projected.decision === expected ? "pass" : "fail" });
  }
  for (const phase of lifecyclePhases) {
    const deny = await adapter.project({ phase, sessionId: "conformance" }, { decision: "deny", reason: "policy denied" });
    const expected = caps.lifecycle[phase] === "unavailable" || !canInfluence(caps.influence[phase].decision) ? "observe" : "deny";
    results.push({ check: `decision-${phase}`, status: deny.decision === expected && Boolean(deny.reason) ? "pass" : "fail" });
    const context = await adapter.project({ phase, sessionId: "conformance" }, { decision: "allow", modelContext: "conduit-private-context" });
    const contextMatches = caps.lifecycle[phase] === "unavailable" || !canInfluence(caps.influence[phase].contextInjection)
      ? context.modelContext === undefined
      : context.modelContext === "conduit-private-context";
    results.push({ check: `context-${phase}`, status: contextMatches ? "pass" : "fail" });
  }
  return Object.freeze(results);
}

export interface EvidenceInput {
  adapter: AgentHostAdapter;
  evidenceScope: AdapterConformanceEvidence["evidenceScope"];
  adapterVersion: string;
  hostId: string;
  hostVersion: string;
  limitations?: readonly string[];
}

/** Build stable, timestamp-free evidence. Inputs and nested checks are sorted by identity. */
export async function createConformanceReport(inputs: readonly EvidenceInput[]): Promise<ConformanceReport> {
  const adapters = await Promise.all([...inputs].sort((a, b) => a.adapter.id.localeCompare(b.adapter.id)).map(async input => {
    const capabilities = normalizeCapabilities(input.adapter.capabilities());
    const results = Object.freeze(
      [...(await probeHostConformance(input.adapter))].sort((a, b) =>
        a.check.localeCompare(b.check),
      ),
    );
    const limitations = new Set([
      ...(input.limitations ?? []),
      ...deriveConformanceLimitations(input.adapter.capabilities(), results),
    ]);
    return {
      evidenceScope: input.evidenceScope,
      adapterId: input.adapter.id,
      adapterVersion: input.adapterVersion,
      hostId: input.hostId,
      hostVersion: input.hostVersion,
      capabilities,
      limitations: Object.freeze([...limitations].sort()),
      results,
    };
  }));
  return Object.freeze({ schemaVersion: "2", adapters: Object.freeze(adapters) });
}

const lifecyclePhases = ["session-start", "before-model", "before-tool", "after-tool", "stop"] as const;

/** Normalize legacy aggregate influence into explicit per-phase claims. */
export function normalizeCapabilities(capabilities: HostCapabilities): NormalizedHostCapabilities {
  const influence = Object.fromEntries(lifecyclePhases.map(phase => [
    phase,
    Object.freeze(capabilities.influence?.[phase] ?? {
      decision: capabilities.blocking,
      contextInjection: capabilities.contextInjection,
    }),
  ])) as unknown as NormalizedHostCapabilities["influence"];
  return Object.freeze({
    lifecycle: Object.freeze({
      "session-start": capabilities.lifecycle["session-start"],
      "before-model": capabilities.lifecycle["before-model"],
      "before-tool": capabilities.lifecycle["before-tool"],
      "after-tool": capabilities.lifecycle["after-tool"],
      stop: capabilities.lifecycle.stop,
    }),
    influence: Object.freeze(influence),
    install: Object.freeze({
      skill: capabilities.install.skill,
      agent: capabilities.install.agent,
      hook: capabilities.install.hook,
      prompt: capabilities.install.prompt,
      command: capabilities.install.command,
      context: capabilities.install.context,
    }),
  });
}

export function serializeConformanceReport(report: ConformanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Parse only the current evidence contract; older reports fail explicitly. */
export function parseConformanceReport(serialized: string): ConformanceReport {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== "2") {
    throw new UnsupportedConformanceSchemaVersionError(
      value && typeof value === "object" && "schemaVersion" in value
        ? value.schemaVersion
        : undefined,
    );
  }
  return value as ConformanceReport;
}

const lifecycle = (
  sessionStart: IntegrationFidelity,
  beforeModel: IntegrationFidelity,
  beforeTool: IntegrationFidelity,
  afterTool: IntegrationFidelity,
  stop: IntegrationFidelity,
): HostCapabilities["lifecycle"] => Object.freeze({
  "session-start": sessionStart,
  "before-model": beforeModel,
  "before-tool": beforeTool,
  "after-tool": afterTool,
  stop,
});

const influence = (
  values: Partial<Record<LifecyclePhase, Partial<LifecycleInfluence>>>,
  fallback: LifecycleInfluence = {
    decision: "unavailable",
    contextInjection: "unavailable",
  },
): NormalizedHostCapabilities["influence"] => Object.freeze(
  Object.fromEntries(lifecyclePhases.map(phase => [
    phase,
    Object.freeze({
      decision: values[phase]?.decision ?? fallback.decision,
      contextInjection: values[phase]?.contextInjection ?? fallback.contextInjection,
    }),
  ])) as unknown as NormalizedHostCapabilities["influence"],
);

const install = (values: Partial<Record<AssetKind, IntegrationFidelity>>): HostCapabilities["install"] => Object.freeze({
  skill: values.skill ?? "unavailable",
  agent: values.agent ?? "unavailable",
  hook: values.hook ?? "unavailable",
  prompt: values.prompt ?? "unavailable",
  command: values.command ?? "unavailable",
  context: values.context ?? "unavailable",
});

/** Public host profiles. They describe extension-surface fidelity, not configuration discovery. */
export const claudeCodeCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("native", "approximated", "native", "native", "native"),
  influence: influence({
    "session-start": { contextInjection: "native" },
    "before-model": { contextInjection: "native" },
    "before-tool": { decision: "native" },
    stop: { decision: "native" },
  }),
  contextInjection: "native",
  blocking: "native",
  install: install({ skill: "native", agent: "native", hook: "native", prompt: "native", command: "native", context: "static-only" }),
});

export const codexCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("unavailable", "unavailable", "native", "unavailable", "observational"),
  influence: influence({ "before-tool": { decision: "native", contextInjection: "native" } }),
  contextInjection: "static-only",
  blocking: "unavailable",
  // A copied project hook is not active until Codex trusts its exact definition.
  install: install({ skill: "native", hook: "approximated", prompt: "static-only", context: "static-only" }),
});

export const openCodeCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("native", "native", "native", "native", "approximated"),
  influence: influence({}, { decision: "native", contextInjection: "native" }),
  contextInjection: "native",
  blocking: "native",
  install: install({ skill: "native", agent: "native", hook: "native", prompt: "native", command: "native", context: "native" }),
});

export type LocalHarnessBinding = Omit<ManifestHarnessOptions, "id" | "capabilities">;

export const createClaudeCodeAdapter = (binding: LocalHarnessBinding): AgentHostAdapter =>
  createManifestHarnessAdapter({ id: "claude-code", capabilities: claudeCodeCapabilities, ...binding });
export const createCodexAdapter = (binding: LocalHarnessBinding): AgentHostAdapter =>
  createManifestHarnessAdapter({ id: "codex", capabilities: codexCapabilities, ...binding });
export const createOpenCodeAdapter = (binding: LocalHarnessBinding): AgentHostAdapter =>
  createManifestHarnessAdapter({ id: "opencode", capabilities: openCodeCapabilities, ...binding });

export interface FrameworkBridge {
  installAsset?(asset: PortableAsset): void | Promise<void>;
  applyOutcome(event: LifecycleEvent, outcome: LifecycleOutcome): LifecycleOutcome | Promise<LifecycleOutcome>;
}

export type LifecycleHandler = (event: LifecycleEvent) => Promise<LifecycleOutcome>;

export interface LifecycleRegistrar {
  register(phase: LifecyclePhase, handler: LifecycleHandler): void | (() => void);
}

export interface LifecycleBindingOptions {
  adapter: AgentHostAdapter;
  registrar: LifecycleRegistrar;
  evaluate(event: LifecycleEvent): LifecycleOutcome | Promise<LifecycleOutcome>;
}

/** Connect a caller-owned framework registrar to an application evaluator through an adapter. */
export function bindAdapterLifecycle(options: LifecycleBindingOptions): () => void {
  const disposers: (() => void)[] = [];
  for (const phase of ["session-start", "before-model", "before-tool", "after-tool", "stop"] as const) {
    if (options.adapter.capabilities().lifecycle[phase] === "unavailable") continue;
    const dispose = options.registrar.register(phase, async event => {
      if (event.phase !== phase) throw new Error(`Lifecycle registrar dispatched ${event.phase} to ${phase}`);
      return options.adapter.project(event, await options.evaluate(event));
    });
    if (dispose) disposers.push(dispose);
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

export const strandsCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("native", "native", "native", "native", "native"),
  influence: influence({}, { decision: "native", contextInjection: "native" }),
  contextInjection: "native",
  blocking: "native",
  install: install({ hook: "native", prompt: "native", context: "native", skill: "approximated", agent: "approximated", command: "approximated" }),
});

export const voltAgentCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("native", "native", "native", "native", "native"),
  influence: influence({}, { decision: "native", contextInjection: "native" }),
  contextInjection: "native",
  blocking: "native",
  install: install({ hook: "native", prompt: "native", context: "native", skill: "approximated", agent: "native", command: "approximated" }),
});

/** Bridge to Strands hooks. The application binds actual framework objects and versions. */
export const createStrandsAdapter = (bridge: FrameworkBridge): AgentHostAdapter =>
  createInProcessHostAdapter({ id: "strands", capabilities: strandsCapabilities, ...bridge });

/** Bridge to VoltAgent lifecycle hooks. The application binds actual framework objects and versions. */
export const createVoltAgentAdapter = (bridge: FrameworkBridge): AgentHostAdapter =>
  createInProcessHostAdapter({ id: "voltagent", capabilities: voltAgentCapabilities, ...bridge });

export function renderConformanceMatrix(report: ConformanceReport): string {
  const phases: readonly LifecyclePhase[] = ["session-start", "before-model", "before-tool", "after-tool", "stop"];
  const rows = report.adapters.map(({ evidenceScope, adapterId, adapterVersion, hostId, hostVersion, capabilities, limitations, results }) => {
    const status = results.every(result => result.status === "pass") ? "pass" : "fail";
    const cells = phases.map(phase => {
      const value = capabilities.influence[phase];
      return `${capabilities.lifecycle[phase]} / ${value.decision} / ${value.contextInjection}`;
    });
    return `| ${adapterId} | ${adapterVersion} | ${evidenceScope} | ${hostId} | ${hostVersion} | ${cells.join(" | ")} | ${status} | ${limitations.join("; ") || "none"} |`;
  });
  return [
    "# Host conformance matrix",
    "",
    "Generated from `conformance/host-conformance.json`. Do not edit by hand. `adapter-contract` rows prove Conduit's projection contract only; runtime selection requires `host-bound` evidence generated by the consuming host.",
    "",
    "Each lifecycle cell is `event / decision / context` fidelity.",
    "",
    "| Adapter | Adapter version | Evidence scope | Host | Host version | Session start | Before model | Before tool | After tool | Stop | Probe | Limitations |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
