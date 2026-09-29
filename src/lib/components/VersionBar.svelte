<script lang="ts">
  import { currentReleaseId, identity, releases, tracks, viewingReleaseId } from "$lib/stores/subtitles";
  import { createRelease } from "$lib/review/workflow";
  import { buildTrackSrt } from "$lib/version/model";

  let releaseName = $state("");
  let toast = $state<{ ok: boolean; message: string } | null>(null);

  function publish() {
    const result = createRelease(releaseName);
    toast = { ok: result.ok, message: result.message };
    if (result.ok) {
      releaseName = "";
      viewingReleaseId.set(null);
    }
    setTimeout(() => (toast = null), 4000);
  }

  function openRelease(id: string) {
    viewingReleaseId.set(id);
  }

  function backToCurrent() {
    viewingReleaseId.set(null);
  }

  function exportSrt(releaseId: string, trackId: string) {
    const release = $releases.find((item) => item.id === releaseId);
    if (!release) return;
    const track = release.tracks.find((item) => item.id === trackId);
    const content = buildTrackSrt(release.cues, trackId);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${release.name}-${track?.name ?? trackId}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<section class="panel version-panel">
  <div class="panel-head">
    <div>
      <h2>发布版本与冻结基线</h2>
      <small>制作人发布后冻结各语言轨、术语与审校规则；旧标签页再保存会被拦截。</small>
    </div>
    {#if $currentReleaseId}
      <span class="chip 已通过">当前版本 {($releases.find((r) => r.id === $currentReleaseId)?.name) ?? ""}</span>
    {:else}
      <span class="chip">尚未发布</span>
    {/if}
  </div>

  <div class="publish-row">
    <input class="input" bind:value={releaseName} placeholder="交付版本名称（可留空自动编号）" />
    <button class="btn variant-filled-primary" disabled={$identity.role !== "制作人"} onclick={publish}>建立发布版本</button>
  </div>
  {#if $identity.role !== "制作人"}<small class="hint">当前身份「{$identity.role}」不可发布，切换为制作人后操作。</small>{/if}
  {#if toast}<p class="toast">{toast.message}</p>{/if}

  <div class="release-list">
    {#each $releases as release (release.id)}
      <article class:current={release.id === $currentReleaseId} class:viewing={$viewingReleaseId === release.id}>
        <div>
          <b>{release.name}</b>
          {#if release.id === $currentReleaseId}<span class="chip 已通过">当前基线</span>{/if}
          {#if $viewingReleaseId === release.id}<span class="chip 待审">查看中（只读）</span>{/if}
          <p>{new Date(release.createdAt).toLocaleString("zh-CN")} · {release.createdBy}</p>
          <small>{release.cues.length} 条字幕 · {release.terms.length} 条术语 · {release.rules.filter((r) => r.enabled).length}/{release.rules.length} 规则启用</small>
        </div>
        <div class="actions">
          {#if $viewingReleaseId === release.id}
            <button class="btn btn-sm" onclick={backToCurrent}>返回当前编辑</button>
          {:else}
            <button class="btn btn-sm" onclick={() => openRelease(release.id)}>查看冻结版本</button>
          {/if}
          <select class="btn btn-sm" aria-label="选择导出轨道" onchange={(event) => { const value = event.currentTarget.value; event.currentTarget.selectedIndex = 0; if (value) exportSrt(release.id, value); }}>
            <option value="">导出 SRT…</option>
            {#each release.tracks as track}
              <option value={track.id}>{track.name}</option>
            {/each}
          </select>
        </div>
      </article>
    {/each}
    {#if !$releases.length}<p class="hint">还没有发布版本。发布前的字幕仅存在于工作基线，保存快照可手动留存。</p>{/if}
  </div>
</section>
