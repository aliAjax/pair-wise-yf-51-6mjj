import { get } from "svelte/store";
import {
  addBlockedSave,
  blockedSaves,
  clearAllEditBases,
  clearEditBase,
  currentReleaseId,
  getEditBase,
  identity,
  makeMergeProposal,
  registerEditBase,
  selectedCueId,
  sessionId,
  stateStore,
  viewingReleaseId
} from "$lib/stores/subtitles";
import {
  checkCredential,
  computeBlockers,
  lockHeldByOther,
  mergePatch,
  termTouchesCue
} from "$lib/version/model";
import { derived } from "svelte/store";
import type {
  BlockedSave,
  CheckFailure,
  Cue,
  CueStatus,
  MergeProposal,
  PersistedState,
  ReviewAction,
  Role,
  TimelineConflict
} from "$lib/version/model";

type BlockedSaveReason = BlockedSave["reason"];

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 被拦截时产生的待合并记录，页面据此提示合并或撤回 */
  proposalId?: string;
}

type CuePatch = Partial<Pick<Cue, "source" | "translated" | "start" | "end">>;

function actorName(): string {
  const identityValue = get(identity);
  return `${identityValue.role}-${identityValue.name}`;
}

function appendEvent(state: PersistedState, action: ReviewAction, detail: string, cueId = ""): PersistedState {
  const reviewEvents = [
    { id: crypto.randomUUID(), cueId, action, detail, actor: actorName(), time: new Date().toISOString() },
    ...state.reviewEvents
  ].slice(0, 200);
  return { ...state, reviewEvents };
}

function bump(state: PersistedState, ids: string[]): PersistedState {
  const cueRevisions = { ...state.cueRevisions };
  for (const id of ids) cueRevisions[id] = (cueRevisions[id] ?? 1) + 1;
  return { ...state, cueRevisions };
}

function viewingReadonly(): boolean {
  return get(viewingReleaseId) !== null;
}

function role(): Role {
  return get(identity).role;
}

/** 内部统一的字幕提交：保存或送审共用凭据校验、占用拦截与待合并退回。 */
function commitCue(cueId: string, patch: CuePatch, mode: "save" | "submit"): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "当前为已发布归档版本，只读不可编辑。" };

  const sid = get(sessionId);
  let result: ActionResult = { ok: false, message: "" };
  let blockedReason: BlockedSaveReason | null = null;

  stateStore.commit((state) => {
    const cue = state.cues.find((item) => item.id === cueId);
    if (!cue) {
      result = { ok: false, message: "字幕不存在或已被删除，请载入最新基线。" };
      return state;
    }

    const lock = lockHeldByOther(state, cueId, sid);
    const credential = getCredential(cueId);
    const check = checkCredential(state, credential, cue);

    if (lock || !check.ok) {
      const failure: CheckFailure = check.ok ? { ok: false, kind: "修订过期", message: "基线校验未通过。" } : check;
      let message: string;
      let reason: BlockedSaveReason;
      if (lock) {
        reason = "锁占用";
        message = `字幕正由 ${lock.userName} 占住审校，本次改动退回待合并，可按最新内容合并或撤回。`;
      } else {
        reason = failure.kind;
        message = failure.message;
      }
      blockedReason = reason;
      const proposal = makePendingProposal(state, cue, patch, lock ? "锁占用" : "基线已变", credential);
      let next: PersistedState = { ...state, pendingMerges: [proposal, ...state.pendingMerges] };
      next = appendEvent(next, "退回修改", `${mode === "submit" ? "提交审校" : "保存"}被拦截（${proposal.reason}），改动转入待合并。`, cueId);
      result = { ok: false, message, proposalId: proposal.id };
      return next;
    }

    let next: PersistedState = {
      ...state,
      cues: state.cues.map((item) => (item.id === cueId ? { ...item, ...patch } : item))
    };
    next = bump(next, [cueId]);

    if (mode === "submit") {
      const name = get(identity).name;
      next = {
        ...next,
        cues: next.cues.map((item) => (item.id === cueId ? { ...item, status: "待审", translator: name } : item)),
        locks: [...next.locks.filter((item) => item.cueId !== cueId), { cueId, sessionId: sid, userName: name, since: new Date().toISOString(), releaseId: state.currentReleaseId }]
      };
      next = appendEvent(next, "提交审校", cue.translated, cueId);
    }
    result = { ok: true, message: mode === "submit" ? "已提交审校，该字幕由你占住。" : "已保存到当前基线。" };
    return next;
  });

  if (!result.ok) {
    if (blockedReason) {
      const state = get(stateStore);
      const credential = getCredential(cueId);
      addBlockedSave({
        id: crypto.randomUUID(),
        cueId,
        releaseId: credential?.releaseId ?? state.currentReleaseId,
        baseRevision: credential?.baseRevision ?? state.cueRevisions[cueId] ?? 1,
        latestRevision: state.cueRevisions[cueId] ?? 1,
        reason: blockedReason,
        message: result.message,
        time: new Date().toISOString()
      });
      clearEditBase(cueId);
    }
  } else {
    const state = get(stateStore);
    const cue = state.cues.find((item) => item.id === cueId);
    if (cue) registerEditBase(cue, state.currentReleaseId);
  }

  return result;
}

