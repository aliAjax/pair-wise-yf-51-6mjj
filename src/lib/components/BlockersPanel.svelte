<script lang="ts">
  import { blockers } from "$lib/review/workflow";
  import { dismissBlockedSave, selectedCueId } from "$lib/stores/subtitles";
</script>

<section class="panel blockers">
  <div class="panel-head">
    <div>
      <h2>阻塞项</h2>
      <small>处理完下列项目才能继续交付；点击可定位到相关字幕。</small>
    </div>
    <span class:warn={$blockers.length > 0} class="chip">{$blockers.length} 项</span>
  </div>
  {#if !$blockers.length}
    <p class="hint">没有阻塞项，可以继续编辑与交付。</p>
  {:else}
    <div class="blocker-list">
      {#each $blockers as blocker, index (blocker.saveId ?? blocker.kind + (blocker.cueId ?? index))}
        <article class={`blocker ${blocker.kind}`} role={blocker.cueId ? "button" : undefined} onclick={() => blocker.cueId && selectedCueId.set(blocker.cueId)}>
          <span class="blocker-kind">{blocker.kind}</span>
          <div>
            <b>{blocker.title}</b>
            <p>{blocker.detail}</p>
          </div>
          {#if blocker.saveId}
            <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); dismissBlockedSave(blocker.saveId!); }}>忽略提示</button>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>
