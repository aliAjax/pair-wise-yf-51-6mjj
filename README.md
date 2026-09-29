# pair-wise-yf-51 多语言字幕翻译和时间轴协作编辑器

源提示词摘要：制作人建立原语言和多语言字幕轨，译员拆分、合并、移动字幕并维护时间码，审校人员处理术语、超长文本、上下文备注和冲突版本；系统提供术语锁定、审校退回、版本快照、键盘连续操作和导出预览。

## 版本化交付流程

- **发布版本（制作人）**：冻结当次各语言轨道、术语与审校规则，生成只读基线；历史版本可继续查看、按轨导出 SRT。
- **版本凭据**：打开字幕时登记「发布版本 + 修订号 + 原文/译文基线」；保存必须携带凭据。旧标签页在新版本发布后保存会提示「基线已变」，改动只能退回待合并，不能覆盖审校结果。
- **并发占用**：两名译员同时改同一字幕，先提交审校者占住；后提交者的改动进入「待合并」，可按最新内容三方合并（只覆盖自己实际改过的字段）或撤回，合并后重新进入审校。
- **术语联动**：术语锁定/解锁后，命中该术语的待审字幕回到「待重审」；已发布版本中的术语冻结不变。
- **阻塞项**：页面顶部汇总旧基线保存、占用、待合并、待重审与历史版本只读等阻塞项，并显示当前版本。
- **旧数据升级**：v1 localStorage 数据自动迁移到 v2，字幕、快照、审校记录与冲突记录原样保留。

## 分层结构（分别承接）

| 关注点 | 位置 |
| --- | --- |
| 版本规则（发布、凭据、占用、合并、阻塞项、SRT） | `src/lib/version/model.ts`（纯逻辑） |
| 持久化与迁移（v1→v2、跨标签页同步） | `src/lib/version/persistence.ts` |
| 审校流程（受保护写操作、待合并、重审） | `src/lib/review/workflow.ts` |
| 页面展示（时间轴、编辑器、版本、术语、规则、阻塞项） | `src/routes/+page.svelte`、`src/lib/components/*.svelte` |

## 本地验证

```bash
npm install
npm run check        # 类型检查
npm run build        # 生产构建
node scripts/esbuild-test.mjs scripts/verify-rules.mjs scripts/verify-rules.bundle.mjs && node scripts/verify-rules.bundle.mjs
node scripts/esbuild-test.mjs scripts/verify-workflow.mjs scripts/verify-workflow.bundle.mjs && node scripts/verify-workflow.bundle.mjs
node scripts/esbuild-test.mjs scripts/verify-migration.mjs scripts/verify-migration.bundle.mjs && node scripts/verify-migration.bundle.mjs
```

## 技术栈

SvelteKit、TypeScript、Skeleton UI、Svelte stores、TanStack Query、Superforms、Zod、Paraglide。

## 本地运行

```bash
npm install
npm run dev
npm run build
```

开发端口：62016
