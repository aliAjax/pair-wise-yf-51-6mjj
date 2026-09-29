import assert from "node:assert";

const storage = new Map();
// 模拟旧版应用留下的 v1 数据
const legacy = {
  tracks: [{ id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" }],
  cues: [
    { id: "legacy-cue-1", trackId: "zh", start: 0, end: 2, source: "历史字幕原文", translated: "历史字幕译文", status: "已通过", translator: "旧译员", reviewerNote: "旧审校意见" }
  ],
  terms: [{ id: "legacy-term", source: "旧术语", target: "legacy", status: "已锁定", owner: "旧管理员" }],
  events: [{ id: "e1", cueId: "legacy-cue-1", action: "审校通过", detail: "旧记录", actor: "旧审校", time: "2019-01-01T00:00:00.000Z" }],
  snapshots: [{ id: "legacy-snap", name: "交付前快照", time: "2019-02-01T00:00:00.000Z", cues: [] }]
};
storage.set("pair-wise-yf-51/subtitles-v1", JSON.stringify(legacy));

globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const store = await import("../src/lib/stores/subtitles.ts");
const { get } = await import("svelte/store");
const state = get(store.stateStore);

assert.equal(state.schemaVersion, 2);
// 字幕保留
assert.equal(state.cues[0].id, "legacy-cue-1");
assert.equal(state.cues[0].reviewerNote, "旧审校意见");
// 快照保留
assert.equal(state.snapshots[0].id, "legacy-snap");
// 审校记录保留
assert.equal(state.reviewEvents[0].id, "e1");
// 冲突记录：v1 没有存冲突，迁移补种子冲突记录（不丢失现有的初始协作冲突）
assert.ok(state.conflicts.length >= 1);
// 术语保留
assert.equal(state.terms[0].id, "legacy-term");
// 版本化字段补齐
assert.equal(state.cueRevisions["legacy-cue-1"], 1);
assert.equal(state.currentReleaseId, null);
assert.ok(Array.isArray(state.releases));
assert.ok(Array.isArray(state.locks));
assert.ok(Array.isArray(state.pendingMerges));
assert.ok(state.rules.length >= 1);
// v2 键已写入，v1 键仍在（不破坏旧数据）
assert.ok(storage.has("pair-wise-yf-51/subtitles-v2"));
assert.ok(storage.has("pair-wise-yf-51/subtitles-v1"));
// 再次加载直接命中 v2，不再重复迁移
const persistence = await import("../src/lib/version/persistence.ts");
const second = persistence.loadInitialState(state);
assert.equal(second.cues[0].id, "legacy-cue-1");

console.log("migration tests passed");
