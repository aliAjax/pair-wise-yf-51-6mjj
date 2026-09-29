<script lang="ts">
  import { resolveMergeProposal } from "$lib/review/workflow";
  import { cues, pendingMerges, selectedCueId } from "$lib/stores/subtitles";

  function selectCue(cueId: string) {
    selectedCueId.set(cueId);
  }
</script>

<section class="panel">
  <div class="panel-head">
    <div>
      <h2>待合并改动</h2>
      <small>基线已变或字幕被占住时，本地改动保存在这里；只能按最新内容合并或撤回，不覆盖审校结果。</small>
    </div>
  </div>
  <div class="events">
    {#each $pendingMerges.filter((item) => item.status === "待合并") as proposal (proposal.id)}
      {@const cue = $cues.find((item) => item.id === proposal.cueId)}
      <article class="proposal">
        <div class="proposal-head">
          <span class={`chip ${proposal.reason === "锁占用" ? "退回" : "待审"}`}>{proposal.reason}</span>
          <b>{proposal.proposerName} 的改动</b>
          <small>{new Date(proposal.time).toLocaleString("zh-CN")}</small>
        </div>
        {#if cue}
          <button class="link-btn" onclick={() => selectCue(cue.id)}>定位字幕（当前状态：{cue.status}）</button>
        {/if}
        <dl class="patch">
          {#if proposal.patch.source !== undefined}<div><dt>原文</dt><dd>{proposal.patch.source}</dd></div>{/if}
          {#if proposal.patch.translated !== undefined}<div><dt>译文</dt><dd>{proposal.patch.translated}</dd></div>{/if}
          {#if proposal.patch.start !== undefined || proposal.patch.end !== undefined}
            <div><dt>时间码</dt><dd>{proposal.patch.start ?? cue?.start}s – {proposal.patch.end ?? cue?.end}s</dd></div>
          {/if}
        </dl>
        <small class="hint">基于第 {proposal.baseRevision} 版提交；合并采用三方裁决，只覆盖本地实际修改的字段并重新进入审校。</small>
        <div class="actions">
          <button class="btn btn-sm variant-filled-primary" onclick={() => resolveMergeProposal(proposal.id, "merge")}>按最新内容合并</button>
          <button class="btn btn-sm variant-filled-error" onclick={() => resolveMergeProposal(proposal.id, "withdraw")}>撤回改动</button>
        </div>
      </article>
    {/each}
    {#if !$pendingMerges.some((item) => item.status === "待合并")}
      <p class="hint">没有待处理的合并改动。</p>
    {/if}
  </div>
</section>
