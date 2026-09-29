<script lang="ts">
  import {
    cues,
    currentReleaseId,
    cueRevision,
    getEditBase,
    identity,
    registerEditBase,
    selectedCueId,
    sessionId,
    stateStore,
    viewingReleaseId
  } from "$lib/stores/subtitles";
  import { reviewCue, saveCueEdit, submitForReview } from "$lib/review/workflow";
  import type { ActionResult } from "$lib/review/workflow";
  import { cueFingerprint } from "$lib/version/model";

  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  const readonly = $derived($viewingReleaseId !== null);

  let draftSource = $state("");
  let draftTranslated = $state("");
  let draftStart = $state(0);
  let draftEnd = $state(0);
  let registeredId = $state<string | null>(null);
  let toast = $state<{ ok: boolean; message: string } | null>(null);

  let reviewNote = $state("");

  function syncDraft() {
    if (!selected) return;
    draftSource = selected.source;
    draftTranslated = selected.translated;
    draftStart = selected.start;
    draftEnd = selected.end;
    reviewNote = selected.reviewerNote ?? "";
  }

  // 选中字幕时登记本标签页的编辑基线（版本凭据），后续保存据此校验。
  // 仅在切换字幕时登记；协作方更新不改写基线，以便提示“基线已变”。
  $effect(() => {
    const cue = selected;
    if (!cue) {
      registeredId = null;
      return;
    }
    if (registeredId !== cue.id) {
      registerEditBase(cue, $currentReleaseId);
      registeredId = cue.id;
      syncDraft();
    }
  });

  const credential = $derived(selected ? getEditBase(selected.id) : undefined);
  const latestRevision = $derived(selected ? cueRevision(selected.id) : 0);
  const stale = $derived(!!selected && !!credential && credential.baseRevision !== latestRevision);
  const lock = $derived(selected ? $stateStore.locks.find((item) => item.cueId === selected.id) : undefined);
  const lockedByOther = $derived(!!lock && lock.sessionId !== $sessionId);
  const heldByMe = $derived(!!lock && lock.sessionId === $sessionId);

  const dirty = $derived.by(() => {
    if (!selected || !credential) return false;
    const contentChanged =
      cueFingerprint({ source: draftSource, translated: draftTranslated }) !==
      cueFingerprint({ source: credential.originalSource, translated: credential.originalTranslated });
    return contentChanged || draftStart !== selected.start || draftEnd !== selected.end;
  });

  function patch() {
    if (!selected) return {};
    return {
      source: draftSource,
      translated: draftTranslated,
      start: Number(draftStart),
      end: Number(draftEnd)
    };
  }

  function rebase() {
    if (!selected) return;
    registerEditBase(selected, $currentReleaseId);
    syncDraft();
    showToast({ ok: true, message: "已切换到最新基线，请在此版本上重新修改。" });
  }

  function showToast(result: ActionResult) {
    toast = { ok: result.ok, message: result.message };
    setTimeout(() => (toast = null), 5000);
  }

  function save() {
    if (!selected) return;
    const result = saveCueEdit(selected.id, patch());
    showToast(result);
    if (result.ok) syncDraft();
  }

  function submit() {
    if (!selected) return;
    const result = submitForReview(selected.id, patch());
    showToast(result);
    if (result.ok) syncDraft();
  }

  function approve() {
    if (!selected) return;
    showToast(reviewCue(selected.id, true));
  }

  function reject() {
    if (!selected) return;
    showToast(reviewCue(selected.id, false, reviewNote || "请核对术语和断句"));
  }
</script>

<section class="panel">
  <div class="panel-head">
    <h2>字幕编辑</h2>
    {#if selected}
      <div class="badge-stack">
        <span class={`chip ${selected.status}`}>{selected.status}</span>
        {#if heldByMe}<span class="chip 待审">我已占住</span>{/if}
        {#if lockedByOther}<span class="chip 退回">{lock?.userName} 占住中</span>{/if}
      </div>
    {/if}
  </div>

  {#if !selected}
    <p>请先选择一条字幕。</p>
  {:else if readonly}
    <div class="readonly-box">
      <b>只读归档</b>
      <p>正在查看已发布的冻结版本，内容可核对、可导出，不能修改。返回当前编辑后再改。</p>
      <div class="label"><span>原文</span><div class="readonly-text">{selected.source}</div></div>
      <div class="label"><span>译文</span><div class="readonly-text">{selected.translated}</div></div>
      <p class="hint">{selected.start}s – {selected.end}s · 状态 {selected.status}</p>
    </div>
  {:else}
    {#if stale}
      <div class="banner warn">
        <b>基线已变</b>
        <p>你基于第 {credential?.baseRevision} 版打开此字幕，最新为第 {latestRevision} 版。直接保存会被退回待合并，不能覆盖审校内容。</p>
        <button class="btn btn-sm variant-filled-primary" onclick={rebase}>载入最新内容并在此基础上改</button>
      </div>
    {/if}
    {#if lockedByOther}
      <div class="banner lock">
        <b>字幕已被占住</b>
        <p>{lock?.userName} 已先提交审校，保存只会转入待合并，由对方按最新内容裁决。</p>
      </div>
    {/if}
    {#if toast}
      <div class={`banner ${toast.ok ? "ok" : "warn"}`}><p>{toast.message}</p></div>
    {/if}

    <label class="label"><span>原文字幕</span><textarea class="textarea" rows="2" bind:value={draftSource}></textarea></label>
    <label class="label"><span>译文</span><textarea class="textarea" rows="3" bind:value={draftTranslated}></textarea></label>
    <div class="time-fields">
      <label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" bind:value={draftStart} /></label>
      <label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" bind:value={draftEnd} /></label>
    </div>

    <div class="credential-line">
      <span class="hint">凭据：{credential?.releaseId ? "发布版本内" : "工作基线"} · 第 {credential?.baseRevision ?? latestRevision} 版</span>
      {#if dirty}<span class="chip 待审">有未保存改动</span>{/if}
    </div>

    <div class="actions">
      <button class="btn" disabled={!dirty} onclick={save}>携带凭据保存</button>
      <button class="btn variant-filled-primary" disabled={lockedByOther} onclick={submit}>提交审校（占住）</button>
      <button class="btn variant-filled-success" disabled={$identity.role === "译员"} onclick={approve}>审校通过</button>
      <button class="btn variant-filled-error" disabled={$identity.role === "译员"} onclick={reject}>退回修改</button>
    </div>
    <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
    {#if selected.reviewerNote}<p class="hint reviewer-note">审校意见：{selected.reviewerNote}</p>{/if}
  {/if}
</section>
