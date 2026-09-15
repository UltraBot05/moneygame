#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslintApi = fileURLToPath(import.meta.resolve("eslint"));
const eslintCli = path.resolve(path.dirname(eslintApi), "..", "bin", "eslint.js");

const layers = [
  {
    name: "game-core",
    root: path.join(repoRoot, "packages", "game-core"),
    packageName: "@moneygame/game-core",
    forbidden: new Set(["worker", "web"]),
  },
  {
    name: "shared",
    root: path.join(repoRoot, "packages", "shared"),
    packageName: "@moneygame/shared",
    forbidden: new Set(["worker", "web"]),
  },
  {
    name: "web",
    root: path.join(repoRoot, "app", "web"),
    packageName: "@moneygame/web",
    forbidden: new Set(["worker"]),
  },
  {
    name: "worker",
    root: path.join(repoRoot, "app", "worker"),
    packageName: "@moneygame/worker",
    forbidden: new Set(["web"]),
  },
];

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function layerForPath(filename) {
  const resolved = path.resolve(filename);
  return layers.find((layer) => isInside(resolved, layer.root));
}

function layerForPackage(specifier) {
  return layers.find((layer) =>
    specifier === layer.packageName || specifier.startsWith(layer.packageName + "/")
  );
}

function boundaryViolation(importerFilename, specifier) {
  const importer = path.resolve(repoRoot, importerFilename);
  const source = layerForPath(importer);
  if (source === undefined) return null;

  const target = specifier.startsWith(".")
    ? layerForPath(path.resolve(path.dirname(importer), specifier))
    : layerForPackage(specifier);

  if (target === undefined || !source.forbidden.has(target.name)) return null;
  return source.name + " must not import " + target.name;
}

function localImportResolves(filename, specifier) {
  const target = path.resolve(path.dirname(filename), specifier);
  if (existsSync(target) && statSync(target).isFile()) return true;
  return ts.resolveModuleName(
    specifier,
    filename,
    {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true,
      allowJs: true,
      allowImportingTsExtensions: true,
    },
    ts.sys,
  ).resolvedModule !== undefined;
}

