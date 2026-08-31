import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const license = readFileSync("LICENSE", "utf8");
if (packageJson.license !== "PolyForm-Noncommercial-1.0.0") {
  fail("package.json license metadata is incorrect.");
}
if (!license.includes("PolyForm Noncommercial License 1.0.0")) {
  fail("LICENSE is missing the standard PolyForm Noncommercial text.");
}
if (!license.includes("Copyright 2026 zengxuanliu2005")) {
  fail("LICENSE is missing the required copyright notice.");
}

const insideGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  encoding: "utf8",
});
if (insideGit.status === 0) {
  const staged = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
    encoding: "utf8",
  });
  const names = staged.stdout.split("\0").filter(Boolean);
  const forbidden = names.filter((name) =>
    /^(?:\.local\/|node_modules\/|dist\/|coverage\/|output\/|\.playwright-cli\/)|(?:^|\/)\.env(?:\.|$)|\.log$/i.test(
      name,
    ),
  );
  if (forbidden.length) fail(`Forbidden staged files: ${forbidden.join(", ")}`);

  const diff = spawnSync("git", ["diff", "--cached", "--no-ext-diff", "-U0"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }).stdout;
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[opsu]_[A-Za-z0-9]{30,}\b/.test(
      diff,
    )
  ) {
    fail("A likely secret was found in the staged diff.");
  }
  const whitespace = spawnSync("git", ["diff", "--check"], {
    encoding: "utf8",
  });
  if (whitespace.status !== 0) fail(whitespace.stdout || whitespace.stderr);
}

if (!process.exitCode) process.stdout.write("Release audit passed.\n");
