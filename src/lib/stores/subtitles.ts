// 版本化交付 · 状态编排层（Svelte stores + localStorage）
// 页面只与本层交互；版本判定走 versioning/rules，审校流转走 versioning/review，
// 读写与旧数据升级走 versioning/persistence。

import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import { loadDocument, saveDocument, STORAGE_KEY } from "$lib/versioning/persistence";
import { buildRelease, commitCuePatch, computeBlockers, exportSrt, mergePending, releaseLock as dropLock, withdrawPending } from "$lib/versioning/rules";
import { applyTermLockChange, decideReview, makeEvent, submitForReview } from "$lib/versioning/review";
import type {
  Actor,
  Blocker,
  Cue,
  CueStatus,
  Release,
  SaveOutcome,
  StorageDocument,
  TimelineConflict,
  VersionCredential
} from "$lib/versioning/types";

export type {
  Actor,
  Blocker,
  Cue,
  CueStatus,
  EditLock,
  GlossaryTerm,
  PendingMerge,
  Release,
  ReviewEvent,
  ReviewRule,
  SaveOutcome,
  Snapshot,
  TimelineConflict,
  Track
} from "$lib/versioning/types";

/* ---------------- 身份（模拟不同协作角色与标签页） ---------------- */

const ACTOR_KEY = "pair-wise-yf-51/actor";
export const ACTORS: Actor[] = [
  { id: "u-producer", name: "制作人·沈越", role: "producer" },
  { id: "u-translator-a", name: "译员·林岚", role: "translator" },
  { id: "u-translator-b", name: "译员·周野", role: "translator" },
  { id: "u-reviewer", name: "审校·顾宁", role: "reviewer" }
];
const storedActor = browser ? localStorage.getItem(ACTOR_KEY) : null;
export const currentActor = writable<Actor>(ACTORS.find((item) => item.id === storedActor) ?? ACTORS[1]);
currentActor.subscribe((actor) => browser && localStorage.setItem(ACTOR_KEY, actor.id));

/** tabId 随身份变化：切换到另一名译员等价于另一个标签页参与编辑 */
function clientIdFor(actor: Actor) {
  return `${actor.id}#${Math.abs(hashCode(actor.id))}`;
}
function hashCode(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash << 5) - hash + value.charCodeAt(i);
  return hash;
}

/* ---------------- 文档与基线 ---------------- */

export const doc = writable<StorageDocument>(loadDocument());

doc.subscribe((value) => saveDocument(value));

/** 当前页面持有的版本凭据基线；落后于 doc.revision 即为“旧标签页” */
export const knownRevision = writable<number>(get(doc).revision);

export const revision = derived(doc, ($doc) => $doc.revision);
export const tracks = derived(doc, ($doc) => $doc.tracks);
export const cues = derived(doc, ($doc) => $doc.cues);
export const terms = derived(doc, ($doc) => $doc.terms);
export const rules = derived(doc, ($doc) => $doc.rules);
export const reviewEvents = derived(doc, ($doc) => $doc.events);
export const snapshots = derived(doc, ($doc) => $doc.snapshots);
export const conflicts = derived(doc, ($doc) => $doc.conflicts);
export const releases = derived(doc, ($doc) => $doc.releases);
export const pendingMerges = derived(doc, ($doc) => $doc.pendingMerges);
export const locks = derived(doc, ($doc) => $doc.locks);
export const blockers = derived(doc, ($doc) => computeBlockers({ pendingMerges: $doc.pendingMerges, cues: $doc.cues, locks: $doc.locks }));
export const currentVersion = derived(doc, ($doc) => $doc.releases[0]?.label ?? "未发布（工作基线）");

export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const viewingReleaseId = writable<string | null>(null);
export const viewingRelease = derived([releases, viewingReleaseId], ([$releases, $id]) => $releases.find((item) => item.id === $id) ?? null);

/* ---------------- 通知 ---------------- */

export interface Notice {
  id: string;
  tone: "info" | "error" | "success";
  text: string;
}
export const notices = writable<Notice[]>([]);
function notify(text: string, tone: Notice["tone"] = "info") {
  const notice = { id: crypto.randomUUID(), text, tone };
  notices.update((items) => [notice, ...items].slice(0, 4));
  if (tone === "success") setTimeout(() => dismissNotice(notice.id), 4000);
}
export function dismissNotice(id: string) {
  notices.update((items) => items.filter((item) => item.id !== id));
}

/* ---------------- 跨标签页：他页写入后本页自动看到“基线已变” ---------------- */