function getCredential(cueId: string) {
  return getEditBase(cueId);
}

function makePendingProposal(state: PersistedState, cue: Cue, patch: CuePatch, reason: MergeProposal["reason"], credential: ReturnType<typeof getEditBase>): MergeProposal {
  return makeMergeProposal({
    cueId: cue.id,
    trackId: cue.trackId,
    proposerSessionId: get(sessionId),
    proposerName: get(identity).name,
    baseReleaseId: credential?.releaseId ?? state.currentReleaseId,
    baseRevision: credential?.baseRevision ?? state.cueRevisions[cue.id] ?? 1,
    baseSource: credential?.originalSource ?? cue.source,
    baseTranslated: credential?.originalTranslated ?? cue.translated,
    patch,
    reason
  });
}

/** 携带版本凭据保存字幕；基线已变或被占住时退回待合并，绝不覆盖审校内容。 */
export function saveCueEdit(cueId: string, patch: CuePatch): ActionResult {
  return commitCue(cueId, patch, "save");
}

/** 译员提交审校：先到者占住，后到者改动进入待合并。 */
export function submitForReview(cueId: string, patch: CuePatch = {}): ActionResult {
  return commitCue(cueId, patch, "submit");
}

/** 时间码微调同样走凭据校验。 */
export function nudgeCue(id: string, delta: number): ActionResult {
  const cue = get(stateStore).cues.find((item) => item.id === id);
  if (!cue) return { ok: false, message: "字幕不存在。" };
  return saveCueEdit(id, {
    start: Math.max(0, Number((cue.start + delta).toFixed(1))),
    end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1)))
  });
}

export function splitCue(id: string): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "已发布版本为只读，不能拆分。" };
  const sid = get(sessionId);
  let result: ActionResult = { ok: false, message: "" };
  let newId: string | null = null;
  stateStore.commit((state) => {
    const cue = state.cues.find((item) => item.id === id);
    if (!cue) return state;
    if (cue.end - cue.start < 1) {
      result = { ok: false, message: "字幕过短，无法拆分。" };
      return state;
    }
    if (lockHeldByOther(state, id, sid) || !checkCredential(state, getEditBase(id), cue).ok) {
      result = { ok: false, message: "基线已变，请先载入最新内容再拆分。" };
      return state;
    }
    const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
    const first: Cue = { ...cue, end: middle, status: "翻译中" };
    const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译" };
    newId = second.id;
    let next: PersistedState = { ...state, cues: state.cues.flatMap((item) => (item.id === id ? [first, second] : item)) };
    next = bump(next, [id]);
    next = { ...next, cueRevisions: { ...next.cueRevisions, [second.id]: 1 } };
    result = { ok: true, message: "已拆分字幕。" };
    return next;
  });
  if (newId) selectedCueId.set(newId);
  return result;
}