// Application source uses ES modules; CommonJS require() is not a supported import style.
function importedSpecifiers(filename, source) {
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (ast.parseDiagnostics.length > 0) {
    const diagnostic = ast.parseDiagnostics[0];
    throw new Error(
      "TypeScript parse failed: "
      + ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    );
  }

  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error("non-literal import/export source");
      }
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        throw new Error("dynamic import must use a literal source");
      }
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
    ) {
      throw new Error("CommonJS require() is not supported in application source");
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      throw new Error("CommonJS import-equals is not supported in application source");
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (!ts.isLiteralTypeNode(argument) || !ts.isStringLiteral(argument.literal)) {
        throw new Error("import type query must use a literal source");
      }
      specifiers.push(argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return specifiers;
}

function runEslintProbe(filename, code) {
  const result = spawnSync(
    process.execPath,
    [eslintCli, "--stdin", "--stdin-filename", filename, "--format", "json"],
    {
      cwd: repoRoot,
      input: code + "\n",
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.error !== undefined) {
    return { problem: "ESLint failed to start: " + result.error.message };
  }
  if (result.status !== 0 && result.status !== 1) {
    return {
      problem:
        "ESLint exited " + String(result.status) + ": "
        + (result.stderr.trim() || result.stdout.trim() || "no diagnostic output"),
    };
  }

  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    return { problem: "ESLint output was not parseable JSON" };
  }
  if (!Array.isArray(reports)) return { problem: "ESLint JSON was not an array" };

  const messages = reports.flatMap((report) =>
    Array.isArray(report.messages) ? report.messages : []
  );
  return { status: result.status, messages };
}

function validateLintProbe(result, shouldBlock, requireEslintBoundary) {
  if ("problem" in result) return result.problem;

  const boundaryMessages = result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
  const unexpectedMessages = result.messages.filter(
    (message) => message.ruleId !== "no-restricted-imports",
  );
  if (unexpectedMessages.length > 0) {
    const first = unexpectedMessages[0];
    return "unexpected ESLint diagnostic "
      + String(first?.ruleId ?? "fatal")
      + ": "
      + String(first?.message ?? "unknown error");
  }

  if (!shouldBlock) {
    if (result.status !== 0 || result.messages.length !== 0) {
      return "allowed probe did not exit cleanly";
    }
    return null;
  }

  if (result.status === 1 && boundaryMessages.length === 0) {
    return "ESLint failed without the expected boundary diagnostic";
  }
  if (result.status === 0 && boundaryMessages.length > 0) {
    return "ESLint reported a boundary diagnostic with a successful exit";
  }
  if (requireEslintBoundary && boundaryMessages.length === 0) {
    return "package import did not trigger no-restricted-imports";
  }
  return null;
}

const BLOCKED = true;
const ALLOWED = false;

const probes = [
  {
    filename: "packages/game-core/src/probe.ts",
    specifier: "@moneygame/worker",
    blocked: BLOCKED,
    eslintBoundary: true,
    description: "game-core -> worker package",
  },
  {
    filename: "app/web/src/probe.ts",
    specifier: "@moneygame/worker",
    blocked: BLOCKED,
    eslintBoundary: true,
    description: "web -> worker package",
  },
  {
    filename: "app/worker/src/probe.ts",
    specifier: "@moneygame/web",
    blocked: BLOCKED,
    eslintBoundary: true,
    description: "worker -> web package",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "@moneygame/worker",
    blocked: BLOCKED,
    eslintBoundary: true,
    description: "shared -> worker package",
  },
  {
    filename: "packages/game-core/src/probe.ts",
    specifier: "@moneygame/worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: true,
    description: "game-core -> worker package subpath",
  },
  {
    filename: "app/worker/src/probe.ts",
    specifier: "@moneygame/web/src/App",
    blocked: BLOCKED,
    eslintBoundary: true,
    description: "worker -> web package subpath",
  },
  {
    filename: "packages/game-core/src/probe.ts",
    specifier: "../../../app/worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "game-core -> worker ordinary relative",
  },
  {
    filename: "packages/game-core/src/probe.ts",
    specifier: "./../../../app/worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "game-core -> worker leading-dot relative",
  },
  {
    filename: "packages/game-core/src/probe.ts",
    specifier: "././../../../app/worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "game-core -> worker repeated-dot relative",
  },
  {
    filename: "app/web/src/probe.ts",
    specifier: "../../worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "web -> worker ordinary relative",
  },
  {
    filename: "app/web/src/probe.ts",
    specifier: "./../../worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "web -> worker leading-dot relative",
  },
  {
    filename: "app/worker/src/probe.ts",
    specifier: "../../web/src/App",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "worker -> web ordinary relative",
  },
  {
    filename: "app/worker/src/probe.ts",
    specifier: "./../../web/src/App",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "worker -> web leading-dot relative",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "../../../app/worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker ordinary relative",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "./../../../app/worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker leading-dot relative",
  },
  {
    filename: "app/web/src/features/deep/probe.ts",
    specifier: "./../../../../worker/src/transition",
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "deep web -> worker normalized relative",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "@moneygame/game-core",
    blocked: ALLOWED,
    eslintBoundary: false,
    description: "shared -> game-core package allowed",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "../../game-core/src/index",
    blocked: ALLOWED,
    eslintBoundary: false,
    description: "shared -> game-core relative allowed",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "././../../../app/worker/src/transition",
    code: 'import /* comment */ "././../../../app/worker/src/transition";',
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker exact comment-separated bypass",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "./../../../app/worker/src/transition",
    code: 'import {\n  example\n} from\n  "./../../../app/worker/src/transition";\nvoid example;',
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker multiline declaration",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "../../../app/worker/src/transition",
    code: 'import type { Example } from "../../../app/worker/src/transition";\nexport type Probe = Example;',
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker import type",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "../../../app/worker/src/transition",
    code: 'export { example } from "../../../app/worker/src/transition";',
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker export-from",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "../../../app/worker/src/transition",
    code: 'void import("../../../app/worker/src/transition");',
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker dynamic import",
  },
  {
    filename: "packages/shared/src/probe.ts",
    specifier: "../../../app/worker/src/transition",
    code: 'export type Probe = import("../../../app/worker/src/transition").Example;',
    blocked: BLOCKED,
    eslintBoundary: false,
    description: "shared -> worker import type query",
  },
];

let failures = 0;

for (const probe of probes) {
  const code = probe.code ?? 'import "' + probe.specifier + '";';
  let parsedSpecifiers;
  try {
    parsedSpecifiers = importedSpecifiers(probe.filename, code);
  } catch (error) {
    console.log("FAIL: " + probe.description + " - " + error.message);
    failures += 1;
    continue;
  }
  const normalizedBlocked = parsedSpecifiers.some(
    (specifier) => boundaryViolation(probe.filename, specifier) !== null,
  );
  const lintResult = runEslintProbe(probe.filename, code);
  const lintProblem = validateLintProbe(
    lintResult,
    probe.blocked,
    probe.eslintBoundary,
  );

  if (
    parsedSpecifiers.length !== 1
    || parsedSpecifiers[0] !== probe.specifier
    || normalizedBlocked !== probe.blocked
  ) {
    console.log("FAIL: " + probe.description + " - normalized boundary result was wrong");
    failures += 1;
  } else if (lintProblem !== null) {
    console.log("FAIL: " + probe.description + " - " + lintProblem);
    failures += 1;
  } else {
    console.log("PASS: " + probe.description);
  }
}

for (const [description, code] of [
  ["malformed source is rejected", 'import /* unfinished'],
  ["non-literal dynamic import is rejected", 'void import(variable);'],
  ["unsupported CommonJS require is rejected", 'require("../../../app/worker/src/transition");'],
]) {
  try {
    importedSpecifiers("packages/shared/src/probe.ts", code);
    console.log("FAIL: " + description);
    failures += 1;
  } catch {
    console.log("PASS: " + description);
  }
}

if (
  localImportResolves(
    path.join(repoRoot, "packages", "shared", "src", "probe.ts"),
    "./missing-boundary-probe",
  )
) {
  console.log("FAIL: unresolved local import was accepted");
  failures += 1;
} else {
  console.log("PASS: unresolved local import is rejected");
}

const unrelatedLintResult = runEslintProbe(
  "packages/shared/src/probe.ts",
  "const unusedBoundaryProbe = 1;",
);
const unrelatedLintProblem = validateLintProbe(unrelatedLintResult, ALLOWED, false);
if (unrelatedLintProblem === null) {
  console.log("FAIL: unexpected ESLint failure was not rejected");
  failures += 1;
} else {
  console.log("PASS: unexpected ESLint failure is rejected");
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".wrangler") {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

let scannedFiles = 0;
for (const layer of layers) {
  for (const filename of sourceFiles(layer.root)) {
    scannedFiles += 1;
    const source = readFileSync(filename, "utf8");
    let specifiers;
    try {
      specifiers = importedSpecifiers(filename, source);
    } catch (error) {
      console.log("FAIL: " + path.relative(repoRoot, filename) + " - " + error.message);
      failures += 1;
      continue;
    }
    for (const specifier of specifiers) {
      const violation = boundaryViolation(path.relative(repoRoot, filename), specifier);
      if (violation !== null) {
        console.log(
          "FAIL: "
            + path.relative(repoRoot, filename)
            + " imports "
            + specifier
            + " - "
            + violation,
        );
        failures += 1;
      } else if (specifier.startsWith(".") && !localImportResolves(filename, specifier)) {
        console.log(
          "FAIL: "
            + path.relative(repoRoot, filename)
            + " has unresolved local import "
            + specifier,
        );
        failures += 1;
      }
    }
  }
}

if (failures > 0) {
  console.log("\n" + failures + " boundary check(s) failed");
  process.exit(1);
}

console.log(
  "\nAll "
    + probes.length
    + " boundary probes passed; fail-closed lint handling passed; scanned "
    + scannedFiles
    + " source files",
);
