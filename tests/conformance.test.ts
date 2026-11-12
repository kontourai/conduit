import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { describe, it } from "node:test";
import {
  type AgentHostAdapter, type ManifestHarnessOptions, type PortableAsset,
  bindAdapterLifecycle, claudeCodeCapabilities, codexCapabilities, createClaudeCodeAdapter, createCodexAdapter,
  createConformanceReport, createInProcessHostAdapter, createManifestHarnessAdapter,
  deriveConformanceLimitations,
  normalizeCapabilities, parseConformanceReport,
  createOpenCodeAdapter, createStrandsAdapter, createVoltAgentAdapter, openCodeCapabilities,
  probeHostConformance, renderConformanceMatrix, serializeConformanceReport,
  inertInstallLimitation, InvalidConformanceReportError, strandsCapabilities, UnsafeConformanceProbeError, UnsupportedConformanceSchemaVersionError, voltAgentCapabilities, type EvidenceInput, type HostCapabilities,
} from "../src/index.js";

const all = <T>(value: T) => ({ skill: value, agent: value, hook: value, prompt: value, command: value, context: value });
const lifecycle = <T>(value: T) => ({ "session-start": value, "before-model": value, "before-tool": value, "after-tool": value, stop: value });
const native: HostCapabilities = { lifecycle: lifecycle("native"), contextInjection: "native", blocking: "native", install: all("native") };

describe("Conduit host conformance", () => {
  it("proves a filesystem-style harness adapter without writing through its binding", async () => {
    const writes = new Map<string, string>();
    const adapter = createManifestHarnessAdapter({ id: "fixture-harness", capabilities: native, resolveTarget: a => `/fixture/${a.kind}/${a.id}`, write: (p, c) => { writes.set(p, c); } });
    assert.ok((await probeHostConformance(adapter)).every(result => result.status === "pass"));
    assert.equal(writes.size, 0);
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
  it("keeps committed limitation prose consistent with each row's declared tool blocking", () => {
    // Compiled to dist/tests, so the published evidence sits two levels up.
    const report = parseConformanceReport(readFileSync(new URL("../../conformance/host-conformance.json", import.meta.url), "utf8"));
    const codex = report.adapters.find(row => row.adapterId === "codex");
    assert.deepEqual(codex?.capabilities.influence["before-tool"], normalizeCapabilities(codexCapabilities).influence["before-tool"]);
    const deniesBlocking = /no\b.*\btool[- ]blocking|cannot block|does not (claim|support) .*block/i;
    for (const row of report.adapters) {
      const decision = row.capabilities.influence["before-tool"].decision;
      if (decision !== "native" && decision !== "approximated") continue;
      const contradictions = row.limitations.filter(limitation => deniesBlocking.test(limitation));
      assert.deepEqual(contradictions, [], `${row.adapterId} declares before-tool decision=${decision}`);
    }
  });
  it("drops modelContext from a downgraded Codex stop deny (#35)", async () => {
    const adapter = createCodexAdapter({ resolveTarget: () => undefined, write: () => {} });
    const projected = await adapter.project(
      { phase: "stop", sessionId: "fixture" },
      { decision: "deny", reason: "r", modelContext: "ctx" },
    );
    assert.equal(projected.decision, "observe");
    assert.equal(projected.reason, "r");
    assert.equal(projected.modelContext, undefined);
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
      "probe.install-io=not-exercised",
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
      "probe.decision-context-after-tool=fail",
      "probe.decision-context-before-model=fail",
      "probe.decision-context-before-tool=fail",
      "probe.decision-context-session-start=fail",
      "probe.decision-context-stop=fail",
      "probe.decision-session-start=fail",
      "probe.decision-stop=fail",
      "probe.install-io=not-exercised",
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
  it("disposes lifecycle registrations once, in reverse order, however often dispose is called", () => {
    const disposed: string[] = [];
    const dispose = bindAdapterLifecycle({
      adapter: createStrandsAdapter({ applyOutcome: (_event, outcome) => outcome }),
      registrar: { register: phase => () => { disposed.push(phase); } },
      evaluate: () => ({ decision: "allow" }),
    });
    const reversed = ["stop", "after-tool", "before-tool", "before-model", "session-start"];
    dispose();
    assert.deepEqual(disposed, reversed);
    dispose();
    dispose();
    assert.deepEqual(disposed, reversed);
  });
});

/** Bind the shipped Claude Code adapter to a real directory the way an application would. */
const claudeHomeBinding = (home: string) => ({
  resolveTarget: (asset: PortableAsset) => {
    if (asset.kind === "hook") return join(home, "settings.json");
    if (asset.kind === "context") return join(home, "CLAUDE.md");
    return join(home, `${asset.kind}s`, `${asset.id}.md`);
  },
  write: (target: string, content: string) => {
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  },
});

/** Every file under `root`, keyed by relative path, as raw bytes. */
const snapshot = (root: string): Map<string, Buffer> => new Map(
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(root.length), readFileSync(path)] as const;
    }),
);

const seedUserHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "conduit-probe-home-"));
  writeFileSync(join(home, "settings.json"), '{"permissions":{"allow":["Bash(git status)"]}}\n');
  writeFileSync(join(home, "CLAUDE.md"), "# User instructions\n\nKeep this file.\n");
  return home;
};

