// 版本化交付 · 审校流程层
// 纯函数：审校状态流转、术语锁定变化触发待审/已通过字幕重入审校。
// 不接触持久化；输入输出均为不可变数据，修订号由调用方统一推进。

import type { Cue, GlossaryTerm, ReviewAction, ReviewEvent, ReviewRule } from "./types";

export function makeEvent(cueId: string, action: ReviewAction, detail: string, actor: string): ReviewEvent {
  return { id: crypto.randomUUID(), cueId, action, detail, actor, time: new Date().toISOString() };
}

export function submitForReview(cue: Cue, actor: string): { cue: Cue; event: ReviewEvent } {
  return {
    cue: { ...cue, status: "待审" },
    event: makeEvent(cue.id, "提交审校", cue.translated || "（空译文）", actor)
  };
}

export function decideReview(cue: Cue, approved: boolean, note: string, actor: string): { cue: Cue; event: ReviewEvent } {
  return {
    cue: { ...cue, status: approved ? "已通过" : "退回", reviewerNote: note || cue.reviewerNote },
    event: makeEvent(cue.id, approved ? "审校通过" : "退回修改", note || cue.translated, actor)
  };
}

/**
 * 术语锁定状态变化（锁定或解除锁定）：
 * 引用该术语原文的待审 / 已通过字幕全部重新进入审校，审校备注保留并追加原因。
 * 已发布版本持有自己的术语副本，不受影响。
 */
export function applyTermLockChange(input: {
  terms: GlossaryTerm[];
  cues: Cue[];
  termId: string;
  locked: boolean;
  revision: number;
  actor: string;
}): { terms: GlossaryTerm[]; cues: Cue[]; events: ReviewEvent[] } {
  const term = input.terms.find((item) => item.id === input.termId);
  if (!term) return { terms: input.terms, cues: input.cues, events: [] };

  const terms = input.terms.map((item) =>
    item.id === term.id
      ? { ...item, status: (input.locked ? "已锁定" : "建议") as GlossaryTerm["status"], lockedRevision: input.locked ? input.revision : item.lockedRevision }
      : item
  );

  const events: ReviewEvent[] = [
    makeEvent("", "术语锁定", `${term.source} → ${term.target} ${input.locked ? "已锁定" : "解除锁定"}（r${input.revision}）`, input.actor)
  ];

  const cues = input.cues.map((cue) => {
    const affected = cue.source.includes(term.source) && (cue.status === "待审" || cue.status === "已通过");
    if (!affected) return cue;
    events.push(
      makeEvent(
        cue.id,
        "重入审校",
        `术语「${term.source} → ${term.target}」${input.locked ? "锁定" : "调整"}，按新术语基线重审`,
        input.actor
      )
    );
    const reason = `术语锁定变化（${term.source} → ${term.target}），需按新基线重审`;
    return {
      ...cue,
      status: "待审" as const,
      cueRevision: input.revision,
      updatedBy: input.actor,
      reviewerNote: cue.reviewerNote && cue.reviewerNote !== reason ? `${cue.reviewerNote}｜${reason}` : reason
    };
  });

  return { terms, cues, events };
}

/** 页面展示用：按冻结规则与术语给出提示（不改变状态） */
export function evaluateRules(cue: Cue, rules: ReviewRule[], terms: GlossaryTerm[]): string[] {
  const hits: string[] = [];
  for (const rule of rules.filter((item) => item.enabled)) {
    if (rule.id === "r-length" && cue.translated.length > 42) hits.push("超长文本：译文超过 42 字符");
    if (rule.id === "r-timing" && cue.end - cue.start < 0.5) hits.push("时间码：持续时间不足 0.5 秒");
    if (rule.id === "r-term" && cue.trackId !== "zh") {
      for (const term of terms.filter((item) => item.status === "已锁定")) {
        if (cue.source.includes(term.source) && !cue.translated.includes(term.target)) {
          hits.push(`术语一致：缺少锁定译法「${term.target}」`);
        }
      }
    }
    if (rule.id === "r-note" && cue.status === "待审" && cue.reviewerNote && cue.translated === "") {
      hits.push("上下文备注：退回再提交需回应审校备注");
    }
  }
  return hits;
}
