/**
 * Resolve and load the pi SDK.
 *
 * The SDK is not a dependency of this repo: it ships inside the installed
 * `pi` release. A managed install keeps every version under
 * `<agentDir>/install/releases/<version>/node_modules`, with the active one
 * named by `<agentDir>/install/current-version`. Resolving through that file
 * means pi-ui always drives the same SDK the `pi` command would, and a `pi`
 * upgrade is picked up without touching this code.
 *
 * A plain `npm install @earendil-works/pi-coding-agent` also works; it is tried
 * first so a project-local pin wins over the managed install.
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const PKG = "@earendil-works/pi-coding-agent";

/** The agent config directory: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Absolute path to the SDK's package root, or null when it cannot be found. */
export function resolveSdkPath(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    return existsSync(path.join(p, "dist", "index.js")) ? p : null;
  }
  // 1. A project-local or globally linked install (npm/pnpm/yarn, NODE_PATH).
  try {
    const entry = import.meta.resolve(PKG);
    if (entry) {
      // .../dist/index.js -> package root
      const root = path.resolve(path.dirname(new URL(entry).pathname), "..");
      if (existsSync(path.join(root, "dist", "index.js"))) return root;
    }
  } catch {
    // not installed as a resolvable package — fall through to the managed install
  }
  // 2. The managed pi install, at whatever version is current.
  const install = path.join(agentDir(), "install");
  try {
    const version = readFileSync(path.join(install, "current-version"), "utf8").trim();
    const root = path.join(install, "releases", version, "node_modules", ...PKG.split("/"));
    if (existsSync(path.join(root, "dist", "index.js"))) return root;
  } catch {
    // no managed install (a source checkout, or `pi` installed some other way)
  }
  return null;
}

let cached;

/**
 * Load the SDK module. Cached: importing it takes ~250-500 ms and every
 * workspace shares one copy, so doing it once at startup keeps the first
 * session from paying for it.
 */
export async function loadSdk(explicit) {
  if (cached) return cached;
  const root = resolveSdkPath(explicit);
  if (!root) {
    throw new Error(
      `cannot find ${PKG}. Install it with \`npm install ${PKG}\`, ` +
        `or point --sdk at its package directory (a managed pi install is normally found automatically).`
    );
  }
  const mod = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
  cached = { mod, root, version: readVersion(root) };
  return cached;
}

function readVersion(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

/** True when `p` resolves to the same file as `q` (symlink-tolerant). */
function samePath(p, q) {
  try {
    return realpathSync(p) === realpathSync(q);
  } catch {
    return path.resolve(p) === path.resolve(q);
  }
}

export { samePath };
