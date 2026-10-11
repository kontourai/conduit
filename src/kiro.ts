import {
  createManifestHarnessAdapter,
  type AgentHostAdapter,
  type HostCapabilities,
  type LifecycleEvent,
  type LifecycleOutcome,
  type LocalHarnessBinding,
} from "./index.js";

const lifecycle = Object.freeze({
  "session-start": "native",
  "before-model": "native",
  "before-tool": "native",
  "after-tool": "native",
  stop: "native",
} as const);

/**
 * Kiro CLI 2.13+ custom-agent fidelity. The profile targets CLI hooks, not
 * standalone IDE hook files.
 */
export const kiroCapabilities: HostCapabilities = Object.freeze({
  lifecycle,
  influence: Object.freeze({
    "session-start": Object.freeze({ decision: "unavailable", contextInjection: "native" }),
    "before-model": Object.freeze({ decision: "unavailable", contextInjection: "native" }),
    "before-tool": Object.freeze({ decision: "native", contextInjection: "unavailable" }),
    "after-tool": Object.freeze({ decision: "unavailable", contextInjection: "unavailable" }),
    stop: Object.freeze({ decision: "native", contextInjection: "unavailable" }),
  }),
  contextInjection: "native",
  blocking: "native",
  install: Object.freeze({
    skill: "native",
    agent: "native",
    hook: "native",
    prompt: "native",
    command: "unavailable",
    context: "static-only",
  }),
});

/** Filesystem installation stays caller-bound; Conduit never guesses Kiro paths. */
export const createKiroAdapter = (
  binding: LocalHarnessBinding,
): AgentHostAdapter =>
  createManifestHarnessAdapter({
    id: "kiro",
    capabilities: kiroCapabilities,
    ...binding,
  });

export type KiroHookEventName =
  | "agentSpawn"
  | "userPromptSubmit"
  | "preToolUse"
  | "postToolUse"
  | "stop";

export interface KiroHookEvent {
  hook_event_name: KiroHookEventName;
  cwd: string;
  session_id: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  assistant_response?: string;
}

export interface KiroHookResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface KiroHookBindingOptions {
  adapter: AgentHostAdapter;
  evaluate(event: LifecycleEvent): LifecycleOutcome | Promise<LifecycleOutcome>;
}

const phaseByHook = Object.freeze({
  agentSpawn: "session-start",
  userPromptSubmit: "before-model",
  preToolUse: "before-tool",
  postToolUse: "after-tool",
  stop: "stop",
} as const);

/**
 * Raised for a decoded hook event whose `hook_event_name` Conduit does not map
 * to a lifecycle phase. Refusing up front keeps an unclassified host event from
 * reaching the application evaluator or being silently allowed.
 */
export class UnsupportedKiroHookEventError extends Error {
  readonly code = "UNSUPPORTED_KIRO_HOOK_EVENT";
  constructor(readonly hookEventName: unknown) {
    super(
      `Unsupported Kiro hook event: ${JSON.stringify(hookEventName) ?? String(hookEventName)}. ` +
        `Expected one of ${Object.keys(phaseByHook).join(", ")}.`,
    );
    this.name = "UnsupportedKiroHookEventError";
  }
}

const projectEvent = (event: KiroHookEvent): LifecycleEvent => {
  // Own-key check: inherited names such as `constructor` are not hook events.
  if (!Object.hasOwn(phaseByHook, event.hook_event_name)) {
    throw new UnsupportedKiroHookEventError(event.hook_event_name);
  }
  return {
    phase: phaseByHook[event.hook_event_name],
    sessionId: event.session_id,
    context: Object.freeze({ hostEvent: event }),
  };
};

/**
 * Evaluate one decoded Kiro CLI hook event.
 *
 * The caller owns process I/O: decode Kiro's JSON stdin, write the returned
 * streams exactly, and exit with `exitCode`. This keeps Conduit embeddable and
 * makes the hook protocol directly testable.
 *
 * Rejects with {@link UnsupportedKiroHookEventError}, before `evaluate` runs,
 * when `hook_event_name` is not one of the five mapped Kiro CLI hooks.
 */
export async function evaluateKiroHook(
  options: KiroHookBindingOptions,
  event: KiroHookEvent,
): Promise<KiroHookResult> {
  const projectedEvent = projectEvent(event);
  const outcome = await options.adapter.project(
    projectedEvent,
    await options.evaluate(projectedEvent),
  );

  if (event.hook_event_name === "preToolUse" && outcome.decision === "deny") {
    return Object.freeze({
      exitCode: 2,
      stderr: outcome.reason ?? "Tool use denied",
    });
  }
  if (event.hook_event_name === "stop" && outcome.decision === "deny") {
    return Object.freeze({
      exitCode: 0,
      stdout: JSON.stringify({
        decision: "block",
        reason: outcome.reason ?? "Completion denied",
      }),
    });
  }
  if (
    (event.hook_event_name === "agentSpawn" ||
      event.hook_event_name === "userPromptSubmit") &&
    outcome.modelContext
  ) {
    return Object.freeze({ exitCode: 0, stdout: outcome.modelContext });
  }
  return Object.freeze({ exitCode: 0 });
}
