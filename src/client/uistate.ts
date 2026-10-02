/** Persisted client UI state (~/.pines/ui.json): tolerant load, atomic-ish save. */
import { readFileSync, writeFileSync } from "node:fs";
import { ensurePinesHome } from "../shared/paths.js";
import { uiStatePath } from "../shared/paths.js";

/**
 * What the forest's right pane shows: the canopy canvas, or a preview of the
 * selected conversation — its message tree, or (live agents only) the pi
 * screen itself. `v` cycles.
 */
export type ForestPane = "canvas" | "conversation" | "screen";
export const FOREST_PANES: readonly ForestPane[] = ["canvas", "conversation", "screen"];

export interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Sidebar folders folded shut, so a tidy list survives a restart. */
  collapsedFolders: string[];
  forestPane: ForestPane;
}

export const DEFAULT_UI_STATE: UiState = {
  sidebarVisible: true,
  sidebarWidth: 32,
  collapsedFolders: [],
  forestPane: "canvas",
};

export function loadUiState(): UiState {
  try {
    // Field-by-field rebuild: unknown keys (e.g. the retired forestStyle of
    // older versions) are silently ignored rather than kept or rejected.
    const raw = JSON.parse(readFileSync(uiStatePath(), "utf8")) as Partial<UiState>;
    return {
      sidebarVisible:
        typeof raw.sidebarVisible === "boolean"
          ? raw.sidebarVisible
          : DEFAULT_UI_STATE.sidebarVisible,
      sidebarWidth:
        typeof raw.sidebarWidth === "number" && Number.isFinite(raw.sidebarWidth)
          ? raw.sidebarWidth
          : DEFAULT_UI_STATE.sidebarWidth,
      collapsedFolders: Array.isArray(raw.collapsedFolders)
        ? raw.collapsedFolders.filter((f): f is string => typeof f === "string")
        : [],
      forestPane: FOREST_PANES.includes(raw.forestPane as ForestPane)
        ? (raw.forestPane as ForestPane)
        : DEFAULT_UI_STATE.forestPane,
    };
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

export function saveUiState(state: UiState): void {
  try {
    ensurePinesHome();
    writeFileSync(uiStatePath(), JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Persistence is best-effort; the session keeps its in-memory state.
  }
}
