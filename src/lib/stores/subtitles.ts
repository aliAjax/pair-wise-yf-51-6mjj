import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import { loadInitialState, saveState, startStorageSync } from "$lib/version/persistence";
import type {
  BlockedSave,
  Cue,
  CueStatus,
  GlossaryTerm,
  MergeProposal,
  PersistedState,
  ReviewEvent,
  ReviewRule,
  Role,
  Snapshot,
  TimelineConflict,
  Track,
  VersionCredential
} from "$lib/version/model";

export type {
  Cue,
  CueStatus,
  GlossaryTerm,
  MergeProposal,
  Release,
  ReviewEvent,
  ReviewRule,
  Role,
  Snapshot,
  TimelineConflict,
  Track,
  TrackStatus,
  VersionCredential
} from "$lib/version/model";

const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "" },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "" },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "" },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "" }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];
const seedConflicts: TimelineConflict[] = [
  { id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }
];
const seedRules: ReviewRule[] = [
  { id: "r1", name: "术语一致", detail: "译文必须采用已锁定术语；术语锁定变化后，待审字幕重新进入审校。", enabled: true, updatedAt: new Date().toISOString() },
  { id: "r2", name: "行长限制", detail: "单行字幕不超过 42 个全角字符，超出需拆行或拆分字幕。", enabled: true, updatedAt: new Date().toISOString() },
  { id: "r3", name: "上下文备注", detail: "退回时必须填写具体原因，供译员按备注修订。", enabled: false, updatedAt: new Date().toISOString() }
];

function seedState(): PersistedState {
  const cueRevisions: Record<string, number> = {};
  for (const cue of seedCues) cueRevisions[cue.id] = 1;
  return {
    schemaVersion: 2,
    currentReleaseId: null,
    releases: [],
    tracks: seedTracks,
    cues: seedCues,
    terms: seedTerms,
    reviewEvents: [],
    snapshots: [],
    conflicts: seedConflicts,
    rules: seedRules,
    locks: [],
    pendingMerges: [],
    cueRevisions,
    termRevision: 1,
    rulesRevision: 1
  };
}

/** 统一状态容器：所有版本化数据走一次原子更新，保证持久化的是一致快照。 */
function createStateStore() {
  const initial = browser ? loadInitialState(seedState()) : seedState();
  const { subscribe, set } = writable<PersistedState>(initial);
  let muted = false;

  function persist(state: PersistedState) {
    if (!browser || muted) return;
    saveState(state);
  }

  subscribe(persist);

  if (browser) {
    startStorageSync((remote) => {
      muted = true;
      set(remote);
      muted = false;
    });
  }

  return {
    subscribe,
    /** 受保护的唯一写入入口，审校流程层通过它完成所有变更。 */
    commit(updater: (state: PersistedState) => PersistedState) {
      set(updater(get({ subscribe })));
    },
    /** 应用跨标签页同步来的状态（不回写 localStorage，避免回环）。 */
    hydrate(state: PersistedState) {
      muted = true;
      set(state);
      muted = false;
    }
  };
}

export const stateStore = createStateStore();

// 兼容旧页面的切片 store（均为只读视图，写入请走 $lib/review/workflow）
export const tracks = derived(stateStore, (state) => state.tracks);
export const cues = derived(stateStore, (state) => state.cues);
export const terms = derived(stateStore, (state) => state.terms);
export const reviewEvents = derived(stateStore, (state) => state.reviewEvents);
export const snapshots = derived(stateStore, (state) => state.snapshots);
export const conflicts = derived(stateStore, (state) => state.conflicts);
export const rules = derived(stateStore, (state) => state.rules);
export const releases = derived(stateStore, (state) => state.releases);
export const currentReleaseId = derived(stateStore, (state) => state.currentReleaseId);
export const pendingMerges = derived(stateStore, (state) => state.pendingMerges);
export const editLocks = derived(stateStore, (state) => state.locks);

export const activeTrackId = writable("en");
export const selectedCueId = writable<string | null>("c2");
export const viewingReleaseId = writable<string | null>(null);
export const blockedSaves = writable<BlockedSave[]>([]);

// 协作身份：每个标签页独立的会话，制作人 / 译员 / 审校切换角色
export const sessionId = writable<string>(browser && crypto?.randomUUID ? crypto.randomUUID() : `session-${Math.random().toString(36).slice(2)}`);
export const identity = writable<{ name: string; role: Role }>({ name: "林岚", role: "译员" });
export const reviewer = derived(identity, ($identity) => `${$identity.role}-${$identity.name}`);

/** 本标签页各字幕的编辑基线：保存时据此校验版本凭据。 */
const editBases = new Map<string, VersionCredential>();

export function registerEditBase(cue: Cue, currentReleaseIdValue: string | null): VersionCredential {
  const revision = get(stateStore).cueRevisions[cue.id] ?? 1;
  const credential: VersionCredential = {
    releaseId: currentReleaseIdValue,
    baseRevision: revision,
    originalSource: cue.source,
    originalTranslated: cue.translated,
    sessionId: get(sessionId)
  };
  editBases.set(cue.id, credential);
  return credential;
}

export function getEditBase(cueId: string): VersionCredential | undefined {
  return editBases.get(cueId);
}

export function clearEditBase(cueId: string) {
  editBases.delete(cueId);
}

export function clearAllEditBases() {
  editBases.clear();
}

export function addBlockedSave(save: BlockedSave) {
  blockedSaves.update((items) => [save, ...items].slice(0, 8));
}

export function dismissBlockedSave(id: string) {
  blockedSaves.update((items) => items.filter((item) => item.id !== id));
}

export function cueRevision(cueId: string): number {
  return get(stateStore).cueRevisions[cueId] ?? 1;
}

export function currentRelease() {
  const state = get(stateStore);
  return state.releases.find((release) => release.id === state.currentReleaseId) ?? null;
}

export function findRelease(id: string | null) {
  if (!id) return null;
  return get(stateStore).releases.find((release) => release.id === id) ?? null;
}

/** 正在查看的发布版本中的字幕（只读归档）；未查看历史版本时为空。 */
export const viewingCues = derived([stateStore, viewingReleaseId], ([$state, $viewingReleaseId]) => {
  if (!$viewingReleaseId) return null;
  const release = $state.releases.find((item) => item.id === $viewingReleaseId);
  return release ? { release, cues: release.cues, tracks: release.tracks } : null;
});

export const activeCues = derived([stateStore, activeTrackId, selectedCueId, viewingReleaseId], ([$state, $activeTrackId, $selectedCueId, $viewingReleaseId]) => {
  const release = $viewingReleaseId ? $state.releases.find((item) => item.id === $viewingReleaseId) : undefined;
  const source = release ? release.cues : $state.cues;
  return source
    .filter((cue) => cue.trackId === $activeTrackId)
    .sort((a, b) => a.start - b.start)
    .map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }));
});

export function makeMergeProposal(input: Omit<MergeProposal, "id" | "status" | "time">): MergeProposal {
  return { ...input, id: crypto.randomUUID(), status: "待合并", time: new Date().toISOString() };
}

export type { ReviewEvent as ReviewEventType };
