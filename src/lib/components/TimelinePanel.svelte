<script lang="ts">
  import { activeCues, activeTrackId, currentReleaseId, identity, releases, selectedCueId, stateStore, tracks, viewingReleaseId } from "$lib/stores/subtitles";
  import { nudgeCue } from "$lib/review/workflow";
  import { buildTrackSrt } from "$lib/version/model";
  import type { Role } from "$lib/version/model";

  let { formatTime }: { formatTime: (value: number) => string } = $props();

  const roles: Role[] = ["制作人", "译员", "审校"];
  const currentRelease = $derived($releases.find((release) => release.id === $currentReleaseId) ?? null);

  function exportCurrentTrack() {
    const content = buildTrackSrt($stateStore.cues, $activeTrackId);
    const track = $tracks.find((item) => item.id === $activeTrackId);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${currentRelease ? currentRelease.name + "-" : ""}${track?.name ?? $activeTrackId}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<section class="panel timeline">
  <div class="panel-head">
    <div>
      <h2>时间轴</h2>
      <small>
        {$viewingReleaseId ? "只读查看冻结版本" : "修改必须携带版本凭据，基线变化会被拦截并退回待合并"}
      </small>
    </div>
    <div class="actions">
      <button class="btn btn-sm" onclick={exportCurrentTrack}>导出当前轨道 SRT</button>
    </div>
  </div>

  <div class="timeline-meta">
    <label class="inline-label"><span>身份</span>
      <input class="input input-sm" value={$identity.name} oninput={(event) => identity.update((value) => ({ ...value, name: event.currentTarget.value || "未署名" }))} />
    </label>
    <label class="inline-label"><span>角色</span>
      <select class="input input-sm" value={$identity.role} onchange={(event) => identity.update((value) => ({ ...value, role: event.currentTarget.value as Role }))}>
        {#each roles as role}<option value={role}>{role}</option>{/each}
      </select>
    </label>
    <label class="inline-label"><span>语言轨</span>
      <select class="input input-sm" value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>
        {#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}
      </select>
    </label>
    <span class="chip">基线：{currentRelease ? currentRelease.name : "未发布工作基线"}</span>
  </div>

  <div class="cue-list">
    {#each $activeCues as cue (cue.id)}
      <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
        <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
        <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p></div>
        <span class={`chip ${cue.status}`}>{cue.status}</span>
        <button class="btn btn-sm" disabled={!!$viewingReleaseId} onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
        <button class="btn btn-sm" disabled={!!$viewingReleaseId} onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
      </div>
    {/each}
  </div>
</section>
