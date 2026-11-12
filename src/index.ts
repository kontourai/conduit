import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

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
  // Both rules apply independently. A downgraded deny must still lose context the
  // phase cannot inject. The first default reason set wins, so a downgraded deny
  // without a reason reports "host cannot block".
  let projected = outcome;
  if (projected.decision === "deny" && !canInfluence(normalized.influence[event.phase].decision)) {
    projected = { ...projected, decision: "observe", reason: projected.reason ?? "host cannot block" };
  }
  if (projected.modelContext && !canInfluence(normalized.influence[event.phase].contextInjection)) {
    projected = { ...projected, modelContext: undefined, reason: projected.reason ?? "host cannot inject context" };
  }
  return projected === outcome ? outcome : Object.freeze(projected);
};

const canInfluence = (fidelity: IntegrationFidelity): boolean =>
  fidelity === "native" || fidelity === "approximated";

/**
 * What a Conduit factory knows about an adapter it built: an install path with
 * the adapter's own target mapping, fidelity rules, and receipt shape but none
 * of the caller's I/O, plus the binding that I/O would go through. Only
 * Conduit's adapter factories register here, so a probe can tell an adapter
 * whose writes it controls from an arbitrary object with an `install` method.
 */
interface FactoryInstall {
  inert: AgentHostAdapter["install"];
  resolveTarget?: ManifestHarnessOptions["resolveTarget"];
  /**
   * Install through the caller's `write` using targets resolved beforehand,
   * keyed by asset id, calling `beforeWrite` immediately before each write.
   */
  installResolved?(
    assets: readonly PortableAsset[],
    targets: ReadonlyMap<string, string | undefined>,
    beforeWrite: (target: string) => void,
  ): Promise<InstallationReceipt>;
  installAsset?: InProcessHostOptions["installAsset"];
}
const factoryInstalls = new WeakMap<AgentHostAdapter, FactoryInstall>();

/** Harness adapter with host-owned path mapping and I/O. Conduit never guesses config locations. */
export function createManifestHarnessAdapter(options: ManifestHarnessOptions): AgentHostAdapter {
  const install = async (
    assets: readonly PortableAsset[],
    write: ManifestHarnessOptions["write"] | undefined,
    resolveTarget: ManifestHarnessOptions["resolveTarget"] = options.resolveTarget,
    beforeWrite?: (target: string) => void,
  ): Promise<InstallationReceipt> => {
    const installed: InstallationReceipt["installed"][number][] = [];
    const skipped: InstallationReceipt["skipped"][number][] = [];
    for (const asset of assets) {
      const fidelity = options.capabilities.install[asset.kind];
      const target = resolveTarget(asset);
      if (fidelity === "unavailable" || !target) {
        skipped.push({ id: asset.id, kind: asset.kind, reason: fidelity === "unavailable" ? "unsupported" : "unmapped" });
        continue;
      }
      if (write) {
        beforeWrite?.(target);
        await write(target, asset.content);
      }
      installed.push({ id: asset.id, kind: asset.kind, digest: digest(asset.content) });
    }
    return Object.freeze({ hostId: options.id, installed: Object.freeze(installed), skipped: Object.freeze(skipped) });
  };
  const adapter: AgentHostAdapter = {
    id: options.id,
    capabilities: () => options.capabilities,
    install: assets => install(assets, options.write),
    async project(event, outcome) {
      return projectCapability(options.capabilities, event, outcome);
    },
  };
  factoryInstalls.set(adapter, {
    inert: assets => install(assets, undefined),
    resolveTarget: options.resolveTarget,
    installResolved: (assets, targets, beforeWrite) =>
      install(assets, options.write, asset => targets.get(asset.id), beforeWrite),
  });
  return adapter;
}

export interface InProcessHostOptions {
  id: string;
  capabilities: HostCapabilities;
  installAsset?(asset: PortableAsset): void | Promise<void>;
  applyOutcome(event: LifecycleEvent, outcome: LifecycleOutcome): LifecycleOutcome | Promise<LifecycleOutcome>;
}

/** SDK/framework adapter: the host supplies lifecycle influence and optional asset registration. */
export function createInProcessHostAdapter(options: InProcessHostOptions): AgentHostAdapter {
  const install = async (assets: readonly PortableAsset[], register: boolean): Promise<InstallationReceipt> => {
    const installed: InstallationReceipt["installed"][number][] = [];
    const skipped: InstallationReceipt["skipped"][number][] = [];
    for (const asset of assets) {
      if (!options.installAsset || options.capabilities.install[asset.kind] === "unavailable") {
        skipped.push({ id: asset.id, kind: asset.kind, reason: "unsupported" });
      } else {
        if (register) await options.installAsset(asset);
        installed.push({ id: asset.id, kind: asset.kind, digest: digest(asset.content) });
      }
    }
    return Object.freeze({ hostId: options.id, installed: Object.freeze(installed), skipped: Object.freeze(skipped) });
  };
  const adapter: AgentHostAdapter = {
    id: options.id,
    capabilities: () => options.capabilities,
    install: assets => install(assets, true),
    async project(event, outcome) {
      return projectCapability(
        options.capabilities,
        event,
        await options.applyOutcome(event, outcome),
      );
    },
  };
  factoryInstalls.set(adapter, { inert: assets => install(assets, false), installAsset: options.installAsset });
  return adapter;
}

