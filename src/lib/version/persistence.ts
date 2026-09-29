// 持久化层：localStorage 读写、v1 → v2 数据迁移、跨标签页同步。
// 业务规则不放在这里，只保证字幕、快照、冲突记录在升级时不丢失。

import type { PersistedState } from "./model";

export const STORAGE_KEY = "pair-wise-yf-51/subtitles-v2";
export const LEGACY_KEY = "pair-wise-yf-51/subtitles-v1";

interface LegacyState {
  tracks?: PersistedState["tracks"];
  cues?: PersistedState["cues"];
  terms?: PersistedState["terms"];
  events?: PersistedState["reviewEvents"];
  snapshots?: PersistedState["snapshots"];
}

function seedRules(now: string): PersistedState["rules"] {
  return [
    { id: "r1", name: "术语一致", detail: "译文必须采用已锁定术语；术语锁定变化后，待审字幕重新进入审校。", enabled: true, updatedAt: now },
    { id: "r2", name: "行长限制", detail: "单行字幕不超过 42 个全角字符，超出需拆行或拆分字幕。", enabled: true, updatedAt: now },
    { id: "r3", name: "上下文备注", detail: "退回时必须填写具体原因，供译员按备注修订。", enabled: false, updatedAt: now }
  ];
}

/** 旧版数据升级：字幕、快照、冲突记录原样保留，补齐版本化字段。 */
export function migrateLegacy(raw: LegacyState, conflicts: PersistedState["conflicts"]): PersistedState {
  const now = new Date(0).toISOString();
  const cues = raw.cues ?? [];
  const cueRevisions: Record<string, number> = {};
  for (const cue of cues) cueRevisions[cue.id] = 1;
  return {
    schemaVersion: 2,
    currentReleaseId: null,
    releases: [],
    tracks: raw.tracks ?? [],
    cues,
    terms: (raw.terms ?? []).map((term) => ({ ...term })),
    reviewEvents: raw.events ?? [],
    snapshots: (raw.snapshots ?? []).map((snapshot) => structuredClone(snapshot)),
    conflicts: structuredClone(conflicts),
    rules: seedRules(now),
    locks: [],
    pendingMerges: [],
    cueRevisions,
    termRevision: 1,
    rulesRevision: 1
  };
}

export function loadInitialState(fallback: PersistedState): PersistedState {
  if (typeof localStorage === "undefined") return fallback;

  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.schemaVersion === 2) return parsed;
    } catch {
      // 损坏数据回退到迁移/种子流程
    }
  }

  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      const migrated = migrateLegacy(JSON.parse(legacy) as LegacyState, fallback.conflicts);
      saveState(migrated);
      return migrated;
    } catch {
      // 旧数据损坏时不破坏原键，继续使用种子数据
    }
  }

  saveState(fallback);
  return fallback;
}

export function saveState(state: PersistedState) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** 监听其他标签页的写入，模拟协作方的实时状态广播。 */
export function startStorageSync(handler: (state: PersistedState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const state = JSON.parse(event.newValue) as PersistedState;
      if (state.schemaVersion === 2) handler(state);
    } catch {
      // 忽略无法解析的广播
    }
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
