/**
 * pines wire protocol: NDJSON (LF-delimited JSON objects) over a Unix domain socket.
 *
 * One socket, role handshake: the first message from any connection must be a
 * hello carrying `role` ("client" | "extension") and `protocolVersion`.
 *
 * NOTE: src/extension/pines-extension.ts duplicates the extension-facing subset
 * of these shapes inline (it must be dependency-free under jiti). Keep in sync.
 */
import type { SearchHit, SimilarHit, TreeDetail, TreeStatus, TreeSummary } from "./types.js";

export const PROTOCOL_VERSION = 2;

/* ---------------------------------- client → daemon ---------------------------------- */

export interface ClientHello {
  t: "hello";
  role: "client";
  protocolVersion: number;
  cols: number;
  rows: number;
  /** Build version of the client install, for the daemon's log. */
  buildVersion?: string;
}

export interface SpawnTreeMsg {
  t: "spawn_tree";
  id: string;
  cwd: string;
  /** Optional first prompt typed straight into pi once it is up. */
  prompt?: string;
  name?: string;
}

export interface ResumeTreeMsg {
  t: "resume_tree";
  id: string;
  treeId: string;
}

export interface AttachMsg {
  t: "attach";
  id: string;
  treeId: string;
  cols: number;
  rows: number;
}

export interface InputMsg {
  t: "input";
  treeId: string;
  /** base64 raw bytes for the pty */
  data: string;
}

export interface ResizeMsg {
  t: "resize";
  treeId: string;
  cols: number;
  rows: number;
}

export interface DetachMsg {
  t: "detach";
  treeId: string;
}

export interface BranchMsg {
  t: "branch";
  id: string;
  treeId: string;
  nodeId: string;
  mode: "in-place" | "new-tree";
  /** new-tree only: also spawn a pi process on the new tree. */
  spawn?: boolean;
}

export interface SearchMsg {
  t: "search";
  id: string;
  query: string;
  treeId?: string;
}

export interface GetTreeMsg {
  t: "get_tree";
  id: string;
  treeId: string;
}

export interface AckSeenMsg {
  t: "ack_seen";
  treeId: string;
}

export interface KillAgentMsg {
  t: "kill_agent";
  treeId: string;
}

export interface RenameTreeMsg {
  t: "rename_tree";
  id: string;
  treeId: string;
  name: string;
}

export interface SetLabelMsg {
  t: "set_label";
  id: string;
  treeId: string;
  nodeId: string;
  label: string | null;
}

export interface SetArchivedMsg {
  t: "set_archived";
  id: string;
  treeId: string;
  archived: boolean;
}

export interface RelayoutMsg {
  t: "relayout";
  id: string;
}

/** Nearest trees to `treeId` by embedding cosine similarity. */
export interface SimilarMsg {
  t: "similar";
  id: string;
  treeId: string;
  k?: number;
}

export interface ShutdownMsg {
  t: "shutdown";
}

export type ClientToDaemon =
  | ClientHello
  | SpawnTreeMsg
  | ResumeTreeMsg
  | AttachMsg
  | InputMsg
  | ResizeMsg
  | DetachMsg
  | BranchMsg
  | SearchMsg
  | GetTreeMsg
  | AckSeenMsg
  | KillAgentMsg
  | RenameTreeMsg
  | SetLabelMsg
  | SetArchivedMsg
  | RelayoutMsg
  | SimilarMsg
  | ShutdownMsg;

/* ---------------------------------- daemon → client ---------------------------------- */

export interface HelloOk {
  t: "hello_ok";
  protocolVersion: number;
  daemonPid: number;
  forest: TreeSummary[];
  /** Version of the pi runtime this daemon launches (absent while probing). */
  piVersion?: string;
  /**
   * pines version of the build the daemon is running. Absent from daemons
   * older than 0.1.5, which is itself the answer the client needs: a daemon
   * that cannot name its build is not the one just installed.
   */
  daemonVersion?: string;
}

export interface HelloErr {
  t: "hello_err";
  reason: "version" | "other";
  serverProtocolVersion?: number;
  /** Present on version rejections so the peer can signal a daemon it cannot talk to. */
  daemonPid?: number;
  message?: string;
}

export interface ForestUpdate {
  t: "forest_update";
  upsert?: TreeSummary[];
  remove?: string[];
}

export interface AttachOk {
  t: "attach_ok";
  re: string;
  /** base64 of serialized screen state (ANSI) to replay on the client terminal. */
  snapshot: string;
  cols: number;
  rows: number;
}

export interface OutputMsg {
  t: "output";
  treeId: string;
  data: string;
}

export interface AgentExitMsg {
  t: "agent_exit";
  treeId: string;
  code: number | null;
}

export interface ResultMsg {
  t: "result";
  re: string;
  ok: boolean;
  err?: string;
  /** Optional caveat on an ok result (e.g. 'queued: agent busy'). */
  note?: string;
  /** branch/spawn results */
  newTreeId?: string;
  /** search results */
  hits?: SearchHit[];
  /** similar results */
  similar?: SimilarHit[];
  /** get_tree result */
  tree?: TreeDetail;
}

export interface ToastMsg {
  t: "toast";
  level: "info" | "warn" | "error";
  text: string;
  treeId?: string;
}

export type DaemonToClient =
  | HelloOk
  | HelloErr
  | ForestUpdate
  | AttachOk
  | OutputMsg
  | AgentExitMsg
  | ResultMsg
  | ToastMsg;

/* -------------------------------- extension → daemon --------------------------------- */

export interface ExtensionHello {
  t: "hello";
  role: "extension";
  protocolVersion: number;
  pid: number;
  treeId: string;
  sessionPath: string;
  sessionId: string | null;
  leafId: string | null;
  /** Whether the agent is idle right now (waiting for input) at connect time. */
  idle?: boolean;
}

export type ExtensionEventType =
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "session_tree"
  | "session_switch"
  | "session_name"
  | "session_shutdown";

export interface ExtensionEvent {
  t: "ev";
  type: ExtensionEventType;
  newLeafId?: string | null;
  oldLeafId?: string | null;
  sessionPath?: string;
  name?: string;
}

export interface ExtensionCmdResult {
  t: "cmd_result";
  re: string;
  ok: boolean;
  err?: string;
}

export type ExtensionToDaemon = ExtensionHello | ExtensionEvent | ExtensionCmdResult;

/* -------------------------------- daemon → extension --------------------------------- */

export interface ExtensionCmd {
  t: "cmd";
  id: string;
  op: "navigate_tree" | "set_label" | "set_session_name" | "stamp";
  targetId?: string;
  entryId?: string;
  label?: string | null;
  name?: string;
  data?: unknown;
}

export type DaemonToExtension = ExtensionCmd;

/* ------------------------------------- helpers --------------------------------------- */

export type AnyInbound = ClientToDaemon | ExtensionToDaemon;

export function isHello(
  msg: unknown,
): msg is ClientHello | ExtensionHello {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { t?: unknown }).t === "hello" &&
    ((msg as { role?: unknown }).role === "client" ||
      (msg as { role?: unknown }).role === "extension")
  );
}

export type { TreeStatus, TreeSummary, TreeDetail, SearchHit };
