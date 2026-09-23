import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindAdapterLifecycle, claudeCodeCapabilities, codexCapabilities, createClaudeCodeAdapter, createCodexAdapter,
  createConformanceReport, createInProcessHostAdapter, createManifestHarnessAdapter,
  deriveConformanceLimitations,
  normalizeCapabilities, parseConformanceReport,
  createOpenCodeAdapter, createStrandsAdapter, createVoltAgentAdapter, openCodeCapabilities,
  probeHostConformance, renderConformanceMatrix, serializeConformanceReport,
  strandsCapabilities, UnsupportedConformanceSchemaVersionError, voltAgentCapabilities, type EvidenceInput, type HostCapabilities,
} from "../src/index.js";

const all = <T>(value: T) => ({ skill: value, agent: value, hook: value, prompt: value, command: value, context: value });
const lifecycle = <T>(value: T) => ({ "session-start": value, "before-model": value, "before-tool": value, "after-tool": value, stop: value });
const native: HostCapabilities = { lifecycle: lifecycle("native"), contextInjection: "native", blocking: "native", install: all("native") };

describe("Conduit host conformance", () => {
  it("proves a filesystem-style harness adapter", async () => {
    const writes = new Map<string, string>();
    const adapter = createManifestHarnessAdapter({ id: "fixture-harness", capabilities: native, resolveTarget: a => `/fixture/${a.kind}/${a.id}`, write: (p, c) => { writes.set(p, c); } });
    assert.ok((await probeHostConformance(adapter)).every(result => result.status === "pass"));
    assert.equal(writes.get("/fixture/context/conformance-context"), "conduit-private-context-content");
  });
  it("never exposes caller-resolved targets in installation receipts", async () => {
    const adapter = createManifestHarnessAdapter({ id: "private-target", capabilities: native, resolveTarget: () => "/private/home/alice/token-secret/skill", write: () => {} });
    const receipt = await adapter.install([{ id: "safe-id", kind: "skill", content: "secret-content" }]);
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /\/private\/home\/alice|token-secret|secret-content/);
  });
  it("applies unavailable lifecycle fidelity before context projection", async () => {
    const unavailable: HostCapabilities = { lifecycle: lifecycle("unavailable"), contextInjection: "unavailable", blocking: "unavailable", install: all("unavailable") };
    const adapter = createManifestHarnessAdapter({ id: "unavailable", capabilities: unavailable, resolveTarget: () => undefined, write: () => {} });
    assert.deepEqual(await adapter.project({ phase: "before-model", sessionId: "s" }, { decision: "allow", modelContext: "private" }), { decision: "observe", reason: "lifecycle phase unavailable" });
  });
  it("proves an in-process framework and records unsupported blocking honestly", async () => {
    const capabilities: HostCapabilities = { ...native, blocking: "unavailable" };
    const adapter = createInProcessHostAdapter({ id: "fixture-sdk", capabilities, installAsset: () => {}, applyOutcome: async (_event, outcome) => outcome.decision === "deny" ? { ...outcome, decision: "observe" } : outcome });
    assert.ok((await probeHostConformance(adapter)).every(result => result.status === "pass"));
  });
  it("characterizes every shipped host independently", async () => {
    const resolveTarget = (asset: { kind: string; id: string }) => `/fixture/${asset.kind}/${asset.id}`;
    const write = () => {};
    const applyOutcome = async (_event: unknown, outcome: { decision: "allow" | "deny" | "observe"; reason?: string; modelContext?: string }) => outcome;
    const installAsset = () => {};
    const adapters = [createClaudeCodeAdapter({ resolveTarget, write }), createCodexAdapter({ resolveTarget, write }), createOpenCodeAdapter({ resolveTarget, write }), createStrandsAdapter({ applyOutcome, installAsset }), createVoltAgentAdapter({ applyOutcome, installAsset })];
    for (const adapter of adapters) assert.ok((await probeHostConformance(adapter)).every(result => result.status === "pass"), adapter.id);
    assert.equal(claudeCodeCapabilities.blocking, "native");
    assert.deepEqual(normalizeCapabilities(claudeCodeCapabilities).influence["before-tool"], {
      decision: "native",
      contextInjection: "native",
    });
    assert.equal(codexCapabilities.blocking, "unavailable");
    assert.equal(codexCapabilities.lifecycle["before-tool"], "native");
    assert.deepEqual(normalizeCapabilities(codexCapabilities).influence["before-tool"], {
      decision: "native",
      contextInjection: "native",
    });
    assert.equal(codexCapabilities.install.hook, "approximated");
    assert.equal(openCodeCapabilities.lifecycle.stop, "approximated");
    assert.equal(strandsCapabilities.install.skill, "approximated");
    assert.equal(voltAgentCapabilities.install.agent, "native");
  });
  it("installs a caller-bound Codex hook and preserves pre-tool deny and guidance fidelity", async () => {
    const writes = new Map<string, string>();
    const adapter = createCodexAdapter({
      resolveTarget: (asset) => asset.kind === "hook" ? "/fixture/.codex/hooks.json" : undefined,
      write: (target, content) => { writes.set(target, content); },
    });
    const receipt = await adapter.install([{ id: "governance-hook", kind: "hook", content: "private hook config" }]);
    assert.equal(writes.get("/fixture/.codex/hooks.json"), "private hook config");
    assert.deepEqual(receipt.installed.map((item) => ({ id: item.id, kind: item.kind })), [
      { id: "governance-hook", kind: "hook" },
    ]);
    assert.doesNotMatch(JSON.stringify(receipt), /private hook config|\.codex\/hooks\.json/);
    assert.deepEqual(await adapter.project(
      { phase: "before-tool", sessionId: "fixture" },
      { decision: "deny", reason: "policy denied", modelContext: "review this rule" },
    ), { decision: "deny", reason: "policy denied", modelContext: "review this rule" });
  });
  it("emits deterministic, sorted JSON and Markdown evidence", async () => {
    const binding = { resolveTarget: () => "/fixture/context", write: () => {} };
    const inputs = [
      { adapter: createOpenCodeAdapter(binding), evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture-open", hostVersion: "2", limitations: ["z", "a"] },
      { adapter: createCodexAdapter(binding), evidenceScope: "adapter-contract", adapterVersion: "1", hostId: "unbound", hostVersion: "unbound" },
    ] satisfies EvidenceInput[];
    const first = await createConformanceReport(inputs);
    const second = await createConformanceReport([...inputs].reverse());
    assert.equal(serializeConformanceReport(first), serializeConformanceReport(second));
    assert.doesNotMatch(
      serializeConformanceReport(first),
      /"blocking"|"contextInjection": "static-only",\n\s+"blocking"/,
    );
    assert.deepEqual(first.adapters.map(adapter => adapter.adapterId), ["codex", "opencode"]);
    assert.deepEqual(first.adapters[1]?.limitations, [
      "a",
      "capability.lifecycle.stop=approximated",
      "z",
    ]);
    const markdown = renderConformanceMatrix(first);
    assert.match(markdown, /\| codex \|/);
    assert.ok(markdown.indexOf("| codex |") < markdown.indexOf("| opencode |"));
    const reorderedCapabilities: HostCapabilities = {
      install: { context: "native", command: "native", prompt: "native", hook: "native", agent: "native", skill: "native" },
      blocking: "native", contextInjection: "native",
      lifecycle: { stop: "native", "after-tool": "native", "before-tool": "native", "before-model": "native", "session-start": "native" },
    };
    const reordered = await createConformanceReport([{ adapter: createManifestHarnessAdapter({ id: "fixture", capabilities: reorderedCapabilities, ...binding }), evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture", hostVersion: "1" }]);
    assert.deepEqual(Object.keys(reordered.adapters[0]?.capabilities.lifecycle ?? {}), ["session-start", "before-model", "before-tool", "after-tool", "stop"]);
  });
  it("derives every non-native capability and failed probe as a stable limitation", () => {
    const capabilities: HostCapabilities = {
      lifecycle: {
        "session-start": "native",
        "before-model": "approximated",
        "before-tool": "observational",
        "after-tool": "static-only",
        stop: "unavailable",
      },
      contextInjection: "static-only",
      blocking: "unavailable",
      install: {
        skill: "native",
        agent: "approximated",
        hook: "observational",
        prompt: "static-only",
        command: "unavailable",
        context: "native",
      },
    };
    assert.deepEqual(deriveConformanceLimitations(capabilities, [
      { check: "z-check", status: "fail", detail: "runtime-specific detail" },
      { check: "a-check", status: "pass" },
      { check: "z-check", status: "fail" },
    ]), [
      "capability.influence.after-tool.contextInjection=static-only",
      "capability.influence.after-tool.decision=unavailable",
      "capability.influence.before-model.contextInjection=static-only",
      "capability.influence.before-model.decision=unavailable",
      "capability.influence.before-tool.contextInjection=static-only",
      "capability.influence.before-tool.decision=unavailable",
      "capability.influence.session-start.contextInjection=static-only",
      "capability.influence.session-start.decision=unavailable",
      "capability.influence.stop.contextInjection=static-only",
      "capability.influence.stop.decision=unavailable",
      "capability.install.agent=approximated",
      "capability.install.command=unavailable",
      "capability.install.hook=observational",
      "capability.install.prompt=static-only",
      "capability.lifecycle.after-tool=static-only",
      "capability.lifecycle.before-model=approximated",
      "capability.lifecycle.before-tool=observational",
      "capability.lifecycle.stop=unavailable",
      "probe.z-check=fail",
    ]);
  });
  it("migrates legacy aggregate influence explicitly and rejects old report versions", () => {
    const normalized = normalizeCapabilities(native);
    for (const phase of Object.keys(normalized.lifecycle) as (keyof typeof normalized.lifecycle)[]) {
      assert.deepEqual(normalized.influence[phase], {
        decision: "native",
        contextInjection: "native",
      });
    }
    assert.throws(
      () => parseConformanceReport('{"schemaVersion":"1","adapters":[]}'),
      (error: unknown) =>
        error instanceof UnsupportedConformanceSchemaVersionError &&
        error.schemaVersion === "1",
    );
    assert.equal(
      parseConformanceReport('{"schemaVersion":"2","adapters":[]}').schemaVersion,
      "2",
    );
  });
  it("merges derived limitations with host prose once for JSON and Markdown", async () => {
    const unavailable: HostCapabilities = {
      lifecycle: lifecycle("unavailable"),
      contextInjection: "unavailable",
      blocking: "unavailable",
      install: all("unavailable"),
    };
    const adapter = createManifestHarnessAdapter({
      id: "limited",
      capabilities: unavailable,
      resolveTarget: () => undefined,
      write: () => {},
    });
    const report = await createConformanceReport([{
      adapter,
      evidenceScope: "adapter-contract",
      adapterVersion: "1",
      hostId: "unbound",
      hostVersion: "unbound",
      limitations: [
        "host-specific explanation",
        "capability.influence.before-tool.decision=unavailable",
      ],
    }]);
    const limitations = report.adapters[0]?.limitations ?? [];
    assert.equal(
      limitations.filter(value => value === "capability.influence.before-tool.decision=unavailable").length,
      1,
    );
    assert.ok(limitations.includes("host-specific explanation"));
    assert.match(
      renderConformanceMatrix(report),
      /capability\.influence\.before-tool\.decision=unavailable.*host-specific explanation/,
    );
    assert.match(
      serializeConformanceReport(report),
      /"capability\.influence\.before-tool\.decision=unavailable"/,
    );
  });
  it("projects failed executable probes into report limitations", async () => {
    const adapter = createInProcessHostAdapter({
      id: "failing-probe",
      capabilities: native,
      installAsset: () => {},
      applyOutcome: () => ({ decision: "observe" }),
    });
    const report = await createConformanceReport([{
      adapter,
      evidenceScope: "adapter-contract",
      adapterVersion: "1",
      hostId: "unbound",
      hostVersion: "unbound",
    }]);
    assert.deepEqual(report.adapters[0]?.limitations, [
      "probe.context-after-tool=fail",
      "probe.context-before-model=fail",
      "probe.context-before-tool=fail",
      "probe.context-session-start=fail",
      "probe.context-stop=fail",
      "probe.decision-after-tool=fail",
      "probe.decision-before-model=fail",
      "probe.decision-before-tool=fail",
      "probe.decision-session-start=fail",
      "probe.decision-stop=fail",
      "probe.lifecycle-after-tool=fail",
      "probe.lifecycle-before-model=fail",
      "probe.lifecycle-before-tool=fail",
      "probe.lifecycle-session-start=fail",
      "probe.lifecycle-stop=fail",
    ]);
  });
  it("binds the same evaluator to caller-owned framework registrars", async () => {
    const handlers = new Map<string, (event: { phase: "before-tool"; sessionId: string }) => Promise<unknown>>();
    const disposed: string[] = [];
    const adapter = createStrandsAdapter({ installAsset: () => {}, applyOutcome: async (_event, outcome) => outcome });
    const dispose = bindAdapterLifecycle({
      adapter,
      registrar: { register: (phase, handler) => { handlers.set(phase, handler as never); return () => { disposed.push(phase); }; } },
      evaluate: event => ({ decision: event.phase === "before-tool" ? "deny" : "allow", reason: "application policy" }),
    });
    const outcome = await handlers.get("before-tool")?.({ phase: "before-tool", sessionId: "s1" });
    assert.deepEqual(outcome, { decision: "deny", reason: "application policy" });
    dispose();
    assert.equal(disposed.length, 5);
  });
});
