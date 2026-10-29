<template>
  <!-- Global import confirmation dialog (moved out of SettingsPanel so the
       composer's Capabilities menu can offer imports while the settings
       panel is closed). Driven ONLY by store.capabilityImport — the entry
       points (settings panel rows, artifact rail, composer menu) all land
       in the same store state, so there is exactly ONE dialog.
       Everything the package or the archive carries (author, purpose,
       body, component displayNames, diagnostic messages) is UNTRUSTED
       model-adjacent content: it is rendered exclusively through text
       interpolation — never v-html, never innerHTML, never a URL
       attribute. The body is a plain monospace, line-preserving text
       block; no Markdown rendering. Behavior, copy and data-testids are
       unchanged from the settings-panel dialog this was extracted from. -->
  <div v-if="store.capabilityImport" class="capability-import-overlay">
    <div class="capability-import-dialog" data-testid="capability-import-dialog">
      <template v-if="store.capabilityImport.diagnostics">
        <div class="capability-import-title">This package cannot be imported</div>
        <div data-testid="capability-import-diagnostics">
          <div v-for="(d, i) in store.capabilityImport.diagnostics" :key="i" class="hint">
            {{ d.code }}: {{ d.message }}
          </div>
        </div>
        <div class="capability-row capability-import-actions">
          <button class="rail-btn" type="button" data-testid="capability-import-cancel" @click="cancelCapabilityImport()">Close</button>
        </div>
      </template>
      <template v-else-if="importSummary && importSummary.kind === 'same'">
        <div class="capability-import-title">Import capability package</div>
        <div class="hint">This exact package is already installed.</div>
        <div class="capability-row capability-import-actions">
          <button class="rail-btn" type="button" data-testid="capability-import-cancel" @click="cancelCapabilityImport()">Close</button>
        </div>
      </template>
      <template v-else-if="importSummary">
        <div class="capability-import-title">Import capability package</div>
        <div class="hint"><span class="mono">{{ importSummary.id }}</span> · <span class="mono">{{ importSummary.version }}</span></div>
        <div class="hint">Author (self-declared): {{ importSummary.author }}</div>
        <div class="hint">Purpose: {{ importSummary.purpose }}</div>
        <div class="hint">Plugins ({{ importSummary.components.plugins.length }}): {{ displayNames(importSummary.components.plugins) }}</div>
        <div class="hint">Skills ({{ importSummary.components.skills.length }}): {{ displayNames(importSummary.components.skills) }}</div>
        <div class="hint">MCP ({{ importSummary.components.mcps.length }}): {{ displayNames(importSummary.components.mcps) }}</div>
        <div class="hint">Files: {{ importSummary.fileCount }} · {{ humanSize(importSummary.totalBytes) }}</div>
        <div v-if="importSummary.kind === 'replace' && importSummary.existing" class="hint">
          Replaces version {{ importSummary.existing.version }} with {{ importSummary.version }}.
        </div>
        <div v-if="importSummary.kind === 'replace' && importSummary.existing && importSummary.existing.enabled" class="hint">
          It will be re-enabled after the replacement.
        </div>
        <div v-if="importSummary.kind === 'replace' && importSummary.orphanedSkills && importSummary.orphanedSkills.length"
          class="hint" data-testid="capability-import-orphans">
          No longer included: {{ importSummary.orphanedSkills.join(', ') }}.
          Their files stay under /home/locus/.skills/{{ importSummary.id }}/ but will not be used.
        </div>
        <div v-if="importSummary.needsMismatchAcceptance" class="hint storage-notice" data-testid="capability-import-mismatch">
          The package content does not match its LOCUS.md file list:
          {{ (importSummary.mismatched || []).join(', ') }}.
          Continue only if you trust this change; it will be recorded in the package changelog.
        </div>
        <details class="capability-import-body-wrap">
          <summary data-testid="capability-import-body-toggle">Show package content (LOCUS.md)</summary>
          <pre class="capability-import-body" data-testid="capability-import-body">{{ importSummary.body }}</pre>
        </details>
        <div class="hint">Importing runs this package's code inside Locus's Python environment.</div>
        <div v-if="store.capabilityImport.error" class="hint storage-notice" data-testid="capability-import-error">
          {{ store.capabilityImport.error }}
        </div>
        <div class="capability-row capability-import-actions">
          <button class="rail-btn" type="button" data-testid="capability-import-cancel" @click="cancelCapabilityImport()">Cancel</button>
          <button class="rail-btn" type="button" data-testid="capability-import-confirm"
            :disabled="importing" @click="confirmImport()">
            {{ importSummary.needsMismatchAcceptance ? 'Continue and import' : 'Import' }}
          </button>
        </div>
      </template>
      <template v-else-if="importCommit">
        <!-- C3 O1: the commit succeeded but the first-install
             auto-enable failed — the package stays installed and
             disabled, and the reason is shown instead of a silent
             "done". D12: the SAME branch hosts the connect-credentials
             step; an enableError is shown above it when present. -->
        <template v-if="importConnectActive">
          <div v-if="importCommit.enableError" class="hint storage-notice" data-testid="capability-import-enable-error">{{ importCommit.enableError }}</div>
          <div class="capability-import-title">Connect credentials</div>
          <div class="hint">This package declares credentials that are not connected yet. You can also connect them later on the capability card.</div>
          <div v-for="row in importConnectRows" :key="row.name" class="cred-item"
            :data-testid="'import-credential-row-' + row.name">
            <div class="capability-row cred-row">
              <span class="cred-label">{{ row.label }}</span>
              <span class="mono">${{ row.name }}</span>
              <span v-if="row.done" class="capability-state" data-state="connected"
                :data-testid="'import-credential-state-' + row.name">
                {{ row.last4 ? 'Connected ····' + row.last4 : 'Connected' }}</span>
            </div>
            <div class="hint">{{ credentialSendLine(row.decl) }}</div>
            <div class="field">
              <label :for="'import-credential-input-' + row.name">Key</label>
              <input
                :id="'import-credential-input-' + row.name"
                v-model="row.value"
                type="password"
                :data-testid="'import-credential-input-' + row.name"
                spellcheck="false" autocomplete="off">
            </div>
            <label class="check-row">
              <input v-model="row.remember" type="checkbox" :data-testid="'import-credential-remember-' + row.name">
              Remember on this device
            </label>
            <div class="hint">Saved in this browser on this device. Uncheck on a shared computer.</div>
            <div v-if="row.error" class="hint storage-notice" :data-testid="'import-credential-error-' + row.name">
              {{ row.error }}
            </div>
          </div>
          <div class="capability-row capability-import-actions">
            <button class="rail-btn" type="button" data-testid="capability-import-skip"
              :disabled="importConnectBusy" @click="skipImportConnect">Skip for now</button>
            <button class="rail-btn" type="button" :disabled="importConnectBusy"
              data-testid="capability-import-connect" @click="confirmImportConnect">Connect</button>
          </div>
        </template>
        <template v-else>
          <div class="capability-import-title">Package imported, but it could not be enabled</div>
          <div class="hint"><span class="mono">{{ importCommit.id }}</span> is installed and disabled.</div>
          <div class="hint storage-notice" data-testid="capability-import-enable-error">{{ importCommit.enableError }}</div>
          <div class="capability-row capability-import-actions">
            <button class="rail-btn" type="button" data-testid="capability-import-cancel" @click="cancelCapabilityImport()">Close</button>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import {
  store, confirmCapabilityImport, cancelCapabilityImport, connectCredential,
} from '../ui/store.js';
import { credentialSendLine } from '../ui/credential-format.js';

