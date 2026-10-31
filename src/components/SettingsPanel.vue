<template>
  <div class="modal-backdrop" @click.self="close">
    <div ref="panelEl" class="modal settings-panel" role="dialog" aria-label="Settings">
      <div class="modal-head" data-testid="settings-head">
        <span>Settings</span>
        <button class="icon-btn" type="button" data-testid="settings-close" aria-label="Close settings" @click="close">×</button>
      </div>

      <!-- Owner UI review 2026-10-29: head and foot are FIXED, only the
           body scrolls (item 7/9) — the × never scrolls out of reach, and
           "Done" stays pinned at the bottom. -->
      <div class="settings-body">
        <!-- Owner UI review 2026-10-29 item 1: the top group had no section
             title; every section now shares one .section-label style, in
             the fixed order Model / Image input / Capabilities / Always
             allowed / Local storage. Test connection moved here (item 7):
             it tests THESE settings and shows its result directly below. -->
        <section class="settings-section" data-testid="model-section">
          <div class="section-label">Model</div>
          <div class="field">
            <label for="set-api-key">API key</label>
            <input id="set-api-key" v-model="store.settings.apiKey" type="password" placeholder="sk-…" spellcheck="false" autocomplete="off">
          </div>
          <div class="field">
            <label for="set-api-base">API endpoint</label>
            <input id="set-api-base" v-model="store.settings.apiBase" type="text" spellcheck="false" autocomplete="off">
          </div>
          <div class="field">
            <label for="set-model">Model</label>
            <input id="set-model" v-model="store.settings.model" type="text" spellcheck="false" autocomplete="off">
          </div>
          <div class="field">
            <label for="set-max-tokens">Max output tokens</label>
            <input id="set-max-tokens" v-model.number="store.settings.maxTokens" type="number" min="1" step="1" inputmode="numeric">
            <div class="hint">Upper bound for one model reply. Mainstream models support 128K+; lower it if the provider rejects the request. Locus never guesses it from the model name.</div>
          </div>
          <div class="field">
            <label for="set-context-window">Context window (tokens) <span class="hint-inline">optional</span></label>
            <input id="set-context-window" v-model.number="store.settings.contextWindow" type="number" min="1" step="1" inputmode="numeric" placeholder="unknown">
            <div class="hint">Optional: the model's total context size. When set, Locus keeps each request within it, calibrated from the token counts the provider reports. Leave empty if unknown; Locus never guesses it from the model name.</div>
          </div>
          <div class="field">
            <label for="set-dialect">API dialect</label>
            <select id="set-dialect" v-model="store.settings.dialect">
              <option value="auto">auto — detect from endpoint</option>
              <option value="openai">openai — OpenAI-compatible</option>
              <option value="anthropic">anthropic — Anthropic-compatible</option>
            </select>
            <div class="hint">Set manually when a gateway or corporate proxy cannot be auto-detected.</div>
          </div>
          <div class="field">
            <label for="set-proxy">Relay / proxy <span class="hint-inline">optional</span></label>
            <input id="set-proxy" v-model="store.settings.proxy" type="text" placeholder="https://your-proxy.workers.dev" spellcheck="false" autocomplete="off">
            <div class="hint">Routes the model call through your own relay to work around CORS. Empty = direct.</div>
          </div>

          <div class="field check-field">
            <label class="check-row">
              <input v-model="store.settings.remember" type="checkbox">
              Remember API key on this device (local browser profile)
            </label>
            <div class="hint">Saved in this browser on this device. Uncheck on a shared computer.</div>
          </div>

          <div class="model-test">
            <button class="rail-btn primary" type="button" data-testid="settings-test-connection" :disabled="store.settingsTesting" @click="testConnection">
              {{ store.settingsTesting ? 'Testing…' : 'Test connection' }}
            </button>
            <div v-if="store.settingsResult" class="settings-result" :class="{ ok: store.settingsResult.ok }">
              {{ store.settingsResult.message }}
            </div>
          </div>
        </section>

        <section class="settings-section" data-testid="image-section">
          <div class="section-label">Image input</div>
          <div class="hint">
            {{ imageCapabilitySummary }}
            <span v-if="store.imageCapability && store.imageCapability.lastProbeFailure">Last check: {{ store.imageCapability.lastProbeFailure }}</span>
          </div>
          <button
            class="rail-btn"
            type="button"
            :disabled="store.busy || store.cancelling || !store.imageCapability"
            data-testid="recheck-image-capability"
            @click="recheckCapability"
          >Forget &amp; recheck image capability</button>
        </section>

        <section class="settings-section" data-testid="capabilities-section">
          <div class="section-label">Capabilities</div>

          <!-- Capability packages (D10 / C1-P3). Everything the package or the
               archive carries (author, purpose, body, component displayNames,
               diagnostic messages) is UNTRUSTED model-adjacent content: it is
               rendered exclusively through text interpolation — never v-html,
               never innerHTML, never a URL attribute. The body is a plain
               monospace, line-preserving text block; no Markdown rendering. -->

          <!-- The import confirmation dialog (both entry points shared it)
               moved to the GLOBAL CapabilityImportDialog component (app root,
               driven by store.capabilityImport) so the composer's
               Capabilities menu can import while this panel is closed. The
               entries below trigger that same dialog. -->

          <!-- C3 §3.2: the Connect dialog. One at a time. The send rule is
               restated above the input (plain text); the value lives in one
               ref that is cleared when the dialog closes — it never reaches
               the store, storage or any error message. -->
          <div v-if="credDialog" class="capability-import-dialog" :data-testid="'credential-dialog-' + credDialog.name">
            <div class="capability-import-title">Connect credential</div>
            <div class="hint">{{ credentialSendLine(dialogCredential) }}</div>
            <div class="field">
              <label :for="'credential-key-input-' + credDialog.name">Key</label>
              <input
                :id="'credential-key-input-' + credDialog.name"
                v-model="credDialogKey"
                type="password"
                :data-testid="'credential-input-' + credDialog.name"
                spellcheck="false" autocomplete="off">
            </div>
            <label class="check-row">
              <input v-model="credDialogRemember" type="checkbox" :data-testid="'credential-remember-' + credDialog.name">
              Remember on this device
            </label>
            <div class="hint">Saved in this browser on this device. Uncheck on a shared computer.</div>
            <div v-if="credDialog.error" class="hint storage-notice" :data-testid="'credential-dialog-error-' + credDialog.name">
              {{ credDialog.error }}
            </div>
            <div class="capability-row capability-import-actions">
              <button class="rail-btn" type="button" :data-testid="'credential-cancel-' + credDialog.name" @click="closeCredentialDialog">Cancel</button>
              <button class="rail-btn" type="button" :disabled="credDialog.busy" :data-testid="'credential-confirm-' + credDialog.name" @click="confirmCredentialConnect">Connect</button>
            </div>
          </div>

          <!-- Unsupported core: everything below is hidden -->
          <div v-if="!capabilityPackagesSupported()" class="hint" data-testid="capability-packages-unsupported">
            This Locus core version does not support installing capability packages.
          </div>
          <template v-else>
            <!-- Owner UI review 2026-10-29 item 3: two lines — a full-width
                 path input with its button beside it, then the file entry.
                 The old layout squeezed the input between two buttons and
                 truncated the placeholder. -->
            <div class="capability-import-entry">
              <div class="capability-import-line">
                <input class="capability-import-path" data-testid="capability-import-path" v-model="importPath"
                  type="text" placeholder="/mnt/download/<name>.locus" spellcheck="false" autocomplete="off">
                <button class="rail-btn" type="button" data-testid="capability-import-path-button"
                  :disabled="store.busy || store.cancelling" @click="importFromPath">Import from path</button>
              </div>
              <div class="capability-import-line">
                <button class="rail-btn" type="button" data-testid="capability-import-file"
                  :disabled="store.busy || store.cancelling" @click="pickImportFile">Import .locus file…</button>
                <input ref="importFileInput" data-testid="capability-import-file-input" type="file" accept=".locus"
                  style="display:none" @change="onImportFileChanged">
              </div>
            </div>

            <div v-if="store.capabilityPackages && store.capabilityPackages.durable === false"
              class="hint" data-testid="capability-packages-not-durable">
              This browser cannot keep installed packages; they will need to be imported again after a reload.
            </div>

            <!-- Boot-time verification notices (§5.3) -->
            <div v-for="n in store.capabilityPackageNotices" :key="n.id" class="capability-item"
              :data-testid="'capability-notice-' + n.id">
              <div v-if="n.status === 'mismatch'" class="hint">
                {{ n.id }} {{ n.version }} was not loaded: its content no longer matches the recorded file list
                ({{ (n.mismatched || []).join(', ') }}).
              </div>
              <div v-else class="hint">
                {{ n.id }} {{ n.version }} could not be loaded: {{ n.message }}.
              </div>
              <div v-if="uninstallArmId === n.id" class="hint">
                The package is removed; its guidance files under /home/locus/.skills/{{ n.id }}/ are kept.
              </div>
              <div class="capability-row">
                <button v-if="n.status === 'mismatch'" class="rail-btn" type="button"
                  :disabled="store.busy || store.cancelling"
                  :data-testid="'capability-notice-accept-' + n.id" @click="acceptNotice(n.id)">Continue (re-pin)</button>
                <button v-if="n.status === 'corrupt'" class="rail-btn danger" type="button"
                  :disabled="store.busy || store.cancelling"
                  :data-testid="(uninstallArmId === n.id ? 'capability-notice-uninstall-confirm-' : 'capability-notice-uninstall-') + n.id"
                  @click="noticeUninstall(n.id)">{{ uninstallArmId === n.id ? 'Confirm uninstall' : 'Uninstall' }}</button>
                <button class="rail-btn" type="button" :data-testid="'capability-notice-skip-' + n.id"
                  @click="dismissNotice(n.id)">Skip this time</button>
              </div>
            </div>

            <!-- Installed packages that could NOT be loaded (D10 §5): a
                 loaded package is shown inside its Capability entry below
                 instead of being duplicated here. -->
            <div v-for="p in installedNotLoadedPackages" :key="p.id" class="capability-item"
              :data-testid="'capability-package-' + p.id">
              <div class="capability-row capability-head">
                <span class="capability-name">{{ p.id }}</span>
                <span class="capability-version">{{ p.version }}</span>
                <span class="capability-state" data-state="error">Not loaded</span>
                <span class="capability-actions">
                  <button v-if="uninstallArmId !== p.id" class="rail-btn danger" type="button"
                    :disabled="store.busy || store.cancelling"
                    :data-testid="'capability-package-uninstall-' + p.id" @click="uninstallArmId = p.id">Uninstall</button>
                  <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                    :data-testid="'capability-package-uninstall-confirm-' + p.id" @click="uninstallPackage(p.id)">Confirm uninstall</button>
                </span>
              </div>
              <div v-if="packageNoticesById[p.id]" class="hint" :data-testid="'capability-package-reason-' + p.id">
                {{ packageNoticesById[p.id].status }}: {{ packageNoticesById[p.id].message }}
              </div>
              <div v-if="uninstallArmId === p.id" class="hint">
                Uninstall deletes this package from Locus. The package is removed; its guidance files under
                /home/locus/.skills/{{ p.id }}/ are kept.
              </div>
              <div class="capability-meta">Author (self-declared): {{ p.author }}<template v-if="p.purpose"> · Purpose: {{ p.purpose }}</template></div>
            </div>
          </template>

          <div v-if="!capabilities.length" class="hint" data-testid="capabilities-empty">No optional capabilities available yet.</div>
          <!-- Owner UI review 2026-10-29 item 6: one merged card per
               capability. Line 1: display name · version (plain, secondary)
               · state label · actions (Remove + Uninstall side by side).
               Line 2: description. Line 3 (small, secondary): Includes /
               Author / Purpose. The package-origin content keeps the
               capability-package-<id> testid on a transparent wrapper so
               the merged-card and standalone-list displays stay
               distinguishable to the gates. The remove/uninstall warnings
               are no longer permanent: they render only in the armed
               (Confirm …) state, text unchanged (owner decision). -->
          <div v-for="c in capabilities" :key="c.id" class="capability-item" :data-testid="'capability-' + c.id">
            <div class="capability-row capability-head">
              <span class="capability-name">{{ c.displayName }}</span>
              <span v-if="loadedPackagesById[c.id]" class="capability-version">{{ loadedPackagesById[c.id].version }}</span>
              <span class="capability-state" :data-state="c.state">{{ stateLabel(c) }}</span>
              <span class="capability-actions">
                <button v-if="!c.enabled" class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
                  :data-testid="'capability-add-' + c.id" @click="addCapability(c)">Add</button>
                <button v-else-if="removingId !== c.id" class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                  :data-testid="'capability-remove-' + c.id" @click="beginRemoveCapability(c)">Remove</button>
                <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                  :data-testid="'capability-remove-confirm-' + c.id" @click="removeCapability(c)">Confirm remove</button>
                <template v-if="loadedPackagesById[c.id]">
                  <button v-if="uninstallArmId !== c.id" class="rail-btn danger" type="button"
                    :disabled="store.busy || store.cancelling"
                    :data-testid="'capability-package-uninstall-' + c.id" @click="uninstallArmId = c.id">Uninstall</button>
                  <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                    :data-testid="'capability-package-uninstall-confirm-' + c.id" @click="uninstallPackage(c.id)">Confirm uninstall</button>
                </template>
              </span>
            </div>
            <div class="hint">{{ c.description }}</div>
            <div v-if="c.enabled" class="capability-meta" :data-testid="'capability-includes-' + c.id">
              Includes: {{ c.includes.plugins }} local software · {{ c.includes.skills }} guidance · {{ c.includes.mcps }} external connections<template v-if="loadedPackagesById[c.id]"> · Author (self-declared): {{ loadedPackagesById[c.id].author }}<template v-if="loadedPackagesById[c.id].purpose"> · Purpose: {{ loadedPackagesById[c.id].purpose }}</template></template>
            </div>
            <div v-if="loadedPackagesById[c.id]" class="capability-package-part" :data-testid="'capability-package-' + c.id">
              <div v-if="uninstallArmId === c.id" class="hint">
                Uninstall deletes this package from Locus. The package is removed; its guidance files under
                /home/locus/.skills/{{ loadedPackagesById[c.id].id }}/ are kept.
              </div>
              <!-- C3 §3.2: uninstalling removes the capability's bindings and
                   keys — stated only when the capability declares any. -->
              <div v-if="uninstallArmId === c.id && (c.credentials || []).length" class="hint"
                data-testid="capability-uninstall-credentials-warning">
                Connected credentials of this capability will be removed.
              </div>
            </div>
            <div v-if="c.enabled && removingId === c.id" class="hint" data-testid="capability-remove-warning">
              Removing this capability disables it and deletes its customized guidance; re-adding it restores the
              default guidance.<span v-if="loadedPackagesById[c.id]"> To delete this package from Locus instead, use
              Uninstall.</span>
            </div>
            <div v-if="c.enabled && c.error" class="hint">{{ c.error }}</div>
            <template v-if="c.enabled">
              <div v-for="m in c.mcps" :key="m.id" class="hint" :data-testid="'capability-mcp-' + c.id">
                External connection: {{ m.displayName }} — {{ m.state === 'connected' ? 'Connected' : 'Connection required' }}
                <button v-if="m.state !== 'connected'" class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
                  :data-testid="'capability-connect-' + c.id" @click="connectMcp(c, m)">Connect</button>
              </div>
            </template>
            <!-- C3 §3.2: this capability's credentials, in EVERY state
                 (added, removed, enable-failed). Values are never rendered:
                 a connected row shows only the last 4 characters that
                 credentials.summary reports; every string here goes through
                 text interpolation. -->
            <div v-for="cred in (credentialViews[c.id] || [])" :key="cred.name" class="cred-item"
              :data-testid="'credential-' + cred.name">
              <div class="capability-row cred-row">
                <span class="cred-label">{{ cred.label }}</span>
                <span class="mono">${{ cred.name }}</span>
                <span class="capability-state" :data-state="cred.decl.state"
                  :data-testid="'credential-state-' + cred.name">{{ cred.stateLabel }}</span>
                <button v-if="cred.decl.state === 'needs-connection'" class="rail-btn" type="button"
                  :disabled="store.busy || store.cancelling"
                  :data-testid="'credential-connect-' + cred.name" @click="openCredentialDialog(cred)">Connect</button>
                <template v-if="cred.decl.state === 'connected'">
                  <button v-if="credDisconnectArm !== cred.name" class="rail-btn danger" type="button"
                    :disabled="store.busy || store.cancelling"
                    :data-testid="'credential-disconnect-' + cred.name"
                    @click="credDisconnectArm = cred.name">Disconnect</button>
                  <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                    :data-testid="'credential-disconnect-confirm-' + cred.name"
                    @click="disconnectCredentialNow(cred.name)">Confirm disconnect</button>
                </template>
                <template v-if="cred.decl.state === 'needs-reconfirm'">
                  <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
                    :data-testid="'credential-reconfirm-' + cred.name"
                    @click="reconfirmCredentialNow(cred.name)">Confirm</button>
                  <button v-if="credDisconnectArm !== cred.name" class="rail-btn danger" type="button"
                    :disabled="store.busy || store.cancelling"
                    :data-testid="'credential-disconnect-' + cred.name"
                    @click="credDisconnectArm = cred.name">Disconnect</button>
                  <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                    :data-testid="'credential-disconnect-confirm-' + cred.name"
                    @click="disconnectCredentialNow(cred.name)">Confirm disconnect</button>
                </template>
              </div>
              <div class="hint" :data-testid="'credential-sendline-' + cred.name">{{ credentialSendLine(cred.decl) }}</div>
              <div v-if="cred.decl.state === 'needs-reconfirm'" class="hint"
                :data-testid="'credential-old-binding-' + cred.name">
                Confirmed earlier as: {{ credentialOldLine(cred.name) }}
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" data-testid="always-allowed-section">
          <div class="section-label">Always allowed</div>
          <div v-if="!store.persistentApprovalsSupported" class="hint" data-testid="always-allowed-unsupported">
            This Locus core does not support always-allowed approvals.
          </div>
          <template v-else>
            <div v-if="!store.alwaysAllowed.length" class="hint" data-testid="always-allowed-empty">
              Nothing is always allowed.
            </div>
            <div v-for="(g, i) in store.alwaysAllowed" :key="g.policyKey" class="capability-row cred-row"
              :data-testid="'always-allowed-item-' + i">
              <span class="hint">{{ g.label }}</span>
              <button class="rail-btn danger" type="button" :data-testid="'always-allowed-remove-' + i"
                @click="removeAlwaysAllowed(g.policyKey)">Remove</button>
            </div>
          </template>
        </section>

        <section class="settings-section" data-testid="storage-section">
          <div class="section-label">Local storage</div>
          <div class="hint">
            {{ storageSummary }}
            <span v-if="store.storageStatus.error">Persistence fallback: {{ store.storageStatus.error }}</span>
          </div>
          <div v-if="store.storageNotice" class="hint storage-notice">{{ store.storageNotice }}</div>
          <!-- Owner UI review 2026-10-29 item 5: after the grant this is a
               STATE (dot + colored text, not a button); the button only
               exists while storage is not yet granted. Behavior unchanged. -->
          <button v-if="!store.storageStatus.persistent" class="rail-btn" type="button" data-testid="storage-keep" @click="keepStorage">
            Keep Locus data on this device
          </button>
          <div v-else class="capability-state" data-state="ready" data-testid="storage-persistent-state">Persistent storage granted</div>
          <div class="storage-actions">
            <div class="storage-actions-group">
              <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearConversations">Clear conversations</button>
              <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearHome">Clear home</button>
              <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearPlugins">Clear plugins</button>
            </div>
            <div class="storage-actions-group">
              <button class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling" @click="forgetApiKeys">Forget API keys</button>
              <button class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling" @click="resetAllData">Reset all local data</button>
            </div>
          </div>
        </section>
      </div>

      <div class="modal-foot" data-testid="settings-foot">
        <button class="rail-btn primary" type="button" data-testid="settings-done" @click="close">Done</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import {
  store, applySettings, persistSettingsIfNeeded, testConnection,
  capabilityList, enableCapability, disableCapability, setMcpConnectionState,
  keepDataOnThisDevice, clearConversations as clearConversationData,
  clearHome as clearHomeData, clearPlugins as clearPluginData,
  forgetApiKeys as forgetStoredApiKeys, resetAllData as resetLocalData,
  refreshImageCapability, recheckImageCapability,
  capabilityPackagesSupported, refreshCapabilityPackages,
  beginCapabilityImportFromBytes, beginCapabilityImportFromPath,
  acceptCapabilityPackageMismatch, dismissCapabilityPackageNotice,
  uninstallCapabilityPackage,
  connectCredential, disconnectCredential, reconfirmCredential,
  credentialSummary, credentialBindingRecord,
  refreshAlwaysAllowed, revokeAlwaysAllowed,
} from '../ui/store.js';
import { credentialSendLine } from '../ui/credential-format.js';
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const storageSummary = computed(() => {
  const s = store.storageStatus;
  const mb = (n) => n == null ? '?' : (n / (1024 * 1024)).toFixed(1);
  return `${s.mode === 'indexeddb' ? 'IndexedDB' : 'Memory-only'} · OPFS ${s.opfs ? 'available' : 'unavailable'} · ${mb(s.usage)} MB used / ${mb(s.quota)} MB available`;
});