if (browser) {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const next = JSON.parse(event.newValue) as StorageDocument;
      const previous = get(doc).revision;
      doc.set(next);
      if (next.revision > previous) {
        notify(`另一个标签页已写入，基线 r${previous} → r${next.revision}。当前页仍是旧凭据，保存将退回待合并。`, "error");
      }
    } catch {
      // 解析失败时保留当前文档，等下一次写入
    }
  });
}

function credential(): VersionCredential {
  const actor = get(currentActor);
  return { baseRevision: get(knownRevision), actor: actor.name, tabId: clientIdFor(actor) };
}

function isStale(): boolean {
  return get(knownRevision) < get(doc).revision;
}

function patchDoc(mutate: (draft: StorageDocument) => void, nextRevision?: number) {
  doc.update((current) => {
    const draft: StorageDocument = structuredClone(current);
    mutate(draft);
    draft.revision = nextRevision ?? current.revision + 1;
    return draft;
  });
}

function appendEvents(draft: StorageDocument, events: StorageDocument["events"]) {
  draft.events = [...events, ...draft.events].slice(0, 200);
}

/* ---------------- 带凭据的字幕保存（核心并发规则） ---------------- */

/**
 * 页面修改统一入口：携带版本凭据提交。
 * - 接受：写入并推进修订号，本页基线同步；
 * - 基线落后 / 他人占用：不覆盖任何审校内容，修改退回“待合并”。
 */
export function saveCue(id: string, patch: Partial<Cue>): SaveOutcome {
  const current = get(doc);
  const outcome = commitCuePatch({
    cues: current.cues,
    locks: current.locks,
    revision: current.revision,
    cueId: id,
    patch,
    credential: credential()
  });

  if (outcome.kind === "accepted" && outcome.cues && outcome.locks) {
    const nextRevision = outcome.revision!;
    patchDoc((draft) => {
      draft.cues = outcome.cues!;
      draft.locks = outcome.locks!;
    }, nextRevision);
    knownRevision.set(nextRevision);
    return outcome;
  }

  if ((outcome.kind === "stale" || outcome.kind === "blocked") && outcome.merge) {
    const merge = outcome.merge;
    patchDoc((draft) => {
      // 同一身份对同一字幕只保留一条待处理，避免重复堆积
      draft.pendingMerges = [merge, ...draft.pendingMerges.filter((item) => !(item.cueId === merge.cueId && item.tabId === merge.tabId && item.status === "待处理"))];
      const cue = draft.cues.find((item) => item.id === merge.cueId);
      appendEvents(draft, [makeEvent(merge.cueId, "待合并", outcome.reason ?? "基线已变", merge.actor)]);
      void cue;
    }, current.revision);
    notify(outcome.reason ?? "基线已变，修改已退回待合并", "error");
    return outcome;
  }

  notify(outcome.reason ?? "保存失败", "error");
  return outcome;
}

export function updateCue(id: string, patch: Partial<Cue>) {
  saveCue(id, patch);
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(doc).cues.find((item) => item.id === id);
  if (!cue) return;
  saveCue(id, { start: Math.max(0, Number((cue.start + delta).toFixed(1))), end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1))) });
}

/* ---------------- 审校流转 ---------------- */

function requireFreshBaseline(action: string): boolean {
  if (isStale()) {
    notify(`基线已变（本页 r${get(knownRevision)} / 当前 r${get(doc).revision}），${action}已阻止；请先同步最新基线。`, "error");
    return false;
  }
  return true;
}

export function setCueStatus(id: string, status: CueStatus) {
  if (status !== "待审" || !requireFreshBaseline("提交审校")) return;
  const actor = get(currentActor);
  patchDoc((draft) => {
    const cue = draft.cues.find((item) => item.id === id);
    if (!cue) return;
    const result = submitForReview(cue, actor.name);
    draft.cues = draft.cues.map((item) => (item.id === id ? { ...result.cue, cueRevision: draft.revision, updatedBy: actor.name } : item));
    // 提交即完成本轮编辑，释放自己的占用锁
    draft.locks = draft.locks.filter((lock) => !(lock.cueId === id && lock.tabId === credential().tabId));
    appendEvents(draft, [result.event]);
  });
  knownRevision.set(get(doc).revision);
  notify("已提交审校并释放编辑占用", "success");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  if (!requireFreshBaseline(approved ? "审校通过" : "退回修改")) return;
  const actor = get(currentActor);
  patchDoc((draft) => {
    const cue = draft.cues.find((item) => item.id === id);
    if (!cue) return;
    const result = decideReview(cue, approved, note || "请核对术语和断句", actor.name);
    draft.cues = draft.cues.map((item) => (item.id === id ? { ...result.cue, cueRevision: draft.revision, updatedBy: actor.name } : item));
    appendEvents(draft, [result.event]);
  });
  knownRevision.set(get(doc).revision);
  notify(approved ? "审校通过" : "已退回修改，审校内容受版本保护", "success");
}

