// 版本化交付 · 版本规则层
// 纯函数：发布冻结、凭据校验（乐观并发）、待合并的合并/撤回、阻塞项、导出。
// 不接触 localStorage、不接触 Svelte store，便于单独演进与测试。

import type {
  Blocker,
  Cue,
  EditLock,
  GlossaryTerm,
  PendingMerge,
  Release,
  ReviewRule,
  SaveOutcome,
  Track,
  VersionCredential
} from "./types";

/** 译员可写字段；审校状态与审校备注不在其中，任何提交都不能覆盖审校内容 */
export const TRANSLATOR_FIELDS = ["translated", "start", "end", "source"] as const;

export function defaultRules(): ReviewRule[] {
  return [
    { id: "r-term", name: "术语一致", description: "译文必须使用已锁定术语；术语锁定变化后受影响字幕重新进入审校。", enabled: true },
    { id: "r-length", name: "超长文本", description: "单条字幕超过 42 个字符需人工复核。", enabled: true },
    { id: "r-timing", name: "时间码连续性", description: "相邻字幕不得重叠，最短持续 0.5 秒。", enabled: true },
    { id: "r-note", name: "上下文备注", description: "退回再提交时必须回应审校备注。", enabled: true }
  ];
}

export function nextVersionLabel(counter: number, level = "patch") {
  // 现有 counter 对应“补丁号”，minor/major 进位时低位清零
  const major = Math.floor(counter / 100);
  const minor = Math.floor((counter % 100) / 10);
  const patch = counter % 10;
  if (level === "major") return { label: `v${major + 1}.0.0`, counter: (major + 1) * 100 };
  if (level === "minor") return { label: `v${major}.${minor + 1}.0`, counter: major * 100 + (minor + 1) * 10 };
  return { label: `v${major}.${minor}.${patch + 1}`, counter: counter + 1 };
}

export function buildRelease(input: {
  counter: number;
  level: string;
  note: string;
  revision: number;
  creator: string;
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  rules: ReviewRule[];
}): { release: Release; counter: number } {
  const { label, counter } = nextVersionLabel(input.counter, input.level);
  return {
    counter,
    release: {
      id: crypto.randomUUID(),
      label,
      level: input.level,
      note: input.note,
      revision: input.revision,
      createdAt: new Date().toISOString(),
      creator: input.creator,
      tracks: structuredClone(input.tracks),
      cues: structuredClone(input.cues),
      terms: structuredClone(input.terms),
      rules: structuredClone(input.rules)
    }
  };
}

function touched(patch: Partial<Cue>): boolean {
  return TRANSLATOR_FIELDS.some((key) => patch[key] !== undefined);
}

/**
 * 带版本凭据的提交：
 * - 凭据基线落后 -> stale：退回待合并，不覆盖任何审校内容；
 * - 锁被他人占用 -> blocked：同样退回待合并，提示“先提交者占住”；
 * - 基线一致 -> 接受并占用/续用编辑锁，修订号 +1。
 * 返回新状态片段，由持久化层落库。
 */
export function commitCuePatch(input: {
  cues: Cue[];
  locks: EditLock[];
  revision: number;
  cueId: string;
  patch: Partial<Cue>;
  credential: VersionCredential;
  action?: string;
}): SaveOutcome & { cues?: Cue[]; locks?: EditLock[]; merge?: PendingMerge } {
  const cue = input.cues.find((item) => item.id === input.cueId);
  if (!cue) return { kind: "notfound", reason: "字幕已被删除或不存在" };

  const lock = input.locks.find((item) => item.cueId === input.cueId);
  const heldByOther = lock && lock.tabId !== input.credential.tabId;
  const baseCueRevision = cue.cueRevision ?? 0;
  const stale = input.credential.baseRevision < input.revision || baseCueRevision > input.credential.baseRevision;

  if ((stale || heldByOther) && touched(input.patch)) {
    const merge: PendingMerge = {
      id: crypto.randomUUID(),
      cueId: cue.id,
      actor: input.credential.actor,
      tabId: input.credential.tabId,
      baseRevision: input.credential.baseRevision,
      incoming: {
        translated: input.patch.translated ?? cue.translated,
        start: input.patch.start ?? cue.start,
        end: input.patch.end ?? cue.end,
        source: input.patch.source ?? cue.source
      },
      status: "待处理",
      reason: heldByOther
        ? `先提交者 ${lock!.holder} 正在编辑，后提交需基于最新内容合并或撤回`
        : `页面基线为 r${input.credential.baseRevision}，当前基线已推进到 r${input.revision}，审校内容受保护不可覆盖`,
      createdAt: new Date().toISOString()
    };
    return {
      kind: heldByOther ? "blocked" : "stale",
      reason: merge.reason,
      serverCue: structuredClone(cue),
      merge,
      mergeId: merge.id
    };
  }

  // 接受：只落译员可写字段；若字幕已进入审校/通过，重新打开为翻译中
  const reopening = cue.status === "待审" || cue.status === "已通过";
  const nextRevision = input.revision + 1;
  const cues = input.cues.map((item) => {
    if (item.id !== cue.id) return item;
    const safePatch: Partial<Cue> = {};
    for (const key of TRANSLATOR_FIELDS) if (input.patch[key] !== undefined) (safePatch as Record<string, unknown>)[key] = input.patch[key];
    return {
      ...item,
      ...safePatch,
      status: reopening ? "翻译中" : item.status,
      reviewerNote: item.reviewerNote,
      cueRevision: nextRevision,
      updatedBy: input.credential.actor
    };
  });
  const locks = heldByOther
    ? input.locks
    : lock
      ? input.locks.map((item) => (item.cueId === cue.id ? { ...item, holder: input.credential.actor, tabId: input.credential.tabId, revision: nextRevision } : item))
      : [...input.locks, { cueId: cue.id, holder: input.credential.actor, tabId: input.credential.tabId, since: new Date().toISOString(), revision: nextRevision }];

  return { kind: "accepted", revision: nextRevision, cues, locks };
}