// Read-only capability projection (docs/IMAGE-INPUT.md). Source labels:
// user / probe / built-in / provider / unknown origin.
const imageCapabilitySummary = computed(() => {
  const c = store.imageCapability;
  if (!c) return 'Unavailable in this runtime.';
  const sourceLabel = { user: 'your answer', probe: 'visual check', builtin: 'built-in table', 'provider-rejection': 'provider' }[c.source] || c.source;
  return `Image input: ${c.state} · source: ${sourceLabel}`;
});

const capabilities = computed(() => store.capabilities);

// Merged package display (presentation only): a package whose load
// succeeded is rendered inside its Capability entry — keyed by id, the
// SAME id the capability manager registers it under — and the standalone
// installed list keeps only packages that could not be loaded. Pure read
// projections of store state; the install service is untouched.
const loadedPackagesById = computed(() => {
  const map = {};
  const pkgs = store.capabilityPackages && store.capabilityPackages.packages;
  for (const p of Array.isArray(pkgs) ? pkgs : []) {
    if (p && p.loaded) map[p.id] = p;
  }
  return map;
});

const installedNotLoadedPackages = computed(() => {
  const pkgs = store.capabilityPackages && store.capabilityPackages.packages;
  return (Array.isArray(pkgs) ? pkgs : []).filter((p) => p && !p.loaded);
});

