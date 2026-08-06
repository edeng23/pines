/** Persisted client UI state (~/.pines/ui.json): tolerant load, atomic-ish save. */
import { readFileSync, writeFileSync } from "node:fs";
import { ensurePinesHome } from "../shared/paths.js";
import { uiStatePath } from "../shared/paths.js";
import { DEFAULT_STYLE_ID, FOREST_STYLES } from "./forest/styles.js";
import type { ForestStyleId } from "./forest/style.js";

export interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Which forest visual option is active (see client/forest/styles.ts). */
  forestStyle: ForestStyleId;
}

export const DEFAULT_UI_STATE: UiState = {
  sidebarVisible: true,
  sidebarWidth: 32,
  forestStyle: DEFAULT_STYLE_ID,
};

export function loadUiState(): UiState {
  try {
    // On disk the style is whatever an older version wrote, not today's union.
    const raw = JSON.parse(readFileSync(uiStatePath(), "utf8")) as Partial<
      Omit<UiState, "forestStyle"> & { forestStyle: string }
    >;
    return {
      sidebarVisible:
        typeof raw.sidebarVisible === "boolean"
          ? raw.sidebarVisible
          : DEFAULT_UI_STATE.sidebarVisible,
      sidebarWidth:
        typeof raw.sidebarWidth === "number" && Number.isFinite(raw.sidebarWidth)
          ? raw.sidebarWidth
          : DEFAULT_UI_STATE.sidebarWidth,
      // An unknown style (hand-edited file, or one dropped in a later
      // version) falls back rather than rendering nothing. blueprint was
      // absorbed into canopy — saved picks follow it there.
      forestStyle:
        raw.forestStyle === "blueprint"
          ? "canopy"
          : FOREST_STYLES.some((s) => s.id === raw.forestStyle)
            ? (raw.forestStyle as ForestStyleId)
            : DEFAULT_UI_STATE.forestStyle,
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