// The import dialog's summary is read through a computed so the template
// never reaches into possibly-missing fields.
const importSummary = computed(() => {
  const c = store.capabilityImport;
  return c && c.summary ? c.summary : null;
});

// C3 O1: a commit that succeeded but could not auto-enable stays in the
// dialog as a result report ({ id, state, enableError }).
const importCommit = computed(() => {
  const c = store.capabilityImport;
  return c && c.commit ? c.commit : null;
});

// ---------- D12: the import dialog's connect-credentials step ----------
// Entered after a successful commit when the package declares
// needs-connection credentials. The typed key values live ONLY in these
// local refs — never in the store, storage or an error message — and are
// cleared when the step closes (Connect finished, Skip for now, or the
// dialog going away).
const importConnectActive = computed(() => {
  const c = store.capabilityImport;
  return !!(c && c.commit && c.connectStep);
});
const importConnectRows = ref([]); // { name, label, decl, value, remember, error, done, last4 }
const importConnectBusy = ref(false);

function openImportConnectStep() {
  const c = store.capabilityImport;
  const id = c && c.commit && c.commit.id;
  const cap = store.capabilities.find((x) => x.id === id);
  importConnectRows.value = ((cap && cap.credentials) || [])
    .filter((d) => d.state === 'needs-connection')
    .map((d) => ({ name: d.name, label: d.label, decl: d, value: '', remember: true, error: null, done: false, last4: null }));
}

function closeImportConnectStep() {
  importConnectRows.value = []; // the values never survive the step
  importConnectBusy.value = false;
}

watch(() => store.capabilityImport, (c) => {
  if (!c || !c.connectStep) closeImportConnectStep();
});

async function confirmImportConnect() {
  if (importConnectBusy.value) return;
  importConnectBusy.value = true;
  try {
    for (const row of importConnectRows.value) {
      if (row.done || !row.value.trim()) continue; // filled rows only
      row.error = null;
      try {
        const s = await connectCredential(row.name, row.value, { remember: row.remember });
        row.done = true;
        row.last4 = s.last4;
        row.value = ''; // only the last 4 characters are ever shown
      } catch (e) {
        // The service never puts the value in an error message; the row
        // stays editable while the rows that succeeded stay connected.
        row.error = e.message || String(e);
      }
    }
    // Every filled row either connected or reported its own error — close
    // only when nothing is left to retry.
    if (importConnectRows.value.every((row) => row.done || !row.value.trim())) {
      cancelCapabilityImport();
    }
  } finally {
    importConnectBusy.value = false;
  }
}

function skipImportConnect() {
  cancelCapabilityImport(); // the watch clears the rows (and the values)
}

// Local in-flight flag for the confirm button (double-click guard while
// the commit is running; commit errors stay inside the dialog).
const importing = ref(false);

async function confirmImport() {
  importing.value = true;
  try {
    await confirmCapabilityImport();
    // D12: when the store entered the connect-credentials step, fill the
    // local rows from the just-committed capability's declarations.
    if (importConnectActive.value) openImportConnectStep();
  } finally {
    importing.value = false;
  }
}

function displayNames(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.length ? arr.map((x) => (x && x.displayName) || (x && x.id) || '?').join(', ') : 'none';
}

function humanSize(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
</script>
