#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";
if (!isMac) {
  // Audio ducker is macOS-only
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const swiftSource = path.join(projectRoot, "resources", "macos-audio-ducker.swift");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "macos-audio-ducker");
const moduleCacheDir = path.join(outputDir, ".swift-module-cache");

function log(message) {
  console.log(`[audio-ducker] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

if (!fs.existsSync(swiftSource)) {
  console.error(`[audio-ducker] Swift source not found at ${swiftSource}`);
  process.exit(1);
}

ensureDir(outputDir);
ensureDir(moduleCacheDir);

// Check if rebuild is needed
let needsBuild = true;
if (fs.existsSync(outputBinary)) {
  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(swiftSource);
    if (binaryStat.mtimeMs >= sourceStat.mtimeMs) {
      needsBuild = false;
    }
  } catch {
    needsBuild = true;
  }
}

if (!needsBuild) {
  process.exit(0);
}

function attemptCompile(command, args) {
  log(`Compiling with ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      SWIFT_MODULE_CACHE_PATH: moduleCacheDir,
    },
  });
}

// Compile with AVFAudio framework
const compileArgs = [
  swiftSource,
  "-O",
  "-framework",
  "AVFAudio",
  "-framework",
  "Foundation",
  "-module-cache-path",
  moduleCacheDir,
  "-o",
  outputBinary,
];

let result = attemptCompile("xcrun", ["swiftc", ...compileArgs]);

if (result.status !== 0) {
  result = attemptCompile("swiftc", compileArgs);
}

if (result.status !== 0) {
  console.error("[audio-ducker] Failed to compile macOS audio ducker binary.");
  process.exit(result.status ?? 1);
}

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[audio-ducker] Unable to set executable permissions: ${error.message}`);
}

log("Successfully built macOS audio ducker binary.");
