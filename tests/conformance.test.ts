import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInProcessHostAdapter, createManifestHarnessAdapter, probeHostConformance, type HostCapabilities } from "../src/index.js";

const all = <T>(value: T) => ({ skill: value, agent: value, hook: value, prompt: value, command: value, context: value });
const lifecycle = <T>(value: T) => ({ "session-start": value, "before-model": value, "before-tool": value, "after-tool": value, stop: value });
const native: HostCapabilities = { lifecycle: lifecycle("native"), contextInjection: "native", blocking: "native", install: all("native") };

describe("Conduit host conformance", () => {
  it("proves a filesystem-style harness adapter", async () => {
    const writes = new Map<string, string>();
    const adapter = createManifestHarnessAdapter({ id: "fixture-harness", capabilities: native, resolveTarget: a => `/fixture/${a.kind}/${a.id}`, write: (p, c) => { writes.set(p, c); } });
    assert.deepEqual((await probeHostConformance(adapter)).map(r => r.status), ["pass", "pass", "pass"]);
    assert.equal(writes.get("/fixture/context/probe"), "probe");
  });
  it("proves an in-process framework and records unsupported blocking honestly", async () => {
    const capabilities: HostCapabilities = { ...native, blocking: "unavailable" };
    const adapter = createInProcessHostAdapter({ id: "fixture-sdk", capabilities, installAsset: () => {}, applyOutcome: async (_event, outcome) => outcome.decision === "deny" ? { ...outcome, decision: "observe" } : outcome });
    assert.deepEqual((await probeHostConformance(adapter)).map(r => r.status), ["pass", "pass", "pass"]);
  });
});
