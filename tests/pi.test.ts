import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPiLifecycleHandlers,
  createPiAdapter,
  piCapabilities,
} from "../src/pi.js";
import { probeHostConformance, type LifecycleOutcome } from "../src/index.js";

describe("Pi host profile", () => {
  it("passes common conformance with caller-owned installation bindings", async () => {
    const adapter = createPiAdapter({
      resolveTarget: asset => `/fixture/pi/${asset.kind}/${asset.id}`,
      write: () => {},
    });
    assert.ok(
      (await probeHostConformance(adapter)).every(result => result.status === "pass"),
    );
    assert.equal(piCapabilities.install.agent, "unavailable");
    assert.equal(piCapabilities.install.context, "static-only");
  });

  it("binds Pi extension lifecycle, context, blocking, and completion", async () => {
    const observed: string[] = [];
    const outcomes = new Map<string, LifecycleOutcome>([
      ["before-model", {
        decision: "allow",
        modelContext: "exact model context",
      }],
      ["before-tool", {
        decision: "deny",
        reason: "exact deny reason",
      }],
    ]);
    const handlers = createPiLifecycleHandlers({
      adapter: createPiAdapter({
        resolveTarget: () => "/fixture",
        write: () => {},
      }),
      sessionId: () => "pi-session",
      evaluate(event) {
        observed.push(event.phase);
        assert.equal(event.sessionId, "pi-session");
        return outcomes.get(event.phase) ?? { decision: "observe" };
      },
    });

    await handlers.sessionStart({ type: "session_start" }, {});
    const context = await handlers.beforeAgentStart({
      type: "before_agent_start",
      systemPrompt: "base prompt",
    }, {});
    const blocked = await handlers.toolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
    }, {});
    await handlers.toolResult({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      content: [],
      isError: false,
    }, {});
    await handlers.agentSettled({ type: "agent_settled" }, {});

    assert.deepEqual(context, {
      systemPrompt: "base prompt\n\nexact model context",
    });
    assert.deepEqual(blocked, {
      block: true,
      reason: "exact deny reason",
    });
    assert.deepEqual(observed, [
      "session-start",
      "before-model",
      "before-tool",
      "after-tool",
      "stop",
    ]);
  });
});
