<script lang="ts">
  import { identity, rules, stateStore } from "$lib/stores/subtitles";
  import { setRuleEnabled } from "$lib/review/workflow";
</script>

<section class="panel">
  <div class="panel-head">
    <div>
      <h2>审校规则</h2>
      <small>规则随发布版本一起冻结；发布前由制作人调整，历史版本按当时规则查看与导出。</small>
    </div>
    <span class="chip">规则基线 第 {$stateStore.rulesRevision} 版</span>
  </div>
  {#each $rules as rule (rule.id)}
    <article class="rule">
      <div>
        <b>{rule.name}</b>
        <p>{rule.detail}</p>
        <small class="hint">更新于 {new Date(rule.updatedAt).toLocaleString("zh-CN")}</small>
      </div>
      <label class="switch">
        <input type="checkbox" checked={rule.enabled} disabled={$identity.role !== "制作人"} onchange={(event) => setRuleEnabled(rule.id, event.currentTarget.checked)} />
        <span>{rule.enabled ? "启用" : "停用"}</span>
      </label>
    </article>
  {/each}
</section>
