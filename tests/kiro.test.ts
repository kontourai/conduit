import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKiroAdapter,
  evaluateKiroHook,
  kiroCapabilities,
  UnsupportedKiroHookEventError,
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

  it("refuses unmapped hook event names before evaluating them", async () => {
    let evaluated = 0;
    const adapter = createKiroAdapter({ resolveTarget: () => "/fixture", write: () => {} });
    for (const outcome of [
      { decision: "deny", reason: "policy denied" },
      { decision: "allow", modelContext: "guidance" },
      { decision: "allow" },
    ] as const) {
      for (const name of ["sessionEnd", "constructor", "toString"]) {
        // Decoded stdin is untyped at runtime; a newer host can send any name.
        const event = hook("stop", {}) as unknown as Record<string, unknown>;
        event.hook_event_name = name;
        await assert.rejects(
          evaluateKiroHook(
            { adapter, evaluate: () => { evaluated += 1; return outcome; } },
            event as unknown as KiroHookEvent,
          ),
          (error: unknown) =>
            error instanceof UnsupportedKiroHookEventError &&
            error.code === "UNSUPPORTED_KIRO_HOOK_EVENT" &&
            error.hookEventName === name &&
            error.message.includes(JSON.stringify(name)),
        );
      }
    }
    assert.equal(evaluated, 0);
  });

  it("applies both projection rules to a downgraded deny that carries context (#35)", async () => {
    const adapter = createKiroAdapter({ resolveTarget: () => "/fixture", write: () => {} });
    const outcome: LifecycleOutcome = { decision: "deny", reason: "r", modelContext: "ctx" };
    const afterTool = await adapter.project({ phase: "after-tool", sessionId: "kiro-session" }, outcome);
    assert.equal(afterTool.decision, "observe");
    assert.equal(afterTool.reason, "r");
    assert.equal(afterTool.modelContext, undefined);
    // session-start cannot block but can inject, so only the decision changes.
    assert.deepEqual(
      await adapter.project({ phase: "session-start", sessionId: "kiro-session" }, outcome),
      { decision: "observe", reason: "r", modelContext: "ctx" },
    );
  });
});
