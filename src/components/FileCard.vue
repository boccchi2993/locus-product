<template>
  <!-- File card for a `sandbox:` link in a message or a task-output row.
       The card mounts BEFORE the VFS stat resolves (state="checking") and
       then settles: an existing regular file shows name/size + actions, a
       missing path degrades to the grey, non-clickable 文件不存在 line.
       Everything dynamic is text interpolation — the path in the title
       attribute arrives through Vue's attribute binding, never v-html. -->
  <span
    v-if="status === 'missing'"
    class="file-card file-card-missing"
    :data-testid="'file-missing-' + testId"
  >
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
      <path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/>
      <path d="M9.5 1.5V5H13"/>
      <path d="m5.5 8 5 5m0-5-5 5"/>
    </svg>
    <span class="file-card-missing-text">文件不存在:{{ path }}</span>
  </span>
  <span v-else class="file-card" :data-state="status" :data-testid="'file-card-' + testId">
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
      <path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/>
      <path d="M9.5 1.5V5H13"/>
      <path d="M5.5 9h5m-5 2.5h5"/>
    </svg>
    <span class="file-card-name" :title="path">{{ name }}</span>
    <span v-if="status === 'ok' && size !== null" class="file-card-size">{{ humanSize(size) }}</span>
    <button
      v-if="canDownload"
      class="rail-btn file-card-btn"
      type="button"
      :data-testid="'file-download-' + testId"
      @click="onDownload"
    >Download</button>
    <button
      v-if="canImport"
      class="rail-btn file-card-btn"
      type="button"
      :data-testid="'file-import-' + testId"
      @click="onImport"
    >Import</button>
  </span>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  store, vfs, downloadArtifact, beginCapabilityImportFromPath, capabilityPackagesSupported,
} from '../ui/store.js';

const props = defineProps({ path: { type: String, required: true } });

// The download/import implementations are /mnt/download-scoped
// (downloadArtifact walks from the artifacts root), so actions only ever
// render for paths under it. Cards elsewhere stay informational.
const DOWNLOAD_ROOT = '/mnt/download/';

const status = ref('checking'); // checking | ok | missing
const size = ref(null);

const name = computed(() => props.path.split('/').pop() || props.path);
const testId = computed(() => props.path.split('/').join('-'));
const canDownload = computed(() => status.value === 'ok' && props.path.startsWith(DOWNLOAD_ROOT));
const canImport = computed(() => canDownload.value
  && /\.locus$/i.test(props.path)
  && capabilityPackagesSupported());

onMounted(async () => {
  // Existence + regular-file proof comes from the VFS itself at render
  // time — a card never trusts the path in the message text alone.
  try {
    const st = await vfs.stat(props.path);
    if (st && st.kind === 'file') {
      size.value = st.size || 0;
      status.value = 'ok';
      return;
    }
  } catch (e) { /* fall through → missing */ }
  status.value = 'missing';
});

function humanSize(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Same explicit-download path the ContextRail artifact rows use.
function onDownload() {
  downloadArtifact(props.path.slice(DOWNLOAD_ROOT.length));
}

// USER-only entry into the capability import (the model has no path to
// beginCapabilityImportFromPath). The dialog is global (App root) and pops
// regardless of the settings panel; the import itself still needs the
// user's explicit confirmation there.
async function onImport() {
  await beginCapabilityImportFromPath(props.path);
}
</script>