describe("Conformance probe host safety", () => {
  it("leaves a real Claude Code home byte-identical when a naive caller probes the bound adapter", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const adapter = createClaudeCodeAdapter(claudeHomeBinding(home));
      const results = await probeHostConformance(adapter);
      assert.ok(results.every(result => result.status === "pass"));
      await createConformanceReport([{ adapter, evidenceScope: "adapter-contract", adapterVersion: "1", hostId: "unbound", hostVersion: "unbound" }]);
      assert.deepEqual(snapshot(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses an adapter it cannot install through safely, before any write", async () => {
    const writes: string[] = [];
    const custom: AgentHostAdapter = {
      id: "custom-harness",
      capabilities: () => native,
      async install(assets) {
        for (const asset of assets) writes.push(asset.id);
        return { hostId: "custom-harness", installed: [], skipped: [] };
      },
      async project(_event, outcome) { return outcome; },
    };
    await assert.rejects(probeHostConformance(custom), (error: unknown) =>
      error instanceof UnsafeConformanceProbeError && error.code === "UNSAFE_CONFORMANCE_PROBE" && error.reason === "no-inert-install");
    await assert.rejects(createConformanceReport([{ adapter: custom, evidenceScope: "adapter-contract", adapterVersion: "1", hostId: "unbound", hostVersion: "unbound" }]), UnsafeConformanceProbeError);
    // Spreading a factory adapter yields a new object the probe cannot vouch for.
    await assert.rejects(probeHostConformance({ ...createClaudeCodeAdapter(claudeHomeBinding("/unused")) }), UnsafeConformanceProbeError);
    assert.deepEqual(writes, []);
  });

  /** A sandbox factory that records each root it is given, and the root's state at that moment. */
  const recordingFactory = (bind: (root: string) => AgentHostAdapter = root => createClaudeCodeAdapter(claudeHomeBinding(root))) => {
    const roots: { root: string; entries: string[]; mode: number }[] = [];
    const factory = (root: string) => {
      roots.push({ root, entries: readdirSync(root), mode: statSync(root).mode & 0o777 });
      return bind(root);
    };
    return { factory, roots };
  };
  const refused = (reason: string) => (error: unknown) => error instanceof UnsafeConformanceProbeError && error.reason === reason;

  it("installs through a sandbox built for a fresh private root, then removes the root", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const written: string[] = [];
      const { factory, roots } = recordingFactory(root => {
        const binding = claudeHomeBinding(root);
        return createClaudeCodeAdapter({ ...binding, write: (target, content) => { written.push(target); binding.write(target, content); } });
      });
      const results = await probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox: factory });
      assert.ok(results.every(result => result.status === "pass"));
      assert.equal(roots.length, 1);
      const [{ root, entries, mode }] = roots as [{ root: string; entries: string[]; mode: number }];
      assert.deepEqual(entries, []);
      assert.equal(mode, 0o700);
      assert.equal(written.length, 6);
      assert.ok(written.every(target => target.startsWith(`${root}/`)), written.join());
      assert.equal(existsSync(root), false);
      assert.deepEqual(snapshot(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses sandbox targets that are not normalized paths inside the root, before any write", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const escapes: ((root: string) => string)[] = [
        () => join(home, "CLAUDE.md"),
        root => `${root}/../CLAUDE.md`,
        root => `${root}/sub/../CLAUDE.md`,
        root => `${root}/./CLAUDE.md`,
        root => `${root}//CLAUDE.md`,
        root => relative(process.cwd(), join(root, "CLAUDE.md")),
        root => root,
      ];
      for (const escape of escapes) {
        const written: string[] = [];
        const { factory, roots } = recordingFactory(root => createClaudeCodeAdapter({
          resolveTarget: asset => asset.kind === "context" ? escape(root) : claudeHomeBinding(root).resolveTarget(asset),
          write: target => { written.push(target); },
        }));
        await assert.rejects(probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox: factory }), refused("sandbox-target-outside-root"));
        assert.deepEqual(written, []);
        assert.equal(existsSync(roots[0]?.root ?? ""), false);
      }
      assert.deepEqual(snapshot(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink planted in the root after the factory ran", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      // Planted during the first write: a directory link on a later target's
      // path, and a dangling link at a later target itself.
      const plants: ((root: string) => void)[] = [
        root => symlinkSync(home, join(root, "prompts")),
        root => symlinkSync(join(home, "planted.md"), join(root, "CLAUDE.md")),
        root => { mkdirSync(join(root, "commands")); symlinkSync(join(home, "missing"), join(root, "commands", "conformance-command.md")); },
      ];
      for (const plant of plants) {
        const { factory, roots } = recordingFactory(root => {
          const binding = claudeHomeBinding(root);
          let planted = false;
          return createClaudeCodeAdapter({ ...binding, write: (target, content) => {
            if (!planted) { planted = true; plant(root); }
            binding.write(target, content);
          } });
        });
        await assert.rejects(probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox: factory }), refused("sandbox-target-outside-root"));
        assert.equal(existsSync(roots[0]?.root ?? ""), false);
      }
      assert.deepEqual(snapshot(home), before);
      assert.deepEqual(readdirSync(home).sort(), ["CLAUDE.md", "settings.json"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a root the factory did not leave empty, before any write", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const written: string[] = [];
      const { factory, roots } = recordingFactory(root => {
        // A hard link to a real file at a probe target would otherwise be written through.
        linkSync(join(home, "CLAUDE.md"), join(root, "CLAUDE.md"));
        return createClaudeCodeAdapter({ ...claudeHomeBinding(root), write: (target, content) => { written.push(target); claudeHomeBinding(root).write(target, content); } });
      });
      await assert.rejects(probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox: factory }), refused("sandbox-root-not-empty"));
      assert.deepEqual(written, []);
      assert.equal(existsSync(roots[0]?.root ?? ""), false);
      assert.deepEqual(snapshot(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to write through a hard link planted in the root after the factory ran", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const { factory, roots } = recordingFactory(root => {
        const binding = claudeHomeBinding(root);
        let planted = false;
        return createClaudeCodeAdapter({ ...binding, write: (target, content) => {
          if (!planted) { planted = true; linkSync(join(home, "CLAUDE.md"), join(root, "CLAUDE.md")); }
          binding.write(target, content);
        } });
      });
      await assert.rejects(probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox: factory }), refused("sandbox-target-outside-root"));
      assert.equal(existsSync(roots[0]?.root ?? ""), false);
      assert.deepEqual(snapshot(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects after installing a symlink left in the root or a target that was never written", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "conduit-probe-elsewhere-"));
    try {
      const writes: ((root: string) => ManifestHarnessOptions["write"])[] = [
        root => (target, content) => { claudeHomeBinding(root).write(target, content); if (target.endsWith("CLAUDE.md")) symlinkSync(elsewhere, join(root, "extra")); },
        () => (target, content) => { writeFileSync(join(elsewhere, basename(target)), content); },
        // Links its own target to an outside file after the pre-write check, then writes through it.
        root => (target, content) => {
          if (target.endsWith("CLAUDE.md")) { writeFileSync(join(elsewhere, "linked-target.md"), "outside\n"); linkSync(join(elsewhere, "linked-target.md"), target); }
          claudeHomeBinding(root).write(target, content);
        },
        // Leaves a non-target file in the root that shares its content with an outside file.
        root => (target, content) => {
          claudeHomeBinding(root).write(target, content);
          if (target.endsWith("CLAUDE.md")) { writeFileSync(join(elsewhere, "linked-extra.md"), "outside\n"); linkSync(join(elsewhere, "linked-extra.md"), join(root, "extra.md")); }
        },
      ];
      for (const write of writes) {
        const { factory, roots } = recordingFactory(root => createClaudeCodeAdapter({ resolveTarget: claudeHomeBinding(root).resolveTarget, write: write(root) }));
        await assert.rejects(
          probeHostConformance(createClaudeCodeAdapter({ resolveTarget: asset => `/home/${asset.id}`, write: () => {} }), { installSandbox: factory }),
          refused("sandbox-write-unverified"),
        );
        assert.equal(existsSync(roots[0]?.root ?? ""), false);
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("resolves each sandbox target once and installs to exactly that target", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const calls = new Map<string, number>();
      const { factory } = recordingFactory(root => {
        const toRoot = claudeHomeBinding(root);
        const toHome = claudeHomeBinding(home);
        // Answers inside the root first and with the real home on every later call.
        return createClaudeCodeAdapter({
          resolveTarget: asset => {
            const count = (calls.get(asset.id) ?? 0) + 1;
            calls.set(asset.id, count);
            return count === 1 ? toRoot.resolveTarget(asset) : toHome.resolveTarget(asset);
          },
          write: toRoot.write,
        });
      });
      const results = await probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox: factory });
      assert.ok(results.every(result => result.status === "pass"));
      assert.deepEqual(snapshot(home), before);
      assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1, 1]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes the root and reports the cause when the sandbox resolver or write throws", async () => {
    const failure = new Error("resolver failed");
    const adapter = createClaudeCodeAdapter({ resolveTarget: asset => `/home/${asset.id}`, write: () => {} });
    const throwing = recordingFactory(() => createClaudeCodeAdapter({ resolveTarget: () => { throw failure; }, write: () => {} }));
    await assert.rejects(probeHostConformance(adapter, { installSandbox: throwing.factory }), (error: unknown) =>
      refused("target-resolution-failed")(error) && (error as Error).cause === failure);
    assert.equal(existsSync(throwing.roots[0]?.root ?? ""), false);
    const failingWrite = recordingFactory(root => createClaudeCodeAdapter({ resolveTarget: claudeHomeBinding(root).resolveTarget, write: () => { throw new Error("disk full"); } }));
    await assert.rejects(probeHostConformance(adapter, { installSandbox: failingWrite.factory }), /disk full/);
    assert.equal(existsSync(failingWrite.roots[0]?.root ?? ""), false);
  });

  it("refuses a factory that returns the adapter itself or a different host", async () => {
    const binding = { resolveTarget: () => undefined, write: () => { throw new Error("must not write"); } };
    const adapter = createClaudeCodeAdapter(binding);
    await assert.rejects(probeHostConformance(adapter, { installSandbox: () => adapter }), refused("sandbox-is-adapter"));
    await assert.rejects(probeHostConformance(adapter, { installSandbox: () => createCodexAdapter(binding) }), refused("sandbox-mismatch"));
    await assert.rejects(probeHostConformance(adapter, { installSandbox: () => createManifestHarnessAdapter({ id: "claude-code", capabilities: native, ...binding }) }), refused("sandbox-mismatch"));
  });

  it("never calls an in-process adapter's installAsset during the default probe", async () => {
    const registered: string[] = [];
    const installAsset = (asset: PortableAsset) => { registered.push(asset.id); };
    const applyOutcome = async (_event: unknown, outcome: { decision: "allow" | "deny" | "observe"; reason?: string; modelContext?: string }) => outcome;
    for (const adapter of [
      createStrandsAdapter({ installAsset, applyOutcome }),
      createInProcessHostAdapter({ id: "fixture-sdk", capabilities: native, installAsset, applyOutcome }),
    ]) {
      assert.ok((await probeHostConformance(adapter)).every(result => result.status === "pass"), adapter.id);
    }
    assert.deepEqual(registered, []);
    const sandboxed: string[] = [];
    const adapter = createStrandsAdapter({ installAsset, applyOutcome });
    assert.ok((await probeHostConformance(adapter, { installSandbox: () => createStrandsAdapter({ installAsset: asset => { sandboxed.push(asset.id); }, applyOutcome }) }))
      .every(result => result.status === "pass"));
    assert.deepEqual(registered, []);
    assert.equal(sandboxed.length, 6);
  });

  it("records whether install I/O ran, so an inert probe cannot hide a broken write", async () => {
    const adapter = createClaudeCodeAdapter({ resolveTarget: asset => `/fixture/${asset.kind}/${asset.id}`, write: () => { throw new Error("disk full"); } });
    await assert.rejects(adapter.install([{ id: "a", kind: "skill", content: "x" }]), /disk full/);
    const inert = await createConformanceReport([{ adapter, evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture", hostVersion: "1" }]);
    assert.equal(inert.adapters[0]?.installEvidence, "inert");
    assert.ok(inert.adapters[0]?.limitations.includes(inertInstallLimitation));
    assert.equal(inertInstallLimitation, "probe.install-io=not-exercised");
    const sandboxed = await createConformanceReport([{
      adapter,
      installSandbox: root => createClaudeCodeAdapter(claudeHomeBinding(root)),
      evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture", hostVersion: "1",
      limitations: [inertInstallLimitation, "kept"],
    }]);
    assert.equal(sandboxed.adapters[0]?.installEvidence, "sandbox");
    assert.ok(!sandboxed.adapters[0]?.limitations.includes(inertInstallLimitation));
    assert.ok(sandboxed.adapters[0]?.limitations.includes("kept"));
  });

  it("keeps the published schema in step with every emitted report field", () => {
    const schema = JSON.parse(readFileSync(new URL("../../schemas/host-conformance.schema.json", import.meta.url), "utf8"));
    const committed = parseConformanceReport(readFileSync(new URL("../../conformance/host-conformance.json", import.meta.url), "utf8"));
    const allowed = Object.keys(schema.$defs.adapter.properties);
    assert.equal(committed.schemaVersion, "3");
    if (committed.schemaVersion !== "3") return;
    assert.ok(committed.adapters.length > 0);
    for (const entry of committed.adapters) {
      for (const key of Object.keys(entry)) assert.ok(allowed.includes(key), key);
      assert.ok(schema.$defs.adapter.properties.installEvidence.enum.includes(entry.installEvidence), entry.adapterId);
    }
  });

  it("parses version 3 and version 2 reports and rejects an invalid installEvidence", () => {
    const entry = (extra: object) => JSON.stringify({ evidenceScope: "adapter-contract", adapterId: "x", ...extra });
    const report = (version: string, extra: object) => `{"schemaVersion":"${version}","adapters":[${entry(extra)}]}`;
    assert.equal(parseConformanceReport(report("3", { installEvidence: "inert" })).schemaVersion, "3");
    assert.equal(parseConformanceReport(report("3", { installEvidence: "sandbox" })).schemaVersion, "3");
    assert.equal(parseConformanceReport(report("2", {})).schemaVersion, "2");
    // A parsed version 2 report serializes and renders without conversion.
    const v2 = parseConformanceReport(report("2", {}));
    assert.deepEqual(JSON.parse(serializeConformanceReport(v2)), JSON.parse(report("2", {})));
    for (const invalid of [report("3", {}), report("3", { installEvidence: "host" }), report("2", { installEvidence: "inert" }), '{"schemaVersion":"3"}']) {
      assert.throws(() => parseConformanceReport(invalid), (error: unknown) =>
        error instanceof InvalidConformanceReportError && error.code === "INVALID_CONFORMANCE_REPORT", invalid);
    }
    assert.throws(() => parseConformanceReport('{"schemaVersion":"4","adapters":[]}'), UnsupportedConformanceSchemaVersionError);
  });
});
