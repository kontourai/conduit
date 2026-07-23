import { createHash } from "node:crypto";

export type IntegrationFidelity = "native" | "approximated" | "observational" | "static-only" | "unavailable";
export type LifecyclePhase = "session-start" | "before-model" | "before-tool" | "after-tool" | "stop";
export type AssetKind = "skill" | "agent" | "hook" | "prompt" | "command" | "context";

export interface HostCapabilities {
  lifecycle: Readonly<Record<LifecyclePhase, IntegrationFidelity>>;
  contextInjection: IntegrationFidelity;
  blocking: IntegrationFidelity;
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
      const fidelity = options.capabilities.lifecycle[event.phase];
      if (fidelity === "unavailable") {
        return Object.freeze({ decision: "observe", reason: "lifecycle phase unavailable" });
      }
      if (outcome.decision === "deny" && options.capabilities.blocking === "unavailable") {
        return Object.freeze({ ...outcome, decision: "observe", reason: outcome.reason ?? "host cannot block" });
      }
      if (outcome.modelContext && options.capabilities.contextInjection === "unavailable") {
        return Object.freeze({ ...outcome, modelContext: undefined, reason: outcome.reason ?? "host cannot inject context" });
      }
      return outcome;
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
    async project(event, outcome) { return await options.applyOutcome(event, outcome); },
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
  capabilities: HostCapabilities;
  limitations: readonly string[];
  results: readonly ConformanceResult[];
}

export interface ConformanceReport {
  schemaVersion: "1";
  adapters: readonly AdapterConformanceEvidence[];
}

export async function probeHostConformance(adapter: AgentHostAdapter): Promise<readonly ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const caps = adapter.capabilities();
  const validFidelities: readonly IntegrationFidelity[] = ["native", "approximated", "observational", "static-only", "unavailable"];
  const capabilityValues = [...Object.values(caps.lifecycle), caps.contextInjection, caps.blocking, ...Object.values(caps.install)];
  results.push({ check: "capability-completeness", status: Object.keys(caps.lifecycle).length === 5 && Object.keys(caps.install).length === 6 && capabilityValues.every(value => validFidelities.includes(value)) ? "pass" : "fail" });
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
  const deny = await adapter.project({ phase: "before-tool", sessionId: "conformance" }, { decision: "deny", reason: "policy denied" });
  const expected = caps.blocking === "unavailable" ? "observe" : "deny";
  results.push({ check: "deny-fidelity", status: deny.decision === expected && Boolean(deny.reason) ? "pass" : "fail" });
  const context = await adapter.project({ phase: "before-model", sessionId: "conformance" }, { decision: "allow", modelContext: "conduit-private-context" });
  const contextMatches = caps.lifecycle["before-model"] === "unavailable" || caps.contextInjection === "unavailable"
    ? context.modelContext === undefined
    : context.modelContext === "conduit-private-context";
  results.push({ check: "context-fidelity", status: contextMatches ? "pass" : "fail" });
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
  const adapters = await Promise.all([...inputs].sort((a, b) => a.adapter.id.localeCompare(b.adapter.id)).map(async input => ({
    evidenceScope: input.evidenceScope,
    adapterId: input.adapter.id,
    adapterVersion: input.adapterVersion,
    hostId: input.hostId,
    hostVersion: input.hostVersion,
    capabilities: normalizeCapabilities(input.adapter.capabilities()),
    limitations: Object.freeze([...(input.limitations ?? [])].sort()),
    results: Object.freeze([...(await probeHostConformance(input.adapter))].sort((a, b) => a.check.localeCompare(b.check))),
  })));
  return Object.freeze({ schemaVersion: "1", adapters: Object.freeze(adapters) });
}

function normalizeCapabilities(capabilities: HostCapabilities): HostCapabilities {
  return Object.freeze({
    lifecycle: Object.freeze({
      "session-start": capabilities.lifecycle["session-start"],
      "before-model": capabilities.lifecycle["before-model"],
      "before-tool": capabilities.lifecycle["before-tool"],
      "after-tool": capabilities.lifecycle["after-tool"],
      stop: capabilities.lifecycle.stop,
    }),
    contextInjection: capabilities.contextInjection,
    blocking: capabilities.blocking,
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
  contextInjection: "native",
  blocking: "native",
  install: install({ skill: "native", agent: "native", hook: "native", prompt: "native", command: "native", context: "static-only" }),
});

export const codexCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("unavailable", "unavailable", "unavailable", "unavailable", "observational"),
  contextInjection: "static-only",
  blocking: "unavailable",
  install: install({ skill: "native", prompt: "static-only", context: "static-only" }),
});

export const openCodeCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("native", "native", "native", "native", "approximated"),
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
  contextInjection: "native",
  blocking: "native",
  install: install({ hook: "native", prompt: "native", context: "native", skill: "approximated", agent: "approximated", command: "approximated" }),
});

export const voltAgentCapabilities: HostCapabilities = Object.freeze({
  lifecycle: lifecycle("native", "native", "native", "native", "native"),
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
    const cells = phases.map(phase => capabilities.lifecycle[phase]);
    return `| ${adapterId} | ${adapterVersion} | ${evidenceScope} | ${hostId} | ${hostVersion} | ${cells.join(" | ")} | ${capabilities.contextInjection} | ${capabilities.blocking} | ${status} | ${limitations.join("; ") || "none"} |`;
  });
  return [
    "# Host conformance matrix",
    "",
    "Generated from `conformance/host-conformance.json`. Do not edit by hand. `adapter-contract` rows prove Conduit's projection contract only; runtime selection requires `host-bound` evidence generated by the consuming host.",
    "",
    "| Adapter | Adapter version | Evidence scope | Host | Host version | Session start | Before model | Before tool | After tool | Stop | Context | Blocking | Probe | Limitations |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
