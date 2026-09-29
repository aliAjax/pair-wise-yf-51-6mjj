<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import BlockersPanel from "$lib/components/BlockersPanel.svelte";
  import CueEditor from "$lib/components/CueEditor.svelte";
  import MergePanel from "$lib/components/MergePanel.svelte";
  import RulesPanel from "$lib/components/RulesPanel.svelte";
  import TermPanel from "$lib/components/TermPanel.svelte";
  import TimelinePanel from "$lib/components/TimelinePanel.svelte";
  import VersionBar from "$lib/components/VersionBar.svelte";
  import {
    activeCues,
    activeTrackId,
    conflicts,
    cues,
    identity,
    reviewEvents,
    selectedCueId,
    snapshots,
    terms,
    viewingReleaseId
  } from "$lib/stores/subtitles";
  import { addCue, createSnapshot, mergeNext, resolveConflict, restoreSnapshot, splitCue } from "$lib/review/workflow";
  import type { Cue } from "$lib/version/model";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = {
        id: crypto.randomUUID(),
        trackId: $activeTrackId,
        start,
        end: start + Number(formData.get("duration") ?? 2.5),
        source: String(formData.get("source") ?? ""),
        translated: String(formData.get("translated") ?? ""),
        status: "翻译中",
        translator: $identity.name,
        reviewerNote: ""
      };
      addCue(item);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ($viewingReleaseId) return;
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s" && $selectedCueId) splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m" && $selectedCueId) mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const pendingReviewCount = $derived($cues.filter((cue) => cue.status === "待审" || cue.status === "待重审").length);
</script>

<svelte:head><title>多语言字幕时间轴协作 · 版本化交付</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>发布版本</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header>
      <div>
        <small>纪录片《潮汐线》 · 第 3 集</small>
        <h1>{m.title()}</h1>
        <p>发布版本冻结语言轨、术语与审校规则；修改携带凭据，旧基线保存退回待合并，不覆盖审校结果。</p>
      </div>
      <div class="header-actions">
        <button onclick={() => setLocale("en")}>EN</button>
        <button onclick={() => setLocale("zh")}>中文</button>
      </div>
    </header>

    <section class="metrics">
      <article><span>当前身份</span><b>{$identity.role} · {$identity.name}</b></article>
      <article><span>字幕条数（当前轨）</span><b>{$activeCues.length}</b></article>
      <article><span>待审 / 待重审（全轨）</span><b>{pendingReviewCount}</b></article>
      <article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article>
    </section>

    <BlockersPanel />

    <div class="editor-grid">
      {#if $query.isPending}
        <section class="panel timeline"><p>正在加载字幕轨道…</p></section>
      {:else}
        <TimelinePanel {formatTime} />
      {/if}

      <aside class="right-stack">
        <CueEditor />
        <TermPanel />
      </aside>
    </div>

    <div class="merge-grid">
      <MergePanel />
      <section class="panel">
        <div class="panel-head"><h2>协作冲突</h2><small>冲突记录在数据升级时保留</small></div>
        {#each $conflicts as conflict (conflict.id)}
          <article class="conflict">
            <b>{conflict.message}</b>
            <p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p>
            <div class="actions">
              <button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button>
              <button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button>
              <span class="chip">{conflict.status}</span>
            </div>
          </article>
        {/each}
        {#if !$conflicts.length}<p class="hint">没有时间轴冲突。</p>{/if}
      </section>
    </div>

    <div class="bottom-grid">
      <VersionBar />
      <RulesPanel />
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
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head">
          <h2>版本快照</h2>
          <button class="btn btn-sm variant-filled-primary" disabled={!!$viewingReleaseId} onclick={() => createSnapshot()}>保存快照</button>
        </div>
        <div class="events">
          {#each $snapshots as item (item.id)}
            <article>
              <b>{item.name}</b>
              <p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p>
              <button class="btn btn-sm" disabled={!!$viewingReleaseId} onclick={() => restoreSnapshot(item.id)}>恢复（按新版本重新审校）</button>
            </article>
          {/each}
          {#if !$snapshots.length}<p class="hint">使用 ⌘S 或按钮创建快照，快照在旧数据升级后仍然保留。</p>{/if}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>审校记录</h2></div>
        <div class="events">
          {#each $reviewEvents as item (item.id)}
            <article>
              <b>{item.action}</b>
              <p>{item.detail}</p>
              <small>{item.actor} · {new Date(item.time).toLocaleString("zh-CN")}</small>
            </article>
          {/each}
          {#if !$reviewEvents.length}<p class="hint">暂无审校操作。</p>{/if}
        </div>
      </section>
    </div>
  </main>
</div>
