import assert from "node:assert";
import { checkCredential, mergePatch, termTouchesCue, computeBlockers, buildTrackSrt } from "../src/lib/version/model.ts";
import { migrateLegacy } from "../src/lib/version/persistence.ts";

let state = {
  schemaVersion: 2,
  currentReleaseId: "rel-2",
  releases: [],
  tracks: [],
  cues: [
    { id: "c1", trackId: "en", start: 0, end: 2, source: "潮汐退去", translated: "tide recedes", status: "待审", translator: "A", reviewerNote: "" },
    { id: "c2", trackId: "en", start: 3, end: 5, source: "加固", translated: "reinforce now", status: "已通过", translator: "B", reviewerNote: "保持术语" }
  ],
  terms: [],
  reviewEvents: [],
  snapshots: [],
  conflicts: [],
  rules: [],
  locks: [],
  pendingMerges: [],
  cueRevisions: { c1: 3, c2: 1 },
  termRevision: 1,
  rulesRevision: 1
};

// 1. 旧标签页凭据（旧 release）必须被拒
const cue1 = state.cues[0];
let r = checkCredential(state, { releaseId: "rel-1", baseRevision: 3, originalSource: cue1.source, originalTranslated: cue1.translated }, cue1);
assert.equal(r.ok, false);
assert.equal(r.kind, "非当前版本");

// 2. 修订号过期必须被拒
r = checkCredential(state, { releaseId: "rel-2", baseRevision: 2, originalSource: cue1.source, originalTranslated: cue1.translated }, cue1);
assert.equal(r.ok, false);
assert.equal(r.kind, "修订过期");

// 3. 内容已变必须被拒
r = checkCredential(state, { releaseId: "rel-2", baseRevision: 3, originalSource: "旧原文", originalTranslated: cue1.translated }, cue1);
assert.equal(r.ok, false);
assert.equal(r.kind, "内容已变");

// 4. 凭据一致通过
r = checkCredential(state, { releaseId: "rel-2", baseRevision: 3, originalSource: cue1.source, originalTranslated: cue1.translated }, cue1);
assert.equal(r.ok, true);

// 5. 缺凭据被拒
r = checkCredential(state, undefined, cue1);
assert.equal(r.ok, false);

// 6. 三方合并：只覆盖译员实际改过的字段，保留审校对译文的修改
const cue2 = state.cues[1];
const proposal = {
  baseSource: "加固",
  baseTranslated: "reinforce",
  patch: { source: "加固（旧）", translated: cue2.translated, start: 4, end: 5 }
};
const merged = mergePatch(proposal, cue2);
// 译文与最新值一致不带回；原文与 start 是译员显式改动，按补丁合并
assert.deepEqual(merged, { source: "加固（旧）", start: 4 });
assert.equal(merged.translated, undefined);
assert.equal(merged.end, undefined);

// 7. 合并时审校方把译文改了、译员也改了译文 -> 采用译员补丁（显式改动）
const merged2 = mergePatch(
  { baseSource: "s", baseTranslated: "old translation", patch: { translated: "my new translation" } },
  { source: "s", translated: "reviewer edited", start: 0, end: 1 }
);
assert.deepEqual(merged2, { translated: "my new translation" });

// 8. 术语命中：原文包含 source 或译文包含 target
assert.equal(termTouchesCue({ source: "潮汐", target: "tide" }, { source: "潮汐退去", translated: "the tide" }), true);
assert.equal(termTouchesCue({ source: "码头", target: "pier" }, { source: "潮汐", translated: "tide" }), false);

// 9. 阻塞项：被拒保存 + 占用 + 待合并 + 待重审
state.cues[0] = { ...cue1, status: "待重审" };
state.locks = [{ cueId: "c2", sessionId: "other", userName: "译员B", since: "", releaseId: "rel-2" }];
state.pendingMerges = [{ id: "p1", cueId: "c2", trackId: "en", proposerSessionId: "me", proposerName: "译员A", baseReleaseId: "rel-1", baseRevision: 1, baseSource: "", baseTranslated: "", patch: {}, reason: "基线已变", status: "待合并", time: "" }];
const blockers = computeBlockers({
  state,
  blockedSaves: [{ id: "b1", cueId: "c1", releaseId: "rel-1", baseRevision: 2, latestRevision: 3, reason: "非当前版本", message: "基线已变", time: "" }],
  sessionId: "me",
  viewingReleaseId: null
});
const kinds = blockers.map((b) => b.kind);
assert.ok(kinds.includes("被拒保存"));
assert.ok(kinds.includes("锁占用"));
assert.ok(kinds.includes("待合并"));
assert.ok(kinds.includes("待重审"));

// 10. 查看历史版本时出现版本阻塞
const blockers2 = computeBlockers({ state, blockedSaves: [], sessionId: "me", viewingReleaseId: "rel-1" });
assert.ok(blockers2.some((b) => b.kind === "版本发布"));

// 11. SRT 导出格式
const srt = buildTrackSrt(state.cues, "en");
assert.ok(srt.includes("00:00:00,000 --> 00:00:02,000"));
assert.ok(srt.includes("tide recedes"));

// 12. 旧数据迁移：字幕、快照、冲突保留，新字段补齐
const legacy = {
  tracks: [{ id: "zh", name: "中文", locale: "zh", status: "已通过" }],
  cues: [{ id: "old1", trackId: "zh", start: 0, end: 1, source: "旧", translated: "旧", status: "已通过", translator: "", reviewerNote: "" }],
  terms: [{ id: "t1", source: "a", target: "b", status: "建议", owner: "" }],
  events: [],
  snapshots: [{ id: "s1", name: "旧快照", time: "2020-01-01T00:00:00.000Z", cues: [] }]
};
const migrated = migrateLegacy(legacy, [{ id: "x1", cueId: "old1", message: "冲突保留", remoteStart: 0, remoteEnd: 1, status: "待处理" }]);
assert.equal(migrated.schemaVersion, 2);
assert.equal(migrated.cues[0].id, "old1");
assert.equal(migrated.snapshots[0].id, "s1");
assert.equal(migrated.conflicts[0].id, "x1");
assert.equal(migrated.cueRevisions.old1, 1);
assert.equal(migrated.currentReleaseId, null);
assert.ok(migrated.rules.length >= 1);

console.log("all rule tests passed");
