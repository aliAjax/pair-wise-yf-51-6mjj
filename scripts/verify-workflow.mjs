// 端到端工作流验证：用 esbuild 打包时通过 alias 把 $app/environment 替换为浏览器环境。
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 在导入 store 前准备 localStorage / window
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const store = await import("../src/lib/stores/subtitles.ts");
const workflow = await import("../src/lib/review/workflow.ts");
const { get } = await import("svelte/store");

// 初始为种子数据：切换到制作人并发布 v1
store.identity.set({ name: "制作人-陈", role: "制作人" });
let res = workflow.createRelease("交付 v1");
assert.ok(res.ok, res.message);
const v1Id = get(store.stateStore).currentReleaseId;
assert.ok(v1Id);

// 译员 A 在一个标签页打开 c2 并登记凭据
store.sessionId.set("session-A");
store.identity.set({ name: "林岚", role: "译员" });
store.selectedCueId.set("c2");
let state = get(store.stateStore);
const c2 = state.cues.find((c) => c.id === "c2");
store.registerEditBase(c2, v1Id);

// 正常携带凭据保存 -> 成功，修订号 +1
res = workflow.saveCueEdit("c2", { ...c2, translated: "As the tide recedes, the old pier emerges." });
assert.ok(res.ok, res.message);
assert.equal(get(store.stateStore).cueRevisions.c2, 2);

// 译员 A 提交审校 -> 占住 c2
res = workflow.submitForReview("c2", {});
assert.ok(res.ok, res.message);
assert.equal(get(store.stateStore).locks.find((l) => l.cueId === "c2")?.sessionId, "session-A");

// 旧标签页场景：A 持 v1 凭据（在 B 操作前记录，真实环境中两标签页凭据互不干扰）
const aCredential = store.getEditBase("c2");
assert.ok(aCredential);
assert.equal(aCredential.releaseId, v1Id);

// 译员 B（另一个会话/旧标签页）也改了 c2 并提交 -> 被占用拦截，进入待合并
store.sessionId.set("session-B");
store.identity.set({ name: "周野", role: "译员" });
res = workflow.submitForReview("c2", { translated: "When tides pull back, pier reappears slowly." });
assert.equal(res.ok, false);
const pendingB = get(store.stateStore).pendingMerges.find((p) => p.status === "待合并" && p.proposerSessionId === "session-B");
assert.ok(pendingB, "后提交者的改动应进入待合并");
assert.equal(pendingB.reason, "锁占用");
// 审校译文未被覆盖
assert.equal(get(store.stateStore).cues.find((c) => c.id === "c2").translated, "As the tide recedes, the old pier emerges.");

// B 按最新内容合并 -> 三方裁决，字幕重新进入审校，占用释放
res = workflow.resolveMergeProposal(pendingB.id, "merge");
assert.ok(res.ok, res.message);
const mergedCue = get(store.stateStore).cues.find((c) => c.id === "c2");
assert.equal(mergedCue.status, "待重审");
assert.equal(mergedCue.translated, "When tides pull back, pier reappears slowly.");
assert.equal(get(store.stateStore).locks.find((l) => l.cueId === "c2"), undefined);

// 撤回路径：再造一个待合并然后撤回
store.sessionId.set("session-B");
res = workflow.saveCueEdit("c2", { translated: "another attempt" });
assert.equal(res.ok, false);
const pendingB2 = get(store.stateStore).pendingMerges.find((p) => p.status === "待合并" && p.proposerSessionId === "session-B");
assert.ok(pendingB2);
res = workflow.resolveMergeProposal(pendingB2.id, "withdraw");
assert.ok(res.ok, res.message);
assert.equal(get(store.stateStore).pendingMerges.find((p) => p.id === pendingB2.id).status, "已撤回");

// 旧标签页场景：A 持 v1 凭据；制作人发布 v2 后，A 再保存被拒
store.sessionId.set("session-A");
store.identity.set({ name: "制作人-陈", role: "制作人" });
res = workflow.createRelease("交付 v2");
assert.ok(res.ok, res.message);
const v2Id = get(store.stateStore).currentReleaseId;
assert.notEqual(v1Id, v2Id);
// v1 仍可查看（冻结）
const v1 = get(store.stateStore).releases.find((r) => r.id === v1Id);
assert.ok(v1);
assert.equal(v1.cues.some((c) => c.id === "c2"), true);

store.identity.set({ name: "林岚", role: "译员" });
res = workflow.saveCueEdit("c2", { translated: "stale tab edit" });
assert.equal(res.ok, false);
assert.ok(/基线|版本/.test(res.message), res.message);
assert.ok(get(store.stateStore).pendingMerges.some((p) => p.status === "待合并" && p.reason === "基线已变"));
// 审校内容仍未被覆盖
assert.notEqual(get(store.stateStore).cues.find((c) => c.id === "c2").translated, "stale tab edit");

// 阻塞项里应出现被拒保存与待合并
assert.ok(get(workflow.blockers).some((b) => b.kind === "被拒保存"));
assert.ok(get(workflow.blockers).some((b) => b.kind === "待合并"));

// 术语锁定变化：锁定"加固"(g3) 命中 c3（待审/翻译中）。先把 c3 置为待审
store.stateStore.commit((s) => ({ ...s, cues: s.cues.map((c) => (c.id === "c3" ? { ...c, status: "待审" } : c)) }));
store.identity.set({ name: "顾宁", role: "审校" });
res = workflow.setTermLock("g3", true);
assert.ok(res.ok, res.message);
const c3 = get(store.stateStore).cues.find((c) => c.id === "c3");
assert.equal(c3.status, "待重审", "命中变更术语的待审字幕应重新进入审校");
assert.ok(get(workflow.blockers).some((b) => b.kind === "待重审" && b.cueId === "c3"));

// 译员无权锁定术语
store.identity.set({ name: "林岚", role: "译员" });
res = workflow.setTermLock("g1", false);
assert.equal(res.ok, false);

// 制作人才能改规则
res = workflow.setRuleEnabled("r2", false);
assert.equal(res.ok, false);
store.identity.set({ name: "制作人-陈", role: "制作人" });
res = workflow.setRuleEnabled("r2", false);
assert.ok(res.ok, res.message);

// 归档只读：查看 v1 时编辑被拒
store.viewingReleaseId.set(v1Id);
res = workflow.saveCueEdit("c2", { translated: "x" });
assert.equal(res.ok, false);
res = workflow.reviewCue("c2", true);
assert.equal(res.ok, false);
store.viewingReleaseId.set(null);

// 快照与冲突记录在整个流程后仍存在（先造一个快照和已处理冲突）
workflow.createSnapshot("流程内快照");
workflow.resolveConflict("x1", "采用本地");
state = get(store.stateStore);
assert.ok(state.snapshots.some((s) => s.name === "流程内快照"));
assert.ok(state.conflicts.some((c) => c.id === "x1"));

// 持久化：v2 数据已写入 localStorage，结构完整且包含历史版本
const persisted = JSON.parse(storage.get("pair-wise-yf-51/subtitles-v2"));
assert.equal(persisted.schemaVersion, 2);
assert.ok(persisted.releases.length >= 2);
assert.ok(persisted.cues.length >= 4);
assert.ok(persisted.conflicts.length >= 1);
assert.ok(persisted.pendingMerges.some((p) => p.status === "已撤回"));

console.log("workflow e2e tests passed");
