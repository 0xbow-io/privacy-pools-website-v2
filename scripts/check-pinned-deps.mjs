#!/usr/bin/env bun
// Fail the build if any dependency in package.json has a non-pinned
// version range. Pairs with bunfig.toml's minimumReleaseAge — the
// release-age gate only fires when bun needs to *resolve* a version,
// which won't happen if package.json declares ranges that the existing
// lockfile already satisfies. Pinning at package.json + lockfile makes
// the gate engage on every drift attempt.
//
// Allowed:
//   - Strict semver: "1.2.3", "1.2.3-rc.4", "1.2.3+build"
//   - file: / link: protocol specifiers ("file:./vendor/foo.tgz")
//
// Rejected:
//   - "^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "*", "latest", "next", ""
//   - git/github/npm aliases — we want artifacts pinned to a tarball,
//     not floating refs

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isAllowed(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("file:") || value.startsWith("link:")) return true;
  return SEMVER_RE.test(value);
}

const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const violations = [];
for (const section of sections) {
  const entries = pkg[section];
  if (!entries) continue;
  for (const [name, version] of Object.entries(entries)) {
    if (!isAllowed(version)) {
      violations.push({ section, name, version });
    }
  }
}

if (violations.length > 0) {
  console.error("[check-pinned-deps] Non-pinned dependency versions detected:");
  for (const v of violations) {
    console.error(`  ${v.section}.${v.name} = ${JSON.stringify(v.version)}`);
  }
  console.error("");
  console.error("Pin every dependency to an exact semver (e.g. \"1.2.3\") or to a file:/link: artifact.");
  console.error("Combined with bunfig.toml minimumReleaseAge, this blocks supply-chain attacks via");
  console.error("npm versions younger than 72h getting silently picked up by a range resolution.");
  process.exit(1);
}

const sdkViolations = checkPrivacyPoolsSdkInstall();
if (sdkViolations.length > 0) {
  console.error("[check-pinned-deps] SDK install drift detected:");
  for (const message of sdkViolations) {
    console.error(`  ${message}`);
  }
  console.error("");
  console.error("Run bun install so node_modules matches package.json before starting or building.");
  process.exit(1);
}

console.log(`[check-pinned-deps] OK — ${Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length} deps all pinned.`);

function checkPrivacyPoolsSdkInstall() {
  const sdkName = "@privacy-pools-v2/sdk";
  const spec = pkg.dependencies?.[sdkName];
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    return [];
  }

  const tarballPath = resolve(root, spec.slice("file:".length));
  const expectedVersion = extractVendoredSdkVersion(tarballPath);
  const messages = [];

  if (!existsSync(tarballPath)) {
    messages.push(`${sdkName} points at missing artifact ${spec}`);
  }

  if (!expectedVersion) {
    messages.push(`${sdkName} file dependency does not include a parseable SDK version: ${spec}`);
    return messages;
  }

  const installedPkgPath = resolve(root, "node_modules", "@privacy-pools-v2", "sdk", "package.json");
  if (!existsSync(installedPkgPath)) {
    messages.push(`${sdkName} is not installed in node_modules`);
    return messages;
  }

  const installedPkg = JSON.parse(readFileSync(installedPkgPath, "utf8"));
  if (installedPkg.version !== expectedVersion) {
    messages.push(
      `${sdkName} installed version ${JSON.stringify(installedPkg.version)} does not match package.json artifact ${JSON.stringify(expectedVersion)}`,
    );
  }

  return messages;
}

function extractVendoredSdkVersion(tarballPath) {
  const match = tarballPath.match(/privacy-pools-v2-sdk-(.+)\.tgz$/);
  return match?.[1] ?? null;
}
