import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKiroAdapter,
  evaluateKiroHook,
  kiroCapabilities,
  type KiroHookEvent,
} from "../src/kiro.js";
import {
  probeHostConformance,
  type LifecycleEvent,
  type LifecycleOutcome,
} from "../src/index.js";

const hook = (
  hook_event_name: KiroHookEvent["hook_event_name"],
  extra: Partial<KiroHookEvent> = {},
): KiroHookEvent => ({
  hook_event_name,
  cwd: "/fixture",
  session_id: "kiro-session",
  ...extra,
});

describe("Kiro CLI host profile", () => {
  it("passes common conformance with caller-owned installation bindings", async () => {
    const adapter = createKiroAdapter({
      resolveTarget: asset => `/fixture/kiro/${asset.kind}/${asset.id}`,
      write: () => {},
    });
    assert.ok(
      (await probeHostConformance(adapter)).every(result => result.status === "pass"),
    );
    assert.equal(kiroCapabilities.install.command, "unavailable");
    assert.equal(kiroCapabilities.install.context, "static-only");
    assert.equal(kiroCapabilities.influence?.["before-tool"].decision, "native");
    assert.equal(kiroCapabilities.influence?.stop.decision, "native");
    assert.equal(kiroCapabilities.influence?.["session-start"].contextInjection, "native");
    assert.equal(kiroCapabilities.influence?.["after-tool"].contextInjection, "unavailable");
  });

  it("maps the documented CLI hook protocol without losing context or reasons", async () => {
    const observed: string[] = [];
    const outcomes = new Map<string, LifecycleOutcome>([
      ["session-start", { decision: "observe", modelContext: "spawn context" }],
      ["before-model", { decision: "allow", modelContext: "prompt context" }],
      ["before-tool", { decision: "deny", reason: "exact tool reason" }],
      ["stop", { decision: "deny", reason: "exact stop reason" }],
    ]);
    const options = {
      adapter: createKiroAdapter({
        resolveTarget: () => "/fixture",
        write: () => {},
      }),
      evaluate(event: LifecycleEvent) {
        observed.push(event.phase);
        assert.equal(event.sessionId, "kiro-session");
        return outcomes.get(event.phase) ?? { decision: "observe" as const };
      },
    };

    assert.deepEqual(await evaluateKiroHook(options, hook("agentSpawn")), {
      exitCode: 0,
      stdout: "spawn context",
    });
    assert.deepEqual(
      await evaluateKiroHook(
        options,
        hook("userPromptSubmit", { prompt: "hello" }),
      ),
      { exitCode: 0, stdout: "prompt context" },
    );
    assert.deepEqual(
      await evaluateKiroHook(
        options,
        hook("preToolUse", { tool_name: "shell", tool_input: {} }),
      ),
      { exitCode: 2, stderr: "exact tool reason" },
    );
    assert.deepEqual(
      await evaluateKiroHook(
        options,
        hook("postToolUse", {
          tool_name: "shell",
          tool_input: {},
          tool_response: { success: true },
        }),
      ),
      { exitCode: 0 },
    );
    assert.deepEqual(
      await evaluateKiroHook(
        options,
        hook("stop", { assistant_response: "done" }),
      ),
      {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "block",
          reason: "exact stop reason",
        }),
      },
    );
    assert.deepEqual(observed, [
      "session-start",
      "before-model",
      "before-tool",
      "after-tool",
      "stop",
    ]);
  });
});