const packageNoticesById = computed(() => {
  const map = {};
  for (const n of store.capabilityPackageNotices || []) map[n.id] = n;
  return map;
});

// Two-step destructive confirmation for Remove (fixed UI copy, never a
// model-controlled ApprovalCard — this is the USER's own button action).
// Removing a capability deletes its durable skill instances; the warning
// states that semantics while the Remove step is armed (owner UI decision
// 2026-10-29: the warning is no longer permanent).
const removingId = ref(null);

function stateLabel(c) {
  if (!c.enabled) return c.state === 'disabled' ? 'Not added' : c.state;
  return { ready: 'Ready', 'needs-connection': 'Connection required', error: 'Error', disabled: 'Not added' }[c.state] || c.state;
}

async function refreshCapabilities() { capabilityList(); }

function beginRemoveCapability(c) {
  removingId.value = c.id;
}

async function addCapability(c) {
  try {
    await enableCapability(c.id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

async function removeCapability(c) {
  try {
    await disableCapability(c.id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  } finally {
    removingId.value = null;
  }
}

function connectMcp(c, m) {
  try {
    setMcpConnectionState(m.id, 'connected');
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

// ---------- capability credentials (C3 §3.2; C3-P1b UI) ----------
// View models for one capability's credentials. The manager snapshot is
// re-synced after every state-changing action, so this computed re-runs on
// each connect/disconnect/reconfirm/restore; the summary's last-4 comes
// from the credential service, never from a stored value.
const credentialViews = computed(() => {
  const map = {};
  for (const c of store.capabilities) {
    map[c.id] = (c.credentials || []).map((decl) => {
      const s = credentialSummary(decl.name);
      let stateLabel;
      if (decl.state === 'connected') {
        stateLabel = s.last4 ? 'Connected ····' + s.last4 : 'Connected';
      } else if (decl.state === 'needs-reconfirm') {
        stateLabel = 'Needs reconfirmation';
      } else {
        stateLabel = 'Not connected';
      }
      return { name: decl.name, label: decl.label, decl, stateLabel };
    });
  }
  return map;
});

// The send rule, stated the same way in the row and the Connect dialog —
// shared with the global CapabilityImportDialog (src/ui/credential-format.js).

// Old-binding line for a needs-reconfirmation row, read from the durable
// binding record (metadata only).
const credentialOldBindings = ref({});
watch(() => store.capabilities, (caps) => {
  for (const c of caps) {
    for (const decl of (c.credentials || [])) {
      if (decl.state === 'needs-reconfirm' && !credentialOldBindings.value[decl.name]) {
        credentialBindingRecord(decl.name).then((record) => {
          credentialOldBindings.value = Object.assign({}, credentialOldBindings.value, {
            [decl.name]: record,
          });
        }).catch(() => {});
      }
    }
  }
}, { immediate: true });

function credentialOldLine(name) {
  const record = credentialOldBindings.value[name];
  if (!record) return 'unavailable';
  return credentialSendLine(record);
}

// The ONE Connect dialog. The key lives in a single ref, cleared on every
// close — it is never copied into the store, storage or an error message.
// D12: remember defaults to CHECKED (opt-out only).
const credDialog = ref(null); // { name, error, busy } | null
const credDialogKey = ref('');
const credDialogRemember = ref(true);

const dialogCredential = computed(() => {
  if (!credDialog.value) return null;
  const name = credDialog.value.name;
  for (const c of store.capabilities) {
    const decl = (c.credentials || []).find((x) => x.name === name);
    if (decl) return decl;
  }
  return null;
});

function openCredentialDialog(cred) {
  credDialogKey.value = '';
  credDialogRemember.value = true;
  credDialog.value = { name: cred.name, error: null, busy: false };
}

function closeCredentialDialog() {
  credDialog.value = null;
  credDialogKey.value = ''; // the value never survives the dialog
  credDialogRemember.value = true;
}

async function confirmCredentialConnect() {
  const dialog = credDialog.value;
  if (!dialog || dialog.busy) return;
  dialog.busy = true;
  dialog.error = null;
  try {
    await connectCredential(dialog.name, credDialogKey.value, { remember: credDialogRemember.value });
    closeCredentialDialog();
    refreshCapabilities();
  } catch (e) {
    dialog.error = e.message || String(e);
    dialog.busy = false;
  }
}

// Two-step destructive confirmation, shared by the connected and
// needs-reconfirmation rows (fixed UI copy).
const credDisconnectArm = ref(null);

async function disconnectCredentialNow(name) {
  try {
    await disconnectCredential(name);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  } finally {
    credDisconnectArm.value = null;
  }
}

async function reconfirmCredentialNow(name) {
  try {
    await reconfirmCredential(name);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

// ---------- "Always allowed" (C3 §6) ----------
async function removeAlwaysAllowed(policyKey) {
  try {
    await revokeAlwaysAllowed(policyKey);
  } catch (e) {
    store.storageNotice = e.message || String(e);
  }
}

onMounted(() => {
  refreshImageCapability();
  refreshCapabilityPackages();
  refreshAlwaysAllowed();
  if (store.settingsScrollTarget) scrollToCapability(store.settingsScrollTarget);
});

// Composer's capability-row "Settings…" button (and any future deep link)
// opens this panel pointing at one capability: scroll it into view once the
// section renders, then clear the request. Retried briefly — the capability
// list itself is store-driven and can land a tick later than the panel.
const panelEl = ref(null);
watch(() => store.settingsScrollTarget, (id) => {
  if (id) scrollToCapability(id);
});

async function scrollToCapability(id) {
  const requested = id;
  for (let attempt = 0; attempt < 12; attempt++) {
    await nextTick();
    const el = panelEl.value
      && panelEl.value.querySelector('[data-testid="capability-' + requested + '"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      if (store.settingsScrollTarget === requested) store.settingsScrollTarget = null;
      return;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (store.settingsScrollTarget === requested) store.settingsScrollTarget = null;
}

async function recheckCapability() {
  try {
    await recheckImageCapability();
    store.storageNotice = 'Image capability was reset for the current provider; Locus will ask again next time an image is sent.';
  } catch (e) {
    store.storageNotice = 'Recheck failed: ' + (e && e.message ? e.message : String(e));
  }
}

async function keepStorage() { await keepDataOnThisDevice(); }
async function clearConversations() { try { await clearConversationData(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function clearHome() { try { await clearHomeData(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function clearPlugins() { try { await clearPluginData(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function forgetApiKeys() { try { await forgetStoredApiKeys(); } catch (e) { store.storageNotice = e.message || String(e); } }
async function resetAllData() { try { await resetLocalData(); } catch (e) { store.storageNotice = e.message || String(e); } }

async function close() {
  applySettings();
  await persistSettingsIfNeeded();
  store.settingsOpen = false;
  store.settingsResult = null;
}

// ---------- capability packages (D10 / C1-P3) ----------
// Two-step destructive confirmation shared by the installed list and the
// corrupt-notice uninstall (fixed UI copy, never model-controlled).
const uninstallArmId = ref(null);

// The import dialog (summary / commit report / D12 connect step) lives in
// the GLOBAL CapabilityImportDialog component — the entries below only
// begin an import; the dialog reacts to store.capabilityImport wherever
// the panel is open or not.

// Local in-flight guard is gone with the dialog; the entries below stay
// synchronous with the store's own import state.

const importFileInput = ref(null);
const importPath = ref('');

function pickImportFile() {
  if (importFileInput.value) importFileInput.value.click();
}

async function onImportFileChanged(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = ''; // allow re-picking the same file after a failure
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await beginCapabilityImportFromBytes(bytes, file.name);
}

async function importFromPath() {
  const p = importPath.value.trim();
  if (!p) return;
  await beginCapabilityImportFromPath(p);
}

async function acceptNotice(id) {
  try {
    await acceptCapabilityPackageMismatch(id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  } finally {
    uninstallArmId.value = null;
  }
}

async function dismissNotice(id) {
  try {
    await dismissCapabilityPackageNotice(id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  } finally {
    uninstallArmId.value = null;
  }
}

async function noticeUninstall(id) {
  if (uninstallArmId.value !== id) {
    uninstallArmId.value = id;
    return;
  }
  try {
    await uninstallCapabilityPackage(id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  } finally {
    uninstallArmId.value = null;
  }
}

async function uninstallPackage(id) {
  try {
    await uninstallCapabilityPackage(id);
    refreshCapabilities();
  } catch (e) {
    store.storageNotice = e.message || String(e);
  } finally {
    uninstallArmId.value = null;
  }
}
</script>