export interface ConformanceResult { check: string; status: "pass" | "fail"; detail?: string }

export type InstallEvidence = "inert" | "sandbox";

export interface AdapterConformanceEvidence {
  /** What the executable probe actually exercised. */
  evidenceScope: "adapter-contract" | "host-bound";
  /**
   * How the probe installed its assets. `inert` ran the adapter's target
   * mapping and receipt without the caller's install I/O; `sandbox` installed
   * through a caller-supplied `installSandbox` adapter.
   */
  installEvidence: InstallEvidence;
  adapterId: string;
  adapterVersion: string;
  hostId: string;
  hostVersion: string;
  capabilities: NormalizedHostCapabilities;
  limitations: readonly string[];
  results: readonly ConformanceResult[];
}

export interface ConformanceReport {
  schemaVersion: "3";
  adapters: readonly AdapterConformanceEvidence[];
}

/** Version 2 entries predate `installEvidence`; whether install I/O ran is unknown. */
export type AdapterConformanceEvidenceV2 = Omit<AdapterConformanceEvidence, "installEvidence">;

export interface ConformanceReportV2 {
  schemaVersion: "2";
  adapters: readonly AdapterConformanceEvidenceV2[];
}

/** The report parsed a supported version but carries a value that version forbids. */
export class InvalidConformanceReportError extends Error {
  readonly code = "INVALID_CONFORMANCE_REPORT";
  constructor(message: string) {
    super(`Invalid Conduit conformance report: ${message}`);
    this.name = "InvalidConformanceReportError";
  }
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

export type UnsafeConformanceProbeReason =
  | "no-inert-install"
  | "sandbox-is-adapter"
  | "sandbox-mismatch"
  | "sandbox-target-outside-root"
  | "sandbox-write-unverified"
  | "target-resolution-failed";

/**
 * The probe refused to install its fixture assets because it could not show the
 * install would leave the caller's host untouched.
 */
export class UnsafeConformanceProbeError extends Error {
  readonly code = "UNSAFE_CONFORMANCE_PROBE";
  constructor(readonly adapterId: string, readonly reason: UnsafeConformanceProbeReason, options?: { cause?: unknown }) {
    super(`Refusing to probe adapter ${adapterId}: ${unsafeProbeMessages[reason]}`, options);
    this.name = "UnsafeConformanceProbeError";
  }
}

const unsafeProbeMessages: Readonly<Record<UnsafeConformanceProbeReason, string>> = {
  "no-inert-install": "it was not created by a Conduit adapter factory, so installing probe assets could modify its bound host. Pass an installSandbox factory.",
  "sandbox-is-adapter": "the installSandbox factory returned the adapter under test.",
  "sandbox-mismatch": "the installSandbox factory returned an adapter with a different id or capabilities.",
  "sandbox-target-outside-root": "an installSandbox target is not a normalized path inside the probe's temporary root, or passes through a symlink.",
  "sandbox-write-unverified": "after installing, the probe's temporary root held a symlink or special file, or an installed target was not a regular file there.",
  "target-resolution-failed": "the installSandbox adapter's resolveTarget threw.",
};

/**
 * Builds an adapter with the same id and capabilities as the adapter under
 * test, bound to `root`: a fresh, empty, private directory the probe creates
 * and removes. A Conduit file adapter's targets must lie inside `root`.
 */
export type InstallSandboxFactory = (root: string) => AgentHostAdapter;

export interface ProbeOptions {
  /**
   * Exercise the caller's own install I/O: the probe creates a temporary root,
   * installs its fixture assets through the adapter this factory builds for
   * it, verifies the result, and removes the root.
   */
  installSandbox?: InstallSandboxFactory;
}

/**
 * Probe an adapter's declared capabilities, install receipts, and lifecycle
 * projection. The probe never installs through the adapter under test: by
 * default it uses the I/O-free install path of an adapter created by a Conduit
 * factory, and otherwise it requires `options.installSandbox`. It throws
 * `UnsafeConformanceProbeError` when neither is available.
 */
export async function probeHostConformance(adapter: AgentHostAdapter, options: ProbeOptions = {}): Promise<readonly ConformanceResult[]> {
  return (await runProbe(adapter, options)).results;
}

async function runProbe(
  adapter: AgentHostAdapter,
  options: ProbeOptions,
): Promise<{ results: readonly ConformanceResult[]; installEvidence: InstallEvidence }> {
  const { install, mode } = probeInstaller(adapter, options);
  const results: ConformanceResult[] = [];
  const caps = normalizeCapabilities(adapter.capabilities());
  const validFidelities: readonly IntegrationFidelity[] = ["native", "approximated", "observational", "static-only", "unavailable"];
  const influenceValues = Object.values(caps.influence).flatMap(value => [value.decision, value.contextInjection]);
  const capabilityValues = [...Object.values(caps.lifecycle), ...influenceValues, ...Object.values(caps.install)];
  results.push({ check: "capability-completeness", status: Object.keys(caps.lifecycle).length === 5 && Object.keys(caps.influence).length === 5 && Object.keys(caps.install).length === 6 && capabilityValues.every(value => validFidelities.includes(value)) ? "pass" : "fail" });
  const kinds = probeAssets.map(asset => asset.kind);
  const receipt = await install(probeAssets);
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
    const combined = await adapter.project({ phase, sessionId: "conformance" }, { decision: "deny", reason: "policy denied", modelContext: "conduit-private-context" });
    const combinedContextMatches = caps.lifecycle[phase] === "unavailable" || !canInfluence(caps.influence[phase].contextInjection)
      ? combined.modelContext === undefined
      : combined.modelContext === "conduit-private-context";
    results.push({ check: `decision-context-${phase}`, status: combined.decision === expected && Boolean(combined.reason) && combinedContextMatches ? "pass" : "fail" });
  }
  return { results: Object.freeze(results), installEvidence: mode };
}

