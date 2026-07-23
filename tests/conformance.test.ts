import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindAdapterLifecycle, claudeCodeCapabilities, codexCapabilities, createClaudeCodeAdapter, createCodexAdapter,
  createConformanceReport, createInProcessHostAdapter, createManifestHarnessAdapter,
  createOpenCodeAdapter, createStrandsAdapter, createVoltAgentAdapter, openCodeCapabilities,
  probeHostConformance, renderConformanceMatrix, serializeConformanceReport,
  strandsCapabilities, voltAgentCapabilities, type HostCapabilities,
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
    assert.equal(codexCapabilities.blocking, "unavailable");
    assert.equal(openCodeCapabilities.lifecycle.stop, "approximated");
    assert.equal(strandsCapabilities.install.skill, "approximated");
    assert.equal(voltAgentCapabilities.install.agent, "native");
  });
  it("emits deterministic, sorted JSON and Markdown evidence", async () => {
    const binding = { resolveTarget: () => "/fixture/context", write: () => {} };
    const inputs = [
      { adapter: createOpenCodeAdapter(binding), adapterVersion: "1", hostVersion: "2", limitations: ["z", "a"] },
      { adapter: createCodexAdapter(binding), adapterVersion: "1", hostVersion: "2" },
    ];
    const first = await createConformanceReport(inputs);
    const second = await createConformanceReport([...inputs].reverse());
    assert.equal(serializeConformanceReport(first), serializeConformanceReport(second));
    assert.deepEqual(first.adapters.map(adapter => adapter.adapterId), ["codex", "opencode"]);
    assert.deepEqual(first.adapters[1]?.limitations, ["a", "z"]);
    const markdown = renderConformanceMatrix(first);
    assert.match(markdown, /\| codex \|/);
    assert.ok(markdown.indexOf("| codex |") < markdown.indexOf("| opencode |"));
    const reorderedCapabilities: HostCapabilities = {
      install: { context: "native", command: "native", prompt: "native", hook: "native", agent: "native", skill: "native" },
      blocking: "native", contextInjection: "native",
      lifecycle: { stop: "native", "after-tool": "native", "before-tool": "native", "before-model": "native", "session-start": "native" },
    };
    const reordered = await createConformanceReport([{ adapter: createManifestHarnessAdapter({ id: "fixture", capabilities: reorderedCapabilities, ...binding }), adapterVersion: "1", hostVersion: "1" }]);
    assert.deepEqual(Object.keys(reordered.adapters[0]?.capabilities.lifecycle ?? {}), ["session-start", "before-model", "before-tool", "after-tool", "stop"]);
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
