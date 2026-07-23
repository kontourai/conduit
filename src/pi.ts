import {
  createManifestHarnessAdapter,
  type AgentHostAdapter,
  type LifecycleEvent,
  type LifecycleOutcome,
  type LocalHarnessBinding,
  type HostCapabilities,
} from "./index.js";

const lifecycle = Object.freeze({
  "session-start": "native",
  "before-model": "native",
  "before-tool": "native",
  "after-tool": "native",
  stop: "native",
} as const);

/**
 * Pi 0.80.6+ extension-surface fidelity. Extensions expose native lifecycle
 * events, model-context replacement, and reason-bearing tool blocking.
 */
export const piCapabilities: HostCapabilities = Object.freeze({
  lifecycle,
  contextInjection: "native",
  blocking: "native",
  install: Object.freeze({
    skill: "native",
    agent: "unavailable",
    hook: "native",
    prompt: "native",
    command: "approximated",
    context: "static-only",
  }),
});

/** Filesystem installation stays caller-bound; Conduit never guesses Pi paths. */
export const createPiAdapter = (
  binding: LocalHarnessBinding,
): AgentHostAdapter =>
  createManifestHarnessAdapter({
    id: "pi",
    capabilities: piCapabilities,
    ...binding,
  });

export interface PiExtensionBindingOptions {
  adapter: AgentHostAdapter;
  /** Resolve the host-owned session identity without exposing Pi storage paths. */
  sessionId(
    phase: LifecycleEvent["phase"],
    event: unknown,
    context: unknown,
  ): string;
  evaluate(event: LifecycleEvent): LifecycleOutcome | Promise<LifecycleOutcome>;
}

export interface PiBeforeAgentStartEvent {
  type?: "before_agent_start";
  systemPrompt: string;
}

export interface PiToolCallBlock {
  block: true;
  reason?: string;
}

export interface PiLifecycleHandlers {
  sessionStart(event: unknown, context: unknown): Promise<void>;
  beforeAgentStart(
    event: PiBeforeAgentStartEvent,
    context: unknown,
  ): Promise<{ systemPrompt: string } | undefined>;
  toolCall(
    event: unknown,
    context: unknown,
  ): Promise<PiToolCallBlock | undefined>;
  toolResult(event: unknown, context: unknown): Promise<void>;
  agentSettled(event: unknown, context: unknown): Promise<void>;
}

const lifecycleEvent = (
  options: PiExtensionBindingOptions,
  phase: LifecycleEvent["phase"],
  event: unknown,
  context: unknown,
): LifecycleEvent => ({
  phase,
  sessionId: options.sessionId(phase, event, context),
  context: Object.freeze({ hostEvent: event }),
});

const evaluate = async (
  options: PiExtensionBindingOptions,
  phase: LifecycleEvent["phase"],
  event: unknown,
  context: unknown,
): Promise<LifecycleOutcome> => {
  const projectedEvent = lifecycleEvent(options, phase, event, context);
  return await options.adapter.project(
    projectedEvent,
    await options.evaluate(projectedEvent),
  );
};

/**
 * Create handlers for Pi's public extension events.
 *
 * Register the returned functions with Pi's `session_start`,
 * `before_agent_start`, `tool_call`, `tool_result`, and `agent_settled`
 * events. The tool handler preserves a deny reason in Pi's model-visible
 * block and the model handler appends context without modifying it.
 */
export function createPiLifecycleHandlers(
  options: PiExtensionBindingOptions,
): PiLifecycleHandlers {
  const handlers: PiLifecycleHandlers = {
    async sessionStart(event, context) {
      await evaluate(options, "session-start", event, context);
    },
    async beforeAgentStart(event, context) {
      const outcome = await evaluate(options, "before-model", event, context);
      if (!outcome.modelContext) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${outcome.modelContext}`,
      };
    },
    async toolCall(event, context) {
      const outcome = await evaluate(options, "before-tool", event, context);
      return outcome.decision === "deny"
        ? { block: true, reason: outcome.reason }
        : undefined;
    },
    async toolResult(event, context) {
      await evaluate(options, "after-tool", event, context);
    },
    async agentSettled(event, context) {
      await evaluate(options, "stop", event, context);
    },
  };
  return Object.freeze(handlers);
}