const probeAssets: readonly PortableAsset[] = Object.freeze(
  (["skill", "agent", "hook", "prompt", "command", "context"] as const).map(kind => Object.freeze({
    id: `conformance-${kind}`,
    kind,
    content: `conduit-private-${kind}-content`,
  })),
);

interface ProbeInstaller {
  install: AgentHostAdapter["install"];
  mode: InstallEvidence;
}

function probeInstaller(adapter: AgentHostAdapter, options: ProbeOptions): ProbeInstaller {
  const factory = options.installSandbox;
  if (factory === undefined) {
    const registered = factoryInstalls.get(adapter);
    if (!registered) throw new UnsafeConformanceProbeError(adapter.id, "no-inert-install");
    return { install: registered.inert, mode: "inert" };
  }
  if (typeof factory !== "function") throw new TypeError("installSandbox must be a function of the probe's temporary root");
  return { install: assets => installInSandbox(adapter, factory, assets), mode: "sandbox" };
}

/**
 * Install through a sandbox the caller builds for a root this probe creates.
 * Nothing exists in the root beforehand, so a Conduit file adapter's targets
 * are checked structurally: each must be a normalized path inside the root,
 * no existing component may be a symlink when it is written, and afterwards
 * every entry under the root must be a plain directory or file, with each
 * installed target a regular file. The root is removed however the install
 * ends.
 */