/* ---------------- 术语锁定变化 → 待审字幕重入审校 ---------------- */

export function setTermLocked(id: string, locked: boolean) {
  if (!requireFreshBaseline(locked ? "术语锁定" : "解除术语锁定")) return;
  const actor = get(currentActor);
  const current = get(doc);
  const nextRevision = current.revision + 1;
  const result = applyTermLockChange({ terms: current.terms, cues: current.cues, termId: id, locked, revision: nextRevision, actor: actor.name });
  if (!result.events.length) return;
  patchDoc((draft) => {
    draft.terms = result.terms;
    draft.cues = result.cues;
    appendEvents(draft, result.events);
  }, nextRevision);
  knownRevision.set(nextRevision);
  const reopened = result.events.filter((item) => item.action === "重入审校").length;
  notify(locked ? `术语已锁定，${reopened} 条待审/已通过字幕重入审校；已发布版本不受影响。` : `术语已解除锁定，${reopened} 条字幕重入审校。`, reopened ? "info" : "success");
}

/* ---------------- 待合并：后提交者按最新内容合并或撤回 ---------------- */

export function resolvePendingMerge(id: string, choice: "merge" | "withdraw") {
  const current = get(doc);
  const merge = current.pendingMerges.find((item) => item.id === id);
  if (!merge || merge.status !== "待处理") return;
  const actor = get(currentActor);

  if (choice === "withdraw") {
    const result = withdrawPending({ merge, locks: current.locks });
    patchDoc((draft) => {
      draft.pendingMerges = draft.pendingMerges.map((item) => (item.id === id ? result.merge : item));
      draft.locks = result.locks;
      appendEvents(draft, [makeEvent(merge.cueId, "撤回修改", `撤回基于 r${merge.baseRevision} 的过期修改`, actor.name)]);
    });
    notify("已撤回过期修改，字幕保持最新审校内容。", "success");
    return;
  }

  const result = mergePending({ merge, cues: current.cues, locks: current.locks, revision: current.revision, credential: credential() });
  if (result.kind !== "accepted") {
    notify(result.reason ?? "合并失败", "error");
    return;
  }
  patchDoc((draft) => {
    draft.cues = result.cues;
    draft.locks = result.locks;
    draft.pendingMerges = draft.pendingMerges.map((item) => (item.id === id ? result.merge : item));
    appendEvents(draft, [makeEvent(merge.cueId, "待合并", `已基于 r${current.revision} 合并后提交内容，重新进入翻译`, actor.name)]);
  }, result.revision);
  knownRevision.set(result.revision!);
  notify("已按最新内容合并，字幕回到翻译中，需重新提交审校。", "success");
}

export function releaseCueLock(cueId: string) {
  const tabId = clientIdFor(get(currentActor));
  patchDoc((draft) => {
    draft.locks = dropLock({ locks: draft.locks, cueId, tabId });
  });
}

/* ---------------- 结构性编辑（拆分/合并/新增/快照恢复），同样要凭据 ---------------- */

function guardedStructural(action: string, mutate: (draft: StorageDocument) => void): boolean {
  if (!requireFreshBaseline(action)) return false;
  patchDoc(mutate);
  knownRevision.set(get(doc).revision);
  return true;
}

export function splitCue(id: string) {
  guardedStructural("拆分字幕", (draft) => {
    const cue = draft.cues.find((item) => item.id === id);
    if (!cue || cue.end - cue.start < 1) return;
    const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
    const first: Cue = { ...cue, end: middle, status: "翻译中", cueRevision: draft.revision, updatedBy: credential().actor };
    const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译", cueRevision: draft.revision, updatedBy: credential().actor };
    draft.cues = draft.cues.flatMap((item) => (item.id === id ? [first, second] : item));
    selectedCueId.set(second.id);
  });
}

export function mergeNext(id: string) {
  guardedStructural("合并字幕", (draft) => {
    const trackId = get(activeTrackId);
    const list = [...draft.cues].filter((item) => item.trackId === trackId).sort((a, b) => a.start - b.start);
    const index = list.findIndex((item) => item.id === id);
    const next = list[index + 1];
    if (!next) return;
    draft.cues = draft.cues
      .filter((item) => item.id !== next.id)
      .map((item) =>
        item.id === id
          ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中" as CueStatus, cueRevision: draft.revision, updatedBy: credential().actor }
          : item
      );
  });
}

export function addCue(item: Omit<Cue, "id" | "cueRevision" | "reviewerNote"> & { reviewerNote?: string }) {
  if (!requireFreshBaseline("新增字幕")) return;
  const actor = get(currentActor);
  patchDoc((draft) => {
    draft.cues = [
      ...draft.cues,
      { ...item, id: crypto.randomUUID(), reviewerNote: item.reviewerNote ?? "", cueRevision: draft.revision, updatedBy: actor.name }
    ];
  });
  knownRevision.set(get(doc).revision);
}