/** 后提交者按最新内容合并：保留审校备注，覆盖译员字段，状态回到翻译中重新走审校 */
export function mergePending(input: {
  merge: PendingMerge;
  cues: Cue[];
  locks: EditLock[];
  revision: number;
  credential: VersionCredential;
}): SaveOutcome & { cues: Cue[]; locks: EditLock[]; merge: PendingMerge } {
  const cue = input.cues.find((item) => item.id === input.merge.cueId);
  if (!cue) return { kind: "notfound", reason: "字幕已被删除，无法合并", cues: input.cues, locks: input.locks, merge: { ...input.merge, status: "已撤回", resolvedAt: new Date().toISOString() } };
  const nextRevision = input.revision + 1;
  const cues = input.cues.map((item) =>
    item.id === cue.id
      ? {
          ...item,
          ...input.merge.incoming,
          // 合并始终基于最新内容：不回退 cueRevision、不覆盖审校备注与状态判定以外的字段
          cueRevision: nextRevision,
          updatedBy: input.merge.actor,
          status: "翻译中" as const,
          reviewerNote: item.reviewerNote ? `${item.reviewerNote}` : item.reviewerNote
        }
      : item
  );
  // 合并完成后释放该字幕的编辑锁（先提交者的占用到此结束）
  const locks = input.locks.filter((item) => item.cueId !== cue.id);
  const merge = { ...input.merge, status: "已合并" as const, resolvedAt: new Date().toISOString() };
  return { kind: "accepted", revision: nextRevision, cues, locks, merge };
}

/** 后提交者撤回：丢弃过期修改，解除它引发的待合并 */
export function withdrawPending(input: { merge: PendingMerge; locks: EditLock[] }): { merge: PendingMerge; locks: EditLock[] } {
  return {
    merge: { ...input.merge, status: "已撤回", resolvedAt: new Date().toISOString() },
    // 仅当锁由撤回者持有时释放；先提交者的锁不受影响
    locks: input.locks.filter((lock) => !(lock.cueId === input.merge.cueId && lock.tabId === input.merge.tabId))
  };
}

export function releaseLock(input: { locks: EditLock[]; cueId: string; tabId: string }): EditLock[] {
  return input.locks.filter((lock) => !(lock.cueId === input.cueId && lock.tabId === input.tabId));
}

/** 发布前阻塞项：未处理待合并是硬阻塞；未完成审校与占用锁是提示 */
export function computeBlockers(input: {
  pendingMerges: PendingMerge[];
  cues: Cue[];
  locks: EditLock[];
}): Blocker[] {
  const blockers: Blocker[] = [];
  for (const merge of input.pendingMerges.filter((item) => item.status === "待处理")) {
    blockers.push({
      id: `b-${merge.id}`,
      severity: "hard",
      kind: "pending-merge",
      cueId: merge.cueId,
      message: `字幕存在未处理的待合并修改（${merge.actor}）：${merge.reason}`
    });
  }
  const open = input.cues.filter((cue) => cue.status === "待审" || cue.status === "退回" || cue.status === "翻译中");
  if (open.length) {
    blockers.push({ id: "b-review", severity: "warning", kind: "review-open", message: `${open.length} 条字幕尚未通过审校，发布后仍可在新版本继续审校。` });
  }
  for (const lock of input.locks) {
    blockers.push({
      id: `b-lock-${lock.cueId}`,
      severity: "warning",
      kind: "lock",
      cueId: lock.cueId,
      message: `字幕仍被 ${lock.holder} 占用编辑（自 ${new Date(lock.since).toLocaleTimeString("zh-CN")}）`
    });
  }
  return blockers;
}

export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":") + `,${String(milli).padStart(3, "0")}`;
}

/** 导出已发布版本（或当前轨道）为 SRT，已发布版本长期可查看可导出 */
export function exportSrt(release: Release, trackId: string): string {
  return release.cues
    .filter((cue) => cue.trackId === trackId)
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.translated}\n`)
    .join("\n");
}