export function mergeNext(id: string): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "已发布版本为只读，不能合并。" };
  const sid = get(sessionId);
  let result: ActionResult = { ok: false, message: "" };
  stateStore.commit((state) => {
    const current = state.cues.find((item) => item.id === id);
    if (!current) return state;
    const list = state.cues.filter((cue) => cue.trackId === current.trackId).sort((a, b) => a.start - b.start);
    const index = list.findIndex((item) => item.id === id);
    const nextCue = list[index + 1];
    if (!nextCue) {
      result = { ok: false, message: "后面没有可合并的字幕。" };
      return state;
    }
    if (lockHeldByOther(state, id, sid) || lockHeldByOther(state, nextCue.id, sid) || !checkCredential(state, getEditBase(id), current).ok) {
      result = { ok: false, message: "基线已变或字幕被占住，请先载入最新内容。" };
      return state;
    }
    let next: PersistedState = {
      ...state,
      cues: state.cues
        .filter((item) => item.id !== nextCue.id)
        .map((item) => (item.id === id ? { ...item, end: nextCue.end, translated: `${item.translated} ${nextCue.translated}`.trim(), status: "翻译中" as CueStatus } : item))
    };
    next = bump(next, [id, nextCue.id]);
    result = { ok: true, message: "已与下一条字幕合并。" };
    return next;
  });
  return result;
}

export function addCue(input: Omit<Cue, "id" | "status" | "reviewerNote"> & { status?: CueStatus }): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "已发布版本为只读，不能新增字幕。" };
  const item: Cue = { ...input, id: crypto.randomUUID(), status: input.status ?? "翻译中", reviewerNote: "" };
  stateStore.commit((state) => ({
    ...state,
    cues: [...state.cues, item],
    cueRevisions: { ...state.cueRevisions, [item.id]: 1 }
  }));
  return { ok: true, message: "已新增到当前轨道。" };
}

/** 审校裁决：通过或退回都会释放占用并推进修订号，审校备注只由审校流程写入。 */
export function reviewCue(id: string, approved: boolean, note = ""): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "已发布版本为只读，不能审校。" };
  let result: ActionResult = { ok: true, message: approved ? "审校通过。" : "已退回修改。" };
  stateStore.commit((state) => {
    const cue = state.cues.find((item) => item.id === id);
    if (!cue) {
      result = { ok: false, message: "字幕不存在。" };
      return state;
    }
    const status: CueStatus = approved ? "已通过" : "退回";
    let next: PersistedState = {
      ...state,
      cues: state.cues.map((item) => (item.id === id ? { ...item, status, reviewerNote: note || item.reviewerNote } : item)),
      locks: state.locks.filter((item) => item.cueId !== id)
    };
    next = bump(next, [id]);
    next = appendEvent(next, approved ? "审校通过" : "退回修改", note || cue.translated, id);
    return next;
  });
  return result;
}

/**
 * 术语锁定/解锁：冻结的规则变化会让命中该术语的待审字幕重新进入审校；
 * 已发布版本中的术语不受影响，继续查看与导出。
 */