export function createSnapshot(name?: string) {
  const current = get(doc);
  const label = name ?? `时间轴快照 r${current.revision}`;
  patchDoc((draft) => {
    draft.snapshots = [
      { id: crypto.randomUUID(), name: label, time: new Date().toISOString(), revision: current.revision, cues: structuredClone(current.cues) },
      ...draft.snapshots
    ].slice(0, 12);
  });
  knownRevision.set(get(doc).revision);
  notify("快照已保存（含字幕与修订号）", "success");
}

export function restoreSnapshot(id: string) {
  if (!requireFreshBaseline("恢复快照")) return;
  const current = get(doc);
  const snapshot = current.snapshots.find((item) => item.id === id);
  if (!snapshot) return;
  patchDoc((draft) => {
    // 恢复内容但统一抬到新修订号，避免旧内容绕过并发保护
    draft.cues = structuredClone(snapshot.cues).map((cue) => ({ ...cue, cueRevision: draft.revision }));
    appendEvents(draft, [makeEvent("", "恢复快照", `恢复快照「${snapshot.name}」（原 r${snapshot.revision}）`, credential().actor)]);
  });
  knownRevision.set(get(doc).revision);
  notify(`已恢复快照「${snapshot.name}」，内容按新基线 r${get(doc).revision} 生效。`, "success");
}

/* ---------------- 时间轴冲突记录（保留并继续处理） ---------------- */

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  const current = get(doc);
  const conflict = current.conflicts.find((item) => item.id === id);
  if (!conflict) return;
  if (resolution === "采用协作版本") {
    const outcome = saveCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
    if (outcome.kind !== "accepted") return; // 已退回待合并，冲突保持待处理
  }
  patchDoc((draft) => {
    draft.conflicts = draft.conflicts.map((item) => (item.id === id ? { ...item, status: resolution } : item));
  });
  knownRevision.set(get(doc).revision);
}

/* ---------------- 制作人发布版本：冻结轨道、术语、审校规则 ---------------- */

export function createRelease(level: string, note: string): Release | null {
  const actor = get(currentActor);
  if (actor.role !== "producer") {
    notify("仅制作人可以建立发布版本。", "error");
    return null;
  }
  const hardBlockers = get(blockers).filter((item) => item.severity === "hard");
  if (hardBlockers.length) {
    notify(`发布被 ${hardBlockers.length} 个硬阻塞项拦截，请先处理待合并。`, "error");
    return null;
  }
  const current = get(doc);
  const { release, counter } = buildRelease({
    counter: current.releaseCounter,
    level,
    note: note || "交付发布",
    revision: current.revision,
    creator: actor.name,
    tracks: current.tracks,
    cues: current.cues,
    terms: current.terms,
    rules: current.rules
  });
  patchDoc((draft) => {
    draft.releases = [release, ...draft.releases];
    draft.releaseCounter = counter;
    // 冻结发布时点的轨道状态；新一轮修改在此基础上继续
    draft.tracks = draft.tracks.map((track) => ({ ...track, status: "已发布" as const }));
    appendEvents(draft, [makeEvent("", "发布版本", `${release.label} 冻结 ${release.tracks.length} 条轨道 / ${release.cues.length} 条字幕 / ${release.terms.length} 条术语 / ${release.rules.length} 条审校规则`, actor.name)]);
  }, current.revision + 1);
  knownRevision.set(get(doc).revision);
  notify(`发布版本 ${release.label} 已建立，冻结内容可随时查看与导出。`, "success");
  return release;
}

/** 已发布版本导出 SRT */
export function exportRelease(releaseId: string, trackId: string) {
  const release = get(doc).releases.find((item) => item.id === releaseId);
  if (!release || !browser) return;
  const content = exportSrt(release, trackId);
  const blob = new Blob([content], { type: "text/srt;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${release.label}-${trackId}.srt`;
  link.click();
  URL.revokeObjectURL(url);
  notify(`已导出 ${release.label} 的 ${trackId.toUpperCase()} 轨道 SRT。`, "success");
}

/* ---------------- 旧标签页同步基线 ---------------- */

export function syncBaseline() {
  knownRevision.set(get(doc).revision);
  notify(`已同步到最新基线 r${get(doc).revision}，请基于最新内容继续编辑。`, "success");
}

/* ---------------- 页面派生数据 ---------------- */

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) =>
  $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }))
);

export function cueLock(cueId: string) {
  return derived(locks, ($locks) => $locks.find((lock) => lock.cueId === cueId) ?? null);
}
