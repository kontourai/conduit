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
  installed: readonly { id: string; kind: AssetKind; digest: string; target?: string }[];
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
        installed.push({ id: asset.id, kind: asset.kind, digest: digest(asset.content), target });
      }
      return Object.freeze({ hostId: options.id, installed: Object.freeze(installed), skipped: Object.freeze(skipped) });
    },
    async project(event, outcome) {
      const fidelity = options.capabilities.lifecycle[event.phase];
      if (outcome.decision === "deny" && options.capabilities.blocking === "unavailable") {
        return Object.freeze({ ...outcome, decision: "observe", reason: outcome.reason ?? "host cannot block" });
      }
      if (outcome.modelContext && options.capabilities.contextInjection === "unavailable") {
        return Object.freeze({ ...outcome, modelContext: undefined, reason: outcome.reason ?? "host cannot inject context" });
      }
      return fidelity === "unavailable" ? Object.freeze({ decision: "observe", reason: "lifecycle phase unavailable" }) : outcome;
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

export async function probeHostConformance(adapter: AgentHostAdapter): Promise<readonly ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const caps = adapter.capabilities();
  results.push({ check: "capability-completeness", status: Object.keys(caps.lifecycle).length === 5 && Object.keys(caps.install).length === 6 ? "pass" : "fail" });
  const receipt = await adapter.install([{ id: "probe", kind: "context", content: "probe" }]);
  results.push({ check: "secret-free-install-receipt", status: JSON.stringify(receipt).includes("probe") && !JSON.stringify(receipt).includes('"content"') ? "pass" : "fail" });
  const deny = await adapter.project({ phase: "before-tool", sessionId: "conformance" }, { decision: "deny", reason: "policy denied" });
  const expected = caps.blocking === "unavailable" ? "observe" : "deny";
  results.push({ check: "deny-fidelity", status: deny.decision === expected && Boolean(deny.reason) ? "pass" : "fail" });
  return Object.freeze(results);
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
