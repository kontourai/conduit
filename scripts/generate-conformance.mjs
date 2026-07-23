import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createConformanceReport,
  createOpenCodeAdapter,
  createStrandsAdapter,
  createVoltAgentAdapter,
  renderConformanceMatrix,
  serializeConformanceReport,
} from "../dist/src/index.js";

const check = process.argv.includes("--check");
const packageManifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const adapterVersion = packageManifest.version;
const target = asset => `/conformance/${asset.kind}/${asset.id}`;
const write = () => {};
const applyOutcome = (_event, outcome) => outcome;
const installAsset = () => {};

const inputs = [
  { adapter: createClaudeCodeAdapter({ resolveTarget: target, write }), adapterVersion, hostVersion: "public-hooks", limitations: ["before-model is projected through prompt submission hooks", "context assets are static instructions"] },
  { adapter: createCodexAdapter({ resolveTarget: target, write }), adapterVersion, hostVersion: "public-config", limitations: ["no public synchronous tool-blocking hook", "lifecycle observation requires host-owned notification binding"] },
  { adapter: createOpenCodeAdapter({ resolveTarget: target, write }), adapterVersion, hostVersion: "public-plugin-api", limitations: ["stop is derived from session lifecycle events"] },
  { adapter: createStrandsAdapter({ applyOutcome, installAsset }), adapterVersion, hostVersion: "caller-bound", limitations: ["framework objects and hook registration are supplied by the caller"] },
  { adapter: createVoltAgentAdapter({ applyOutcome, installAsset }), adapterVersion, hostVersion: "caller-bound", limitations: ["framework objects and hook registration are supplied by the caller"] },
];

const report = await createConformanceReport(inputs);
const outputs = new Map([
  [resolve("conformance/host-conformance.json"), serializeConformanceReport(report)],
  [resolve("docs/host-conformance.md"), renderConformanceMatrix(report)],
]);

for (const [path, content] of outputs) {
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== content) {
      process.stderr.write(`${path} is stale; run npm run conformance:generate\n`);
      process.exitCode = 1;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
