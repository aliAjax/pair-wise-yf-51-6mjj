// 版本化交付：共享类型定义（版本规则 / 持久化 / 审校流程 / 页面展示共用）

export type TrackStatus = "草稿" | "审校中" | "已通过" | "已发布";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";
export type PendingMergeStatus = "待处理" | "已合并" | "已撤回";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
  /** 最近一次写入该字幕的修订号（乐观并发基线） */
  cueRevision?: number;
  /** 最近一次写入者，用于多人同时编辑提示 */
  updatedBy?: string;
  /** 进入已发布冻结集时记录的发布版本 */
  version?: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
  /** 锁定所在的修订号，术语锁定变化按此驱动待审字幕重入审校 */
  lockedRevision?: number;
}

/** 审校规则：发布时随版本冻结，后续修改不影响已发布版本 */
export interface ReviewRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export type ReviewAction =
  | "提交审校"
  | "审校通过"
  | "退回修改"
  | "术语锁定"
  | "重入审校"
  | "待合并"
  | "发布版本"
  | "撤回修改"
  | "编辑锁定"
  | "恢复快照";

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: ReviewAction;
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  revision: number;
  cues: Cue[];
}

export interface TimelineConflict {
  id: string;
  cueId: string;
  message: string;
  remoteStart: number;
  remoteEnd: number;
  status: "待处理" | "采用本地" | "采用协作版本";
  /** 冲突产生时的基线修订号，解决时也要带凭据 */
  baseRevision?: number;
}

/** 发布版本：冻结当次各语言轨道、术语和审校规则 */
export interface Release {
  id: string;
  label: string;
  level: string;
  note: string;
  revision: number;
  createdAt: string;
  creator: string;
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  rules: ReviewRule[];
}

/** 版本凭据：每次修改必须携带，证明页面基于哪个修订号 */
export interface VersionCredential {
  baseRevision: number;
  actor: string;
  tabId: string;
}

export type OutcomeKind = "accepted" | "stale" | "blocked" | "notfound";

export interface SaveOutcome {
  kind: OutcomeKind;
  /** accepted 时返回写入后的最新修订号 */
  revision?: number;
  /** stale / blocked 时给出阻塞原因 */
  reason?: string;
  /** stale 时附带服务端（当前页签之外）最新内容，供选择合并或撤回 */
  serverCue?: Cue;
  mergeId?: string;
}

/** 旧标签页的过期修改退回“待合并”，不允许覆盖审校内容 */
export interface PendingMerge {
  id: string;
  cueId: string;
  actor: string;
  tabId: string;
  baseRevision: number;
  incoming: Pick<Cue, "translated" | "start" | "end" | "source">;
  status: PendingMergeStatus;
  reason: string;
  createdAt: string;
  resolvedAt?: string;
}

/** 两名译员同时改同一字幕时的编辑占用锁 */
export interface EditLock {
  cueId: string;
  holder: string;
  tabId: string;
  since: string;
  revision: number;
}

export type ActorRole = "producer" | "translator" | "reviewer";

export interface Actor {
  id: string;
  name: string;
  role: ActorRole;
}

export interface Blocker {
  id: string;
  severity: "hard" | "warning";
  kind: "pending-merge" | "review-open" | "lock" | "baseline";
  message: string;
  cueId?: string;
}

export interface StorageDocument {
  schema: 2;
  revision: number;
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  rules: ReviewRule[];
  events: ReviewEvent[];
  snapshots: Snapshot[];
  conflicts: TimelineConflict[];
  releases: Release[];
  pendingMerges: PendingMerge[];
  locks: EditLock[];
  releaseCounter: number;
  migratedFrom?: number;
}
