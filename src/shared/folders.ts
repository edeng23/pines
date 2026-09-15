/**
 * Folder paths: how trees are filed. A folder is a '/'-separated path such
 * as "work/auth"; segments are trimmed, empty segments dropped, and the
 * whole thing is case-preserving. The daemon normalizes on write so every
 * client sees one spelling; clients normalize user input the same way.
 */

/** "  Work / auth/ " → "Work/auth"; "" / "/" / null → null (unfiled). */
export function normalizeFolder(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const segs = raw
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0);
  return segs.length > 0 ? segs.join("/") : null;
}

/** "work/auth" → ["work", "work/auth"]: every ancestor, shallow first. */
export function folderAncestors(folder: string): string[] {
  const segs = folder.split("/");
  const out: string[] = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** Last segment of a folder path: "work/auth" → "auth". */
export function folderName(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1);
}

/** Parent path, or null at the top level: "work/auth" → "work". */
export function folderParent(folder: string): string | null {
  const i = folder.lastIndexOf("/");
  return i < 0 ? null : folder.slice(0, i);
}

/** Whether `folder` is `scope` or lives somewhere beneath it. */
export function inFolder(folder: string | null | undefined, scope: string): boolean {
  if (!folder) return false;
  return folder === scope || folder.startsWith(scope + "/");
}

/** Tabs mode: the tab that shows only unfiled trees (never a real path). */
export const UNFILED_TAB = "\0unfiled";

/**
 * What a list row's right-hand chip should say for a tree: its folder
 * (relative to the folder in view, so "work/auth" under "work" reads
 * "auth"; nothing when the folder is exactly the one in view), else the
 * directory basename. `chipBase === undefined` means "folders are not
 * shown as chips here" (the tree and drill layouts, where context says it).
 */
export function rowChip(
  t: { folder?: string | null; cwd: string | null },
  chipBase: string | null | undefined,
): string {
  const f = normalizeFolder(t.folder);
  if (f && chipBase !== undefined) {
    if (chipBase && chipBase !== UNFILED_TAB && inFolder(f, chipBase)) {
      const rel = f === chipBase ? "" : f.slice(chipBase.length + 1);
      if (rel) return rel;
    } else {
      return f;
    }
  }
  return t.cwd ? t.cwd.slice(t.cwd.lastIndexOf("/") + 1) : "";
}