async function installInSandbox(
  adapter: AgentHostAdapter,
  factory: InstallSandboxFactory,
  assets: readonly PortableAsset[],
): Promise<InstallationReceipt> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "conduit-probe-")));
  try {
    const sandbox = factory(root);
    if (sandbox === adapter) throw new UnsafeConformanceProbeError(adapter.id, "sandbox-is-adapter");
    const sameCapabilities = JSON.stringify(normalizeCapabilities(sandbox.capabilities()))
      === JSON.stringify(normalizeCapabilities(adapter.capabilities()));
    if (sandbox.id !== adapter.id || !sameCapabilities) throw new UnsafeConformanceProbeError(adapter.id, "sandbox-mismatch");
    const registered = factoryInstalls.get(sandbox);
    if (!registered?.resolveTarget || !registered.installResolved) {
      // In-process and hand-written sandboxes expose no targets to check.
      const receipt = await sandbox.install(assets);
      verifyRootContents(adapter.id, root, []);
      return receipt;
    }
    // Resolve each target once and install to exactly that value, so a
    // resolver cannot pass the check with one target and write to another.
    let targets: Map<string, string | undefined>;
    try {
      targets = new Map(assets.map(asset => [asset.id, registered.resolveTarget?.(asset)]));
    } catch (cause) {
      throw new UnsafeConformanceProbeError(adapter.id, "target-resolution-failed", { cause });
    }
    for (const target of targets.values()) {
      if (target && !isInsideRoot(root, target)) throw new UnsafeConformanceProbeError(adapter.id, "sandbox-target-outside-root");
    }
    const receipt = await registered.installResolved(assets, targets, target => {
      if (passesThroughSymlink(root, target)) throw new UnsafeConformanceProbeError(adapter.id, "sandbox-target-outside-root");
    });
    const installed = receipt.installed.map(item => targets.get(item.id)).filter((target): target is string => Boolean(target));
    verifyRootContents(adapter.id, root, installed);
    return receipt;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Lexical containment: absolute, already normalized, no `..`, strictly below `root`. */
function isInsideRoot(root: string, target: string): boolean {
  if (!isAbsolute(target) || normalize(target) !== target) return false;
  if (target.split(sep).includes("..")) return false;
  const rest = relative(root, target);
  return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/**
 * True when any existing component between `root` and `target` is a symlink,
 * or cannot be inspected. A missing component ends the walk: nothing below it
 * exists yet.
 */
function passesThroughSymlink(root: string, target: string): boolean {
  let path = root;
  for (const segment of relative(root, target).split(sep)) {
    path = join(path, segment);
    try {
      if (lstatSync(path).isSymbolicLink()) return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
  return false;
}

function verifyRootContents(adapterId: string, root: string, installed: readonly string[]): void {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) throw new UnsafeConformanceProbeError(adapterId, "sandbox-write-unverified");
  }
  for (const target of installed) {
    let file = false;
    try {
      file = lstatSync(target).isFile();
    } catch {
      file = false;
    }
    if (!file) throw new UnsafeConformanceProbeError(adapterId, "sandbox-write-unverified");
  }
}

/** Added to every report entry whose probe did not run the caller's install I/O. */
export const inertInstallLimitation = "probe.install-io=not-exercised";

export interface EvidenceInput {
  adapter: AgentHostAdapter;
  /** Passed to `probeHostConformance` as `installSandbox`. */
  installSandbox?: InstallSandboxFactory;
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
    const probe = await runProbe(input.adapter, { installSandbox: input.installSandbox });
    const results = Object.freeze([...probe.results].sort((a, b) => a.check.localeCompare(b.check)));
    const installEvidence = probe.installEvidence;
    const limitations = new Set([
      // Only the probe decides whether install I/O ran; a caller cannot claim it.
      ...(input.limitations ?? []).filter(limitation => limitation !== inertInstallLimitation),
      ...deriveConformanceLimitations(input.adapter.capabilities(), results),
      ...(installEvidence === "inert" ? [inertInstallLimitation] : []),
    ]);
    return {
      evidenceScope: input.evidenceScope,
      installEvidence,
      adapterId: input.adapter.id,
      adapterVersion: input.adapterVersion,
      hostId: input.hostId,
      hostVersion: input.hostVersion,
      capabilities,
      limitations: Object.freeze([...limitations].sort()),
      results,
    };
  }));
  return Object.freeze({ schemaVersion: "3", adapters: Object.freeze(adapters) });
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

export function serializeConformanceReport(report: ConformanceReport | ConformanceReportV2): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Parse the current evidence contract (version 3) or the previous one (version
 * 2). Other versions fail explicitly. Only `installEvidence` is checked beyond
 * the version.
 */
export function parseConformanceReport(serialized: string): ConformanceReport | ConformanceReportV2 {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || !("schemaVersion" in value) || (value.schemaVersion !== "2" && value.schemaVersion !== "3")) {
    throw new UnsupportedConformanceSchemaVersionError(
      value && typeof value === "object" && "schemaVersion" in value
        ? value.schemaVersion
        : undefined,
    );
  }
  const adapters: unknown = "adapters" in value ? value.adapters : undefined;
  if (!Array.isArray(adapters)) {
    if (value.schemaVersion === "3") throw new InvalidConformanceReportError("adapters must be an array");
    return value as ConformanceReportV2;
  }
  adapters.forEach((entry: unknown, index) => {
    const installEvidence: unknown = entry && typeof entry === "object" && "installEvidence" in entry ? entry.installEvidence : undefined;
    if (value.schemaVersion === "2" && installEvidence !== undefined) {
      throw new InvalidConformanceReportError(`adapters[${index}].installEvidence is not part of schema version 2`);
    }
    if (value.schemaVersion === "3" && installEvidence !== "inert" && installEvidence !== "sandbox") {
      throw new InvalidConformanceReportError(`adapters[${index}].installEvidence must be "inert" or "sandbox"`);
    }
  });
  return value.schemaVersion === "3" ? value as ConformanceReport : value as ConformanceReportV2;
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
    "before-tool": { decision: "native", contextInjection: "native" },
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
  // Disposal runs once, in reverse registration order. Later calls are no-ops,
  // so a caller that disposes twice never re-runs or reorders host disposers.
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]();
  };
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

export function renderConformanceMatrix(report: ConformanceReport | ConformanceReportV2): string {
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