export function setTermLock(termId: string, locked: boolean): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "已发布版本为只读，不能调整术语。" };
  if (role() === "译员") return { ok: false, message: "仅审校或制作人可以变更术语锁定。" };

  let result: ActionResult = { ok: true, message: locked ? "术语已锁定。" : "术语已解除锁定。" };
  stateStore.commit((state) => {
    const term = state.terms.find((item) => item.id === termId);
    if (!term) {
      result = { ok: false, message: "术语不存在。" };
      return state;
    }
    let next: PersistedState = {
      ...state,
      terms: state.terms.map((item) => (item.id === termId ? { ...item, status: locked ? "已锁定" : "建议", owner: actorName() } : item)),
      termRevision: state.termRevision + 1
    };
    next = appendEvent(next, "术语锁定", `${locked ? "锁定" : "解锁"} ${term.source} → ${term.target}`);

    const affected = next.cues.filter((cue) => (cue.status === "待审" || cue.status === "待重审") && termTouchesCue(term, cue));
    if (affected.length > 0) {
      const ids = new Set(affected.map((cue) => cue.id));
      next = {
        ...next,
        cues: next.cues.map((cue) => (ids.has(cue.id) ? { ...cue, status: "待重审" } : cue))
      };
      next = bump(next, [...ids]);
      for (const cue of affected) {
        next = appendEvent(next, "重新审校", `术语「${term.source}」锁定状态变化，命中待审字幕，重新进入审校。`, cue.id);
      }
    }
    return next;
  });
  return result;
}

export function setRuleEnabled(ruleId: string, enabled: boolean): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "查看归档版本时不能调整规则。" };
  if (role() !== "制作人") return { ok: false, message: "只有制作人可以调整审校规则。" };
  stateStore.commit((state) => ({
    ...state,
    rules: state.rules.map((item) => (item.id === ruleId ? { ...item, enabled, updatedAt: new Date().toISOString() } : item)),
    rulesRevision: state.rulesRevision + 1
  }));
  return { ok: true, message: enabled ? "规则已启用。" : "规则已停用。" };
}

/**
 * 制作人建立发布版本：冻结各语言轨、术语与审校规则。
 * 发布后旧标签页凭据中的 releaseId 失配，再保存即提示基线已变。
 */
export function createRelease(name?: string): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "请先退出归档查看再发布新版本。" };
  if (role() !== "制作人") return { ok: false, message: "只有制作人可以建立发布版本。" };

  const state0 = get(stateStore);
  const release = {
    id: crypto.randomUUID(),
    name: name?.trim() || `交付版本 ${state0.releases.length + 1}`,
    createdAt: new Date().toISOString(),
    createdBy: actorName(),
    tracks: structuredClone(state0.tracks),
    cues: structuredClone(state0.cues),
    terms: structuredClone(state0.terms),
    rules: structuredClone(state0.rules),
    termRevision: state0.termRevision,
    rulesRevision: state0.rulesRevision
  };

  stateStore.commit((state) => {
    let next: PersistedState = {
      ...state,
      releases: [release, ...state.releases],
      currentReleaseId: release.id,
      locks: []
    };
    next = appendEvent(next, "发布版本", `${release.name} 已冻结 ${release.tracks.length} 条语言轨、${release.terms.length} 条术语与 ${release.rules.length} 条审校规则。`);
    return next;
  });

  // 发布即换基线：清空本标签页编辑凭据，旧标签页下次保存凭 releaseId 失配被拦截
  clearAllEditBases();
  return { ok: true, message: `发布版本「${release.name}」已建立并冻结。` };
}

