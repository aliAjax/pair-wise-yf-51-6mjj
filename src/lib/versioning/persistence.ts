// 版本化交付 · 持久化层
// 负责 localStorage 读写与旧数据升级。升级时保留字幕、快照和冲突记录，
// 不做任何版本规则判定（规则全部在 rules.ts，审校流转在 review.ts）。

import { browser } from "$app/environment";
import { defaultRules } from "./rules";
import type {
  Cue,
  GlossaryTerm,
  ReviewEvent,
  ReviewRule,
  Snapshot,
  StorageDocument,
  TimelineConflict,
  Track
} from "./types";

const KEY = "pair-wise-yf-51/subtitles-v1";

const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", cueRevision: 1 },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", cueRevision: 1 },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", cueRevision: 1 },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", cueRevision: 1 }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", lockedRevision: 1 },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", lockedRevision: 1 },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];
const seedConflicts: TimelineConflict[] = [
  { id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理", baseRevision: 1 }
];

export function freshDocument(): StorageDocument {
  return assemble({
    tracks: structuredClone(seedTracks),
    cues: structuredClone(seedCues),
    terms: structuredClone(seedTerms),
    events: [],
    snapshots: [],
    conflicts: structuredClone(seedConflicts)
  });
}

function assemble(parts: {
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  events: ReviewEvent[];
  snapshots: Snapshot[];
  conflicts: TimelineConflict[];
  rules?: ReviewRule[];
}): StorageDocument {
  return {
    schema: 2,
    revision: 1,
    tracks: parts.tracks,
    cues: parts.cues,
    terms: parts.terms,
    rules: parts.rules ?? defaultRules(),
    events: parts.events,
    snapshots: parts.snapshots,
    conflicts: parts.conflicts,
    releases: [],
    pendingMerges: [],
    locks: [],
    releaseCounter: 0
  };
}

/** v1（无 schema 字段）→ schema 2：字幕、快照、冲突记录原样保留 */
function migrateV1(raw: Record<string, unknown>): StorageDocument {
  const cues = Array.isArray(raw.cues) ? (raw.cues as Cue[]) : [];
  const doc = assemble({
    tracks: Array.isArray(raw.tracks) ? (raw.tracks as Track[]) : structuredClone(seedTracks),
    // 旧字幕全部标到 r1：历史内容不受新并发规则影响
    cues: cues.map((cue) => ({ ...cue, cueRevision: cue.cueRevision ?? 1 })),
    terms: Array.isArray(raw.terms)
      ? (raw.terms as GlossaryTerm[]).map((term) =>
          term.status === "已锁定" ? { ...term, lockedRevision: term.lockedRevision ?? 1 } : term
        )
      : structuredClone(seedTerms),
    events: Array.isArray(raw.events) ? (raw.events as ReviewEvent[]) : [],
    // 快照连同其中字幕原样保留，仅补上 revision 标记
    snapshots: Array.isArray(raw.snapshots)
      ? (raw.snapshots as Snapshot[]).map((snapshot) => ({
          ...snapshot,
          revision: snapshot.revision ?? 0,
          cues: (snapshot.cues ?? []).map((cue) => ({ ...cue, cueRevision: cue.cueRevision ?? 0 }))
        }))
      : [],
    // 冲突记录保留；v1 未持久化冲突时为空数组（不伪造历史）
    conflicts: Array.isArray(raw.conflicts)
      ? (raw.conflicts as TimelineConflict[]).map((conflict) => ({ ...conflict, baseRevision: conflict.baseRevision ?? 0 }))
      : []
  });
  doc.migratedFrom = 1;
  return doc;
}

export function loadDocument(): StorageDocument {
  if (!browser) return freshDocument();
  const text = localStorage.getItem(KEY);
  if (!text) return freshDocument();
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.schema === 2) return raw as unknown as StorageDocument;
    if (raw.schema === undefined) {
      const doc = migrateV1(raw);
      saveDocument(doc); // 立刻回写，完成一次性升级
      return doc;
    }
    // 更高版本无法识别时降级为只读式重置会丢数据，故保守地按当前结构补齐
    return migrateV1(raw);
  } catch {
    return freshDocument();
  }
}

export function saveDocument(doc: StorageDocument): void {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify(doc));
}

export const STORAGE_KEY = KEY;
