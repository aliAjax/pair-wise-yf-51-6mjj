<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { evaluateRules } from "$lib/versioning/review";
  import {
    ACTORS,
    activeCues,
    activeTrackId,
    blockers,
    conflicts,
    createRelease,
    createSnapshot,
    cues,
    currentActor,
    currentVersion,
    dismissNotice,
    exportRelease,
    knownRevision,
    locks,
    mergeNext,
    notices,
    nudgeCue,
    pendingMerges,
    releases,
    resolveConflict,
    resolvePendingMerge,
    restoreSnapshot,
    reviewCue,
    reviewEvents,
    revision,
    rules,
    selectedCueId,
    setCueStatus,
    setTermLocked,
    snapshots,
    splitCue,
    syncBaseline,
    terms,
    tracks,
    updateCue,
    viewingRelease,
    viewingReleaseId,
    addCue,
    releaseCueLock
  } from "$lib/stores/subtitles";
  import type { Cue } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      addCue({
        trackId: $activeTrackId,
        start,
        end: start + Number(formData.get("duration") ?? 2.5),
        source: String(formData.get("source") ?? ""),
        translated: String(formData.get("translated") ?? ""),
        status: "翻译中",
        translator: $currentActor.name
      });
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  let reviewNote = $state("");

  const stale = $derived($knownRevision < $revision);
  const lockByCue = $derived(new Map($locks.map((lock) => [lock.cueId, lock])));
  const mergeByCue = $derived(new Map($pendingMerges.filter((item) => item.status === "待处理").map((item) => [item.cueId, item])));
  const selectedHints = $derived(selected ? evaluateRules(selected, $rules, $terms) : []);
  const isProducer = $derived($currentActor.role === "producer");
  const frozenTrackCues = $derived(
    $viewingRelease ? [...$viewingRelease.cues].filter((cue) => cue.trackId === exportTrackId).sort((a, b) => a.start - b.start) : []
  );
  // 切换选中字幕时，审校备注预填为该字幕的受保护备注（编辑译文不重置）
  $effect(() => {
    const id = $selectedCueId;
    reviewNote = get(cues).find((cue) => cue.id === id)?.reviewerNote ?? "";
  });
  let releaseLevel = $state("patch");
  let releaseNote = $state("");
  let exportTrackId = $state("en");

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  function cueById(id: string) {
    return $cues.find((cue) => cue.id === id);
  }

  function publish() {
    createRelease(releaseLevel, releaseNote);
    releaseNote = "";
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本交付</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header>
      <div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>制作人冻结发布版本，译员凭版本凭据提交，审校内容受基线保护。</p></div>
      <div class="header-actions">
        <select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select>
        <select value={$currentActor.id} onchange={(event) => currentActor.set(ACTORS.find((actor) => actor.id === event.currentTarget.value) ?? $currentActor)}>
          {#each ACTORS as actor}<option value={actor.id}>{actor.name}</option>{/each}
        </select>
        <button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button>
      </div>
    </header>

    <!-- 当前版本与凭据基线 -->
    <section class="version-bar">
      <div class="version-id">
        <span class="ver-badge">{$currentVersion}</span>
        <span>当前基线 <b>r{$revision}</b></span>
        <span class:stale={stale}>本页凭据 <b>r{$knownRevision}</b>{#if stale}（已落后）{/if}</span>
        <span>身份：{$currentActor.name}</span>
      </div>
      {#if stale}
        <div class="stale-banner">
          <b>基线已变：</b>本标签页仍基于旧凭据 r{$knownRevision}，直接保存不会覆盖审校内容，修改将退回“待合并”。
          <button class="btn btn-sm variant-filled-primary" onclick={syncBaseline}>同步到 r{$revision} 后继续</button>
        </div>
      {/if}
    </section>

    <!-- 通知 -->
    {#each $notices as notice (notice.id)}
      <div class={`notice ${notice.tone}`}><span>{notice.text}</span><button class="btn btn-sm" onclick={() => dismissNotice(notice.id)}>×</button></div>
    {/each}

    <!-- 阻塞项 -->
    {#if $blockers.length}
      <section class="panel blockers">
        <div class="panel-head"><h2>阻塞项（{$blockers.length}）</h2><small>硬阻塞会拦截发布；提示项需在新一轮基线处理</small></div>
        <ul>
          {#each $blockers as blocker (blocker.id)}
            <li class={blocker.severity}>
              <b>{blocker.severity === "hard" ? "硬阻塞" : "提示"}</b>
              <span>{blocker.message}</span>
              {#if blocker.cueId}<button class="btn btn-sm" onclick={() => selectedCueId.set(blocker.cueId!)}>定位字幕</button>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- 制作人发布 -->
    <section class="panel release-bar">
      <div class="panel-head"><h2>版本化交付</h2><small>制作人建立发布版本，冻结当次各语言轨道、术语和审校规则；已发布版本持续可查看、可导出</small></div>
      {#if isProducer}
        <div class="release-form">
          <select bind:value={releaseLevel}><option value="patch">补丁发布</option><option value="minor">次要版本</option><option value="major">主版本</option></select>
          <input class="input" bind:value={releaseNote} placeholder="本次交付说明，如：第 3 集终审交付" />
          <button class="btn variant-filled-primary" onclick={publish} disabled={$blockers.some((item) => item.severity === "hard")}>建立发布版本</button>
        </div>
      {:else}
        <p class="muted">仅制作人可发布；当前身份为{$currentActor.name}，可继续编辑与提交审校。</p>
      {/if}
    </section>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article><article><span>待合并</span><b>{$pendingMerges.filter((item) => item.status === "待处理").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>修改携带版本凭据；他人占用或基线落后时自动退回待合并</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              {@const lock = lockByCue.get(cue.id)}
              {@const pending = mergeByCue.get(cue.id)}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>{#if cue.reviewerNote}<small class="review-note">审校备注：{cue.reviewerNote}</small>{/if}</div>
                <div class="cue-tags"><span class={`chip ${cue.status}`}>{cue.status}</span><span class="chip rev">r{cue.cueRevision ?? 0}</span>{#if lock}<span class="chip lock">🔒 {lock.holder}</span>{/if}{#if pending}<span class="chip pending">待合并</span>{/if}</div>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status} · r{selected.cueRevision ?? 0}</span>{/if}</div>
          {#if selected}
            {@const lock = lockByCue.get(selected.id)}
            {#if lock}
              <p class="lock-note">🔒 先提交者 {lock.holder} 占住此字幕（自 {new Date(lock.since).toLocaleTimeString("zh-CN")}）。其他标签页保存将退回待合并。
                {#if lock.holder === $currentActor.name}<button class="btn btn-sm" onclick={() => releaseCueLock(selected.id)}>释放占用</button>{/if}
              </p>
            {/if}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            {#if selectedHints.length}<ul class="rule-hints">{#each selectedHints as hint}<li>{hint}</li>{/each}</ul>{/if}
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注（受版本保护，编辑不会覆盖）</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定变化让待审/已通过字幕重入审校；已发布版本冻结不变</small></div>
          {#each $terms as term}
            <div class="term">
              <span><b>{term.source}</b> → {term.target} {#if term.lockedRevision}<small>（锁定于 r{term.lockedRevision}）</small>{/if}</span>
              {#if term.status === "已锁定"}
                <button class="btn btn-sm" onclick={() => setTermLocked(term.id, false)}>解除锁定</button>
              {:else}
                <button class="btn btn-sm variant-filled-primary" onclick={() => setTermLocked(term.id, true)}>锁定</button>
              {/if}
            </div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>待合并队列</h2><small>旧基线修改不能覆盖审校内容，后提交者按最新内容合并或撤回</small></div>
          {#each $pendingMerges as merge (merge.id)}
            {@const cue = cueById(merge.cueId)}
            <article class="conflict">
              <b>{merge.actor} 的修改 · 基于 r{merge.baseRevision}</b>
              <p>{merge.reason}</p>
              {#if cue}
                <p class="diff-line"><span>最新译文：</span>{cue.translated}</p>
                <p class="diff-line"><span>待合并译文：</span>{merge.incoming.translated}</p>
              {/if}
              {#if merge.status === "待处理"}
                <div class="actions"><button class="btn btn-sm variant-filled-primary" onclick={() => resolvePendingMerge(merge.id, "merge")}>按最新内容合并</button><button class="btn btn-sm" onclick={() => resolvePendingMerge(merge.id, "withdraw")}>撤回</button></div>
              {:else}
                <span class="chip">{merge.status === "已合并" ? "已合并（需重新审校）" : "已撤回"}</span>
              {/if}
            </article>
          {/each}
          {#if !$pendingMerges.length}<p class="muted">暂无退回待合并的修改。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2></div>
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2></div><div class="events">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · r{item.revision} · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>

    <!-- 已发布版本：继续查看与导出 -->
    <section class="panel releases">
      <div class="panel-head"><h2>已发布版本</h2><small>冻结当次各语言轨道、术语和审校规则；后续术语锁定不影响这些版本</small></div>
      {#if !$releases.length}<p class="muted">尚未建立发布版本。</p>{/if}
      <div class="release-list">
        {#each $releases as release (release.id)}
          <article class="release-card">
            <div class="release-head"><b>{release.label}</b><span class="chip">r{release.revision}</span></div>
            <p>{release.note}</p>
            <small>{release.creator} · {new Date(release.createdAt).toLocaleString("zh-CN")}</small>
            <p class="muted">{release.tracks.length} 条轨道 · {release.cues.length} 条字幕 · {release.terms.filter((term) => term.status === "已锁定").length} 条锁定术语 · {release.rules.length} 条审校规则</p>
            <div class="actions">
              <button class="btn btn-sm" onclick={() => viewingReleaseId.set($viewingRelease?.id === release.id ? null : release.id)}>{$viewingRelease?.id === release.id ? "收起" : "查看冻结内容"}</button>
              <select bind:value={exportTrackId}>{#each release.tracks as track}<option value={track.id}>{track.name}</option>{/each}</select>
              <button class="btn btn-sm variant-filled-primary" onclick={() => exportRelease(release.id, exportTrackId)}>导出 SRT</button>
            </div>
            {#if $viewingRelease?.id === release.id}
              <div class="frozen">
                <h3>冻结字幕（{exportTrackId}）</h3>
                <div class="frozen-list">
                  {#each frozenTrackCues as cue}
                    <div class="frozen-cue"><time>{formatTime(cue.start)}–{formatTime(cue.end)}</time><span>{cue.translated}</span><em class={`chip ${cue.status}`}>{cue.status}</em></div>
                  {/each}
                </div>
                <h3>冻结术语</h3>
                <p class="muted">{#each release.terms.filter((term) => term.status === "已锁定") as term}<span class="chip">{term.source} → {term.target}</span> {/each}</p>
                <h3>冻结审校规则</h3>
                <ul class="frozen-rules">{#each release.rules as rule}<li><b>{rule.name}</b>（{rule.enabled ? "启用" : "停用"}）：{rule.description}</li>{/each}</ul>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    </section>
  </main>
</div>
