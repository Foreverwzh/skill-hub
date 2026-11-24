import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Returns the effective user home directory (overridable for isolated tests).
 */
export function getUserHome() {
  return path.resolve(process.env.SKILL_HUB_USER_HOME || os.homedir());
}

/**
 * Returns the skill-hub config directory (~/.skill-hub by default).
 */
export function getHubConfigDir() {
  if (process.env.SKILL_HUB_HOME) {
    return path.resolve(process.env.SKILL_HUB_HOME);
  }
  return path.join(getUserHome(), ".skill-hub");
}

/**
 * Expands leading "~" or "~/" against the effective user home directory.
 */
export function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return "";
  const home = getUserHome();
  if (inputPath === "~") return home;
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.resolve(home, inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

/**
 * Contracts paths under user home to "~/" for portable display/storage.
 */
export function contractHome(absPath) {
  if (!absPath) return "";
  const home = getUserHome();
  const normalized = path.resolve(absPath);
  const rel = path.relative(home, normalized);
  if (rel === "") return "~";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return normalized;
}

/**
 * Normalizes paths for comparison (case-insensitive on Windows).
 */
export function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

export function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

export function safeStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

export function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

export function safeReadlink(targetPath) {
  try {
    return fs.readlinkSync(targetPath);
  } catch {
    return null;
  }
}

export function canonicalOrResolved(targetPath) {
  return safeRealpath(targetPath) || path.resolve(targetPath);
}

/**
 * Resolves the deepest existing ancestor via realpath and re-attaches any
 * non-existent trailing path segments. Ensures parent/child nesting checks work
 * reliably on symlinked roots (e.g. /var -> /private/var on macOS).
 */
export function canonicalPrefix(targetPath) {
  let current = path.resolve(targetPath);
  const missing = [];
  for (;;) {
    const real = safeRealpath(current);
    if (real) {
      let out = real;
      for (let i = missing.length - 1; i >= 0; i--) {
        out = path.join(out, missing[i]);
      }
      return out;
    }
    const parent = path.dirname(current);
    const base = path.basename(current);
    if (!parent || parent === current || !base) {
      return path.resolve(targetPath);
    }
    missing.push(base);
    current = parent;
  }
}

/**
 * Resolves a symlink's intended target path even if it is currently broken.
 */
export function resolveLinkTarget(linkPath) {
  const raw = safeReadlink(linkPath);
  if (!raw) return null;
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(path.dirname(linkPath), raw);
  return safeRealpath(resolved) || resolved;
}

/**
 * Checks whether childPath equals or sits inside parentPath.
 */
export function isInsideDir(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const child = normalizeForCompare(childPath);
  const parent = normalizeForCompare(parentPath);
  if (child === parent) return true;
  const sep = IS_WINDOWS ? "\\" : "/";
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Creates a directory symlink on POSIX or a Directory Junction on Windows
 * (junctions do not require administrator or Developer Mode privileges).
 */
export function createDirLink(targetDir, linkPath) {
  const absTarget = path.resolve(targetDir);
  const absLink = path.resolve(linkPath);
  ensureDir(path.dirname(absLink));
  const linkType = IS_WINDOWS ? "junction" : "dir";
  fs.symlinkSync(absTarget, absLink, linkType);
}

/**
 * Safely removes a symlink or Windows junction without ever touching target files
 * or deleting real directories.
 */
export function removeLink(linkPath) {
  const lst = safeLstat(linkPath);
  if (!lst) return false;
  if (!lst.isSymbolicLink()) {
    throw new Error(`Refusing to unlink non-symlink path: ${linkPath}`);
  }
  try {
    fs.unlinkSync(linkPath);
    return true;
  } catch (err) {
    if (IS_WINDOWS && (err.code === "EPERM" || err.code === "EISDIR")) {
      fs.rmdirSync(linkPath);
      return true;
    }
    throw err;
  }
}

/**
 * Recursively copies a directory tree (skipping symlinks to avoid external leaks).
 */
export function copyDirRecursive(srcDir, dstDir) {
  ensureDir(dstDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
      const st = fs.statSync(srcPath);
      try {
        fs.chmodSync(dstPath, st.mode);
      } catch {
        // Ignore chmod differences on restricted filesystems
      }
    }
  }
}

/**
 * Moves a directory safely, falling back to copy+remove across devices.
 */
export function moveDir(srcDir, dstDir) {
  ensureDir(path.dirname(dstDir));
  if (safeLstat(dstDir)) {
    throw new Error(`Destination already exists: ${dstDir}`);
  }
  try {
    fs.renameSync(srcDir, dstDir);
  } catch (err) {
    if (err.code === "EXDEV" || err.code === "EPERM") {
      copyDirRecursive(srcDir, dstDir);
      fs.rmSync(srcDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Moves a file or directory into `destParent` under `preferredName`, appending
 * `-1`, `-2`, ... if that name already exists in `destParent`.
 */
export function moveIntoDir(destParent, srcPath, preferredName) {
  ensureDir(destParent);
  const base = preferredName || path.basename(srcPath);
  let candidate = path.join(destParent, base);
  let seq = 1;
  while (safeLstat(candidate)) {
    candidate = path.join(destParent, `${base}-${seq}`);
    seq += 1;
  }
  moveDir(srcPath, candidate);
  return candidate;
}

/**
 * Removes `dirPath` only if it is a real directory and completely empty.
 */
export function removeIfEmptyDir(dirPath) {
  const lst = safeLstat(dirPath);
  if (!lst || !lst.isDirectory() || lst.isSymbolicLink()) return false;
  try {
    const entries = fs.readdirSync(dirPath).filter((n) => n !== ".DS_Store");
    if (entries.length === 0) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    // Ignore cleanup errors
  }
  return false;
}

export function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`Failed to parse JSON at ${filePath}: ${err.message}`);
  }
}

export function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, filePath);
}