/** 后提交者按最新内容合并：补丁只覆盖自己改过的字段，随后重新进入审校。 */
export function resolveMergeProposal(proposalId: string, action: "merge" | "withdraw"): ActionResult {
  if (action === "merge" && viewingReadonly()) return { ok: false, message: "请退出归档查看后再合并。" };
  let result: ActionResult = { ok: false, message: "" };
  stateStore.commit((state) => {
    const proposal = state.pendingMerges.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== "待合并") {
      result = { ok: false, message: "待合并记录不存在或已处理。" };
      return state;
    }
    if (action === "withdraw") {
      let next: PersistedState = {
        ...state,
        pendingMerges: state.pendingMerges.map((item) => (item.id === proposalId ? { ...item, status: "已撤回" } : item))
      };
      next = appendEvent(next, "退回修改", "提交者撤回了本地改动。", proposal.cueId);
      result = { ok: true, message: "已撤回本地改动。" };
      return next;
    }

    const cue = state.cues.find((item) => item.id === proposal.cueId);
    if (!cue) {
      result = { ok: false, message: "对应字幕已不存在，无法合并。" };
      return state;
    }
    const patch = mergePatch(proposal, cue);
    let next: PersistedState = {
      ...state,
      cues: state.cues.map((item) =>
        item.id === cue.id
          ? { ...item, ...patch, status: "待重审", reviewerNote: item.reviewerNote }
          : item
      ),
      locks: state.locks.filter((item) => item.cueId !== cue.id),
      pendingMerges: state.pendingMerges.map((item) => (item.id === proposalId ? { ...item, status: "已合并" } : item))
    };
    next = bump(next, [cue.id]);
    next = appendEvent(next, "重新审校", `待合并改动已按最新基线合并，字幕重新进入审校。`, cue.id);
    result = { ok: true, message: "已按最新内容合并，字幕重新进入审校。" };
    return next;
  });
  if (result.ok) {
    const cueId = get(stateStore).pendingMerges.find((item) => item.id === proposalId)?.cueId;
    if (cueId) blockedSaves.update((items) => items.filter((item) => item.cueId !== cueId));
  }
  return result;
}

export function createSnapshot(name?: string): ActionResult {
  const state = get(stateStore);
  const snapshot = {
    id: crypto.randomUUID(),
    name: name?.trim() || `时间轴快照 ${state.snapshots.length + 1}`,
    time: new Date().toISOString(),
    cues: structuredClone(state.cues)
  };
  stateStore.commit((current) => ({ ...current, snapshots: [snapshot, ...current.snapshots].slice(0, 12) }));
  return { ok: true, message: "已保存快照。" };
}

export function restoreSnapshot(id: string): ActionResult {
  if (viewingReadonly()) return { ok: false, message: "归档查看时不能恢复快照。" };
  let result: ActionResult = { ok: true, message: "已恢复快照，相关字幕需重新审校。" };
  stateStore.commit((state) => {
    const snapshot = state.snapshots.find((item) => item.id === id);
    if (!snapshot) {
      result = { ok: false, message: "快照不存在。" };
      return state;
    }
    const restoredIds = snapshot.cues.map((cue) => cue.id);
    let next = bump({ ...state, cues: structuredClone(snapshot.cues), locks: state.locks.filter((lock) => !restoredIds.includes(lock.cueId)) }, restoredIds);
    next = appendEvent(next, "退回修改", `恢复快照「${snapshot.name}」。`);
    return next;
  });
  clearAllEditBases();
  return result;
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]): ActionResult {
  let result: ActionResult = { ok: true, message: "冲突已处理。" };
  stateStore.commit((state) => {
    const conflict = state.conflicts.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") {
      result = { ok: false, message: "冲突不存在或已处理。" };
      return state;
    }
    let next: PersistedState = {
      ...state,
      conflicts: state.conflicts.map((item) => (item.id === id ? { ...item, status: resolution } : item))
    };
    if (resolution === "采用协作版本") {
      next = {
        ...next,
        cues: next.cues.map((cue) => (cue.id === conflict.cueId ? { ...cue, start: conflict.remoteStart, end: conflict.remoteEnd } : cue))
      };
      next = bump(next, [conflict.cueId]);
    }
    return next;
  });
  return result;
}

/** 当前页面阻塞项汇总（版本发布提示、被拒保存、占用、待合并、待重审）。 */
export const blockers = derived([stateStore, blockedSaves, sessionId, viewingReleaseId], ([$state, $blockedSaves, $sessionId, $viewingReleaseId]) =>
  computeBlockers({ state: $state, blockedSaves: $blockedSaves, sessionId: $sessionId, viewingReleaseId: $viewingReleaseId })
);

export { selectedCueId, currentReleaseId };
