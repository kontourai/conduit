import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import {
  type AgentHostAdapter, type PortableAsset,
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

  it("installs through an explicit sandbox binding and never through the adapter under test", async () => {
    const home = seedUserHome();
    const scratch = mkdtempSync(join(tmpdir(), "conduit-probe-scratch-"));
    try {
      const before = snapshot(home);
      const adapter = createClaudeCodeAdapter(claudeHomeBinding(home));
      const installSandbox = createClaudeCodeAdapter(claudeHomeBinding(scratch));
      const results = await probeHostConformance(adapter, { installSandbox });
      assert.ok(results.every(result => result.status === "pass"));
      assert.deepEqual(snapshot(home), before);
      assert.equal(readFileSync(join(scratch, "CLAUDE.md"), "utf8"), "conduit-private-context-content");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses a sandbox built on the same binding, leaving the real home byte-identical", async () => {
    const home = seedUserHome();
    try {
      const before = snapshot(home);
      const binding = claudeHomeBinding(home);
      const adapter = createClaudeCodeAdapter(binding);
      await assert.rejects(probeHostConformance(adapter, { installSandbox: createClaudeCodeAdapter(binding) }), (error: unknown) =>
        error instanceof UnsafeConformanceProbeError && error.reason === "sandbox-overlaps-adapter");
      // A fresh binding object over the same directory resolves the same targets.
      await assert.rejects(probeHostConformance(adapter, { installSandbox: createClaudeCodeAdapter(claudeHomeBinding(home)) }), (error: unknown) =>
        error instanceof UnsafeConformanceProbeError && error.reason === "sandbox-overlaps-adapter");
      assert.deepEqual(snapshot(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
    const adapter = createStrandsAdapter({ installAsset, applyOutcome });
    await assert.rejects(probeHostConformance(adapter, { installSandbox: createStrandsAdapter({ installAsset, applyOutcome }) }), (error: unknown) =>
      error instanceof UnsafeConformanceProbeError && error.reason === "sandbox-overlaps-adapter");
    const sandboxed: string[] = [];
    assert.ok((await probeHostConformance(adapter, { installSandbox: createStrandsAdapter({ installAsset: asset => { sandboxed.push(asset.id); }, applyOutcome }) }))
      .every(result => result.status === "pass"));
    assert.deepEqual(registered, []);
    assert.equal(sandboxed.length, 6);
  });

  it("records whether install I/O ran, so an inert probe cannot hide a broken write", async () => {
    const failingWrite = { resolveTarget: (asset: PortableAsset) => `/fixture/${asset.kind}/${asset.id}`, write: () => { throw new Error("disk full"); } };
    const adapter = createClaudeCodeAdapter(failingWrite);
    await assert.rejects(adapter.install([{ id: "a", kind: "skill", content: "x" }]), /disk full/);
    const inert = await createConformanceReport([{ adapter, evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture", hostVersion: "1" }]);
    assert.equal(inert.adapters[0]?.installEvidence, "inert");
    assert.ok(inert.adapters[0]?.limitations.includes(inertInstallLimitation));
    assert.equal(inertInstallLimitation, "probe.install-io=not-exercised");
    // Exercising the same broken I/O through a sandbox surfaces the failure.
    await assert.rejects(probeHostConformance(adapter, { installSandbox: createClaudeCodeAdapter({ ...failingWrite, resolveTarget: asset => `/scratch/${asset.kind}/${asset.id}` }) }), /disk full/);
    const sandbox = createClaudeCodeAdapter({ resolveTarget: asset => `/scratch/${asset.kind}/${asset.id}`, write: () => {} });
    const sandboxed = await createConformanceReport([{ adapter, installSandbox: sandbox, evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture", hostVersion: "1" }]);
    assert.equal(sandboxed.adapters[0]?.installEvidence, "sandbox");
    assert.ok(!sandboxed.adapters[0]?.limitations.includes(inertInstallLimitation));
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

  describe("refuses a sandbox that aliases the adapter's targets", () => {
    /** Probe a Claude home adapter with a sandbox whose context target is `aliasOf(home)`. */
    const probeWithAlias = async (aliasOf: (home: string) => string) => {
      const home = seedUserHome();
      const scratch = mkdtempSync(join(tmpdir(), "conduit-probe-scratch-"));
      try {
        const before = snapshot(home);
        const real = claudeHomeBinding(scratch);
        const installSandbox = createClaudeCodeAdapter({
          resolveTarget: asset => asset.kind === "context" ? aliasOf(home) : real.resolveTarget(asset),
          write: real.write,
        });
        const outcome = await probeHostConformance(createClaudeCodeAdapter(claudeHomeBinding(home)), { installSandbox })
          .then(() => "probed", (error: unknown) => error);
        return { outcome, unchanged: JSON.stringify([...snapshot(home)]) === JSON.stringify([...before]), home };
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
      }
    };
    const overlaps = (outcome: unknown) => outcome instanceof UnsafeConformanceProbeError && outcome.reason === "sandbox-overlaps-adapter";

    it("through a symlinked directory, including a target that does not exist yet", async () => {
      const links = mkdtempSync(join(tmpdir(), "conduit-probe-links-"));
      try {
        let n = 0;
        // The second target's `skills` directory does not exist, so only its
        // nearest existing ancestor can be resolved through the symlink.
        for (const target of ["CLAUDE.md", join("skills", "conformance-skill.md")]) {
          const result = await probeWithAlias(home => {
            const link = join(links, `home-${n++}`);
            symlinkSync(home, link);
            return join(link, target);
          });
          assert.ok(overlaps(result.outcome), String(result.outcome));
          assert.ok(result.unchanged);
        }
      } finally {
        rmSync(links, { recursive: true, force: true });
      }
    });

    it("through a relative path", async () => {
      const result = await probeWithAlias(home => relative(process.cwd(), join(home, "CLAUDE.md")));
      assert.ok(overlaps(result.outcome), String(result.outcome));
      assert.ok(result.unchanged);
    });

    it("through dot segments and duplicate separators", async () => {
      for (const alias of [(home: string) => `${home}/./CLAUDE.md`, (home: string) => `${home}//CLAUDE.md`]) {
        const result = await probeWithAlias(alias);
        assert.ok(overlaps(result.outcome), String(result.outcome));
        assert.ok(result.unchanged);
      }
    });

    it("through a case variant exactly when the filesystem folds case", async () => {
      // Detect the filesystem's behavior independently of the code under test.
      const detector = mkdtempSync(join(tmpdir(), "conduit-probe-case-"));
      writeFileSync(join(detector, "Probe"), "");
      let foldsCase = false;
      try { foldsCase = statSync(join(detector, "PROBE")).ino === statSync(join(detector, "Probe")).ino; } catch { foldsCase = false; }
      rmSync(detector, { recursive: true, force: true });
      // An existing file (realpath can report its stored case) and a target
      // under a directory that does not exist yet (only case-folding can match
      // it against the adapter's own `skills/conformance-skill.md`).
      for (const alias of [(home: string) => join(home, "claude.MD"), (home: string) => join(home, "SKILLS", "conformance-skill.md")]) {
        const result = await probeWithAlias(alias);
        if (foldsCase) {
          assert.ok(overlaps(result.outcome), String(result.outcome));
          assert.ok(result.unchanged);
        } else {
          // A distinct file on a case-sensitive filesystem is a legitimate sandbox target.
          assert.equal(result.outcome, "probed");
        }
      }
    });
  });

  it("resolves each sandbox target once and installs to exactly that target", async () => {
    const home = seedUserHome();
    const scratch = mkdtempSync(join(tmpdir(), "conduit-probe-scratch-"));
    try {
      const before = snapshot(home);
      const calls = new Map<string, number>();
      const toScratch = claudeHomeBinding(scratch);
      const toHome = claudeHomeBinding(home);
      // Answers with the scratch target first and the real home on every later call.
      const installSandbox = createClaudeCodeAdapter({
        resolveTarget: asset => {
          const count = (calls.get(asset.id) ?? 0) + 1;
          calls.set(asset.id, count);
          return count === 1 ? toScratch.resolveTarget(asset) : toHome.resolveTarget(asset);
        },
        write: toScratch.write,
      });
      const results = await probeHostConformance(createClaudeCodeAdapter(toHome), { installSandbox });
      assert.ok(results.every(result => result.status === "pass"));
      assert.deepEqual(snapshot(home), before);
      assert.equal(readFileSync(join(scratch, "CLAUDE.md"), "utf8"), "conduit-private-context-content");
      assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1, 1]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses with the cause when a resolver throws during the sandbox check, before any install", async () => {
    const written: string[] = [];
    const write = (target: string) => { written.push(target); };
    const failure = new Error("resolver failed");
    const adapter = createClaudeCodeAdapter({ resolveTarget: asset => `/home/${asset.id}`, write });
    for (const [subject, installSandbox] of [
      ["sandbox", createClaudeCodeAdapter({ resolveTarget: () => { throw failure; }, write })],
      ["adapter", createClaudeCodeAdapter({ resolveTarget: asset => `/scratch/${asset.id}`, write })],
    ] as const) {
      const probed = subject === "adapter"
        ? createClaudeCodeAdapter({ resolveTarget: () => { throw failure; }, write })
        : adapter;
      await assert.rejects(probeHostConformance(probed, { installSandbox }), (error: unknown) =>
        error instanceof UnsafeConformanceProbeError && error.reason === "target-resolution-failed" && error.cause === failure);
    }
    assert.deepEqual(written, []);
  });

  it("never lets a caller-supplied limitation contradict sandbox install evidence", async () => {
    const adapter = createClaudeCodeAdapter({ resolveTarget: asset => `/home/${asset.id}`, write: () => {} });
    const installSandbox = createClaudeCodeAdapter({ resolveTarget: asset => `/scratch/${asset.id}`, write: () => {} });
    const report = await createConformanceReport([{ adapter, installSandbox, evidenceScope: "host-bound", adapterVersion: "1", hostId: "fixture", hostVersion: "1", limitations: [inertInstallLimitation, "kept"] }]);
    assert.equal(report.adapters[0]?.installEvidence, "sandbox");
    assert.ok(!report.adapters[0]?.limitations.includes(inertInstallLimitation));
    assert.ok(report.adapters[0]?.limitations.includes("kept"));
  });

  it("parses version 3 and version 2 reports and rejects an invalid installEvidence", () => {
    const entry = (extra: object) => JSON.stringify({ evidenceScope: "adapter-contract", adapterId: "x", ...extra });
    const report = (version: string, extra: object) => `{"schemaVersion":"${version}","adapters":[${entry(extra)}]}`;
    assert.equal(parseConformanceReport(report("3", { installEvidence: "inert" })).schemaVersion, "3");
    assert.equal(parseConformanceReport(report("3", { installEvidence: "sandbox" })).schemaVersion, "3");
    assert.equal(parseConformanceReport(report("2", {})).schemaVersion, "2");
    for (const invalid of [report("3", {}), report("3", { installEvidence: "host" }), report("2", { installEvidence: "inert" }), '{"schemaVersion":"3"}']) {
      assert.throws(() => parseConformanceReport(invalid), (error: unknown) =>
        error instanceof InvalidConformanceReportError && error.code === "INVALID_CONFORMANCE_REPORT", invalid);
    }
    assert.throws(() => parseConformanceReport('{"schemaVersion":"4","adapters":[]}'), UnsupportedConformanceSchemaVersionError);
  });

  it("refuses a sandbox that is the adapter itself or describes a different host", async () => {
    const binding = { resolveTarget: () => undefined, write: () => { throw new Error("must not write"); } };
    const adapter = createClaudeCodeAdapter(binding);
    await assert.rejects(probeHostConformance(adapter, { installSandbox: adapter }), (error: unknown) =>
      error instanceof UnsafeConformanceProbeError && error.reason === "sandbox-is-adapter");
    await assert.rejects(probeHostConformance(adapter, { installSandbox: createCodexAdapter(binding) }), (error: unknown) =>
      error instanceof UnsafeConformanceProbeError && error.reason === "sandbox-mismatch");
    await assert.rejects(probeHostConformance(adapter, { installSandbox: createManifestHarnessAdapter({ id: "claude-code", capabilities: native, ...binding }) }), (error: unknown) =>
      error instanceof UnsafeConformanceProbeError && error.reason === "sandbox-mismatch");
  });
});
