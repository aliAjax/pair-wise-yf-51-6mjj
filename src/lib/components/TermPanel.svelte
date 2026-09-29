<script lang="ts">
  import { identity, stateStore, terms } from "$lib/stores/subtitles";
  import { setTermLock } from "$lib/review/workflow";
</script>

<section class="panel">
  <div class="panel-head">
    <div>
      <h2>术语锁定</h2>
      <small>锁定状态变化后，命中该术语的待审字幕会回到「待重审」；已发布版本中的术语冻结不变。</small>
    </div>
    <span class="chip">术语基线 第 {$stateStore.termRevision} 版</span>
  </div>
  {#each $terms as term (term.id)}
    <div class="term">
      <span><b>{term.source}</b> → {term.target}<small class="hint"> · {term.owner}</small></span>
      <div class="actions">
        {#if term.status === "已锁定"}
          <button class="btn btn-sm variant-filled-success" disabled={$identity.role === "译员"} onclick={() => setTermLock(term.id, false)}>已锁定 · 解锁</button>
        {:else}
          <button class="btn btn-sm" disabled={$identity.role === "译员"} onclick={() => setTermLock(term.id, true)}>建议 · 锁定</button>
        {/if}
      </div>
    </div>
  {/each}
  {#if $identity.role === "译员"}<small class="hint">译员角色仅可查看术语，锁定/解锁请切换到审校或制作人。</small>{/if}
</section>
