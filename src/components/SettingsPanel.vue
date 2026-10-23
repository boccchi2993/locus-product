<template>
  <div class="modal-backdrop" @click.self="close">
    <div class="modal settings-panel" role="dialog" aria-label="Settings">
      <div class="modal-head">
        <span>Settings</span>
        <button class="icon-btn" type="button" @click="close">×</button>
      </div>

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
        <div class="hint">Upper bound for one model reply. Lower it if the provider rejects requests; Locus never guesses it from the model name.</div>
      </div>
      <div class="field">
        <label for="set-context-window">Context window (tokens)</label>
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

      <label class="check-row">
        <input v-model="store.settings.remember" type="checkbox">
        Remember API key on this device (local browser profile)
      </label>
      <div class="hint">Saved in this browser on this device. Uncheck on a shared computer.</div>

      <section class="storage-controls">
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

      <section class="storage-controls" data-testid="capabilities-section">
        <div class="section-label">Capabilities</div>

        <!-- Capability packages (D10 / C1-P3). Everything the package or the
             archive carries (author, purpose, body, component displayNames,
             diagnostic messages) is UNTRUSTED model-adjacent content: it is
             rendered exclusively through text interpolation — never v-html,
             never innerHTML, never a URL attribute. The body is a plain
             monospace, line-preserving text block; no Markdown rendering. -->

        <!-- Import confirmation dialog (both entry points share it) -->
        <div v-if="store.capabilityImport" class="capability-import-dialog" data-testid="capability-import-dialog">
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
          <div class="capability-row capability-import-row">
            <button class="rail-btn" type="button" data-testid="capability-import-file"
              :disabled="store.busy || store.cancelling" @click="pickImportFile">Import .locus file</button>
            <input ref="importFileInput" data-testid="capability-import-file-input" type="file" accept=".locus"
              style="display:none" @change="onImportFileChanged">
            <input class="capability-import-path" data-testid="capability-import-path" v-model="importPath"
              type="text" placeholder="/mnt/download/example.locus" spellcheck="false" autocomplete="off">
            <button class="rail-btn" type="button" data-testid="capability-import-path-button"
              :disabled="store.busy || store.cancelling" @click="importFromPath">Import from path</button>
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
            <div class="capability-row">
              <span class="capability-name">{{ p.id }}</span>
              <span class="mono">{{ p.version }}</span>
              <span class="hint">Not loaded</span>
              <button v-if="uninstallArmId !== p.id" class="rail-btn danger" type="button"
                :disabled="store.busy || store.cancelling"
                :data-testid="'capability-package-uninstall-' + p.id" @click="uninstallArmId = p.id">Uninstall</button>
              <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                :data-testid="'capability-package-uninstall-confirm-' + p.id" @click="uninstallPackage(p.id)">Confirm uninstall</button>
            </div>
            <div v-if="packageNoticesById[p.id]" class="hint" :data-testid="'capability-package-reason-' + p.id">
              {{ packageNoticesById[p.id].status }}: {{ packageNoticesById[p.id].message }}
            </div>
            <div v-if="uninstallArmId === p.id" class="hint">
              Uninstall deletes this package from Locus. The package is removed; its guidance files under
              /home/locus/.skills/{{ p.id }}/ are kept.
            </div>
            <div class="hint">Author (self-declared): {{ p.author }}</div>
            <div v-if="p.purpose" class="hint">Purpose: {{ p.purpose }}</div>
          </div>
        </template>

        <div v-if="!capabilities.length" class="hint" data-testid="capabilities-empty">No optional capabilities available yet.</div>
        <div v-for="c in capabilities" :key="c.id" class="capability-item" :data-testid="'capability-' + c.id">
          <div class="capability-row">
            <span class="capability-name">{{ c.displayName }}</span>
            <span class="capability-state" :data-state="c.state">{{ stateLabel(c) }}</span>
            <button v-if="!c.enabled" class="rail-btn" type="button" :disabled="store.busy || store.cancelling"
              :data-testid="'capability-add-' + c.id" @click="addCapability(c)">Add</button>
            <button v-else-if="removingId !== c.id" class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
              :data-testid="'capability-remove-' + c.id" @click="beginRemoveCapability(c)">Remove</button>
            <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
              :data-testid="'capability-remove-confirm-' + c.id" @click="removeCapability(c)">Confirm remove</button>
          </div>
          <div class="hint">{{ c.description }}</div>
          <div v-if="c.enabled" class="hint" :data-testid="'capability-includes-' + c.id">
            Includes: {{ c.includes.plugins }} local software · {{ c.includes.skills }} guidance · {{ c.includes.mcps }} external connections
          </div>
          <div v-if="c.enabled" class="hint" data-testid="capability-remove-warning">
            Removing this capability disables it and deletes its customized guidance; re-adding it restores the
            default guidance.<span v-if="loadedPackagesById[c.id]"> To delete this package from Locus instead, use
            Uninstall below.</span>
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
          <!-- The installed package this capability came from (D10): shown
               here INSTEAD of a separate installed-list entry. Everything it
               renders is untrusted package metadata via text interpolation. -->
          <div v-if="loadedPackagesById[c.id]" class="capability-package-block"
            :data-testid="'capability-package-' + c.id">
            <div class="capability-row">
              <span class="mono">{{ loadedPackagesById[c.id].id }}</span>
              <span class="mono">{{ loadedPackagesById[c.id].version }}</span>
              <button v-if="uninstallArmId !== c.id" class="rail-btn danger" type="button"
                :disabled="store.busy || store.cancelling"
                :data-testid="'capability-package-uninstall-' + c.id" @click="uninstallArmId = c.id">Uninstall</button>
              <button v-else class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling"
                :data-testid="'capability-package-uninstall-confirm-' + c.id" @click="uninstallPackage(c.id)">Confirm uninstall</button>
            </div>
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
            <div class="hint">Author (self-declared): {{ loadedPackagesById[c.id].author }}</div>
            <div v-if="loadedPackagesById[c.id].purpose" class="hint">Purpose: {{ loadedPackagesById[c.id].purpose }}</div>
          </div>
        </div>
      </section>

      <section class="storage-controls" data-testid="always-allowed-section">
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

      <section class="storage-controls">
        <div class="section-label">Local storage</div>
        <div class="hint">
          {{ storageSummary }}
          <span v-if="store.storageStatus.error">Persistence fallback: {{ store.storageStatus.error }}</span>
        </div>
        <div v-if="store.storageNotice" class="hint storage-notice">{{ store.storageNotice }}</div>
        <button class="rail-btn" type="button" @click="keepStorage">
          {{ store.storageStatus.persistent ? 'Persistent storage granted' : 'Keep Locus data on this device' }}
        </button>
        <div class="storage-actions">
          <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearConversations">Clear conversations</button>
          <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearHome">Clear home</button>
          <button class="rail-btn" type="button" :disabled="store.busy || store.cancelling" @click="clearPlugins">Clear plugins</button>
          <button class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling" @click="forgetApiKeys">Forget API keys</button>
          <button class="rail-btn danger" type="button" :disabled="store.busy || store.cancelling" @click="resetAllData">Reset all local data</button>
        </div>
      </section>

      <div class="modal-actions">
        <button class="primary-btn" type="button" :disabled="store.settingsTesting" @click="testConnection">
          {{ store.settingsTesting ? 'Testing…' : 'Test connection' }}
        </button>
        <button class="rail-btn" type="button" @click="close">Done</button>
      </div>
      <div v-if="store.settingsResult" class="settings-result" :class="{ ok: store.settingsResult.ok }">
        {{ store.settingsResult.message }}
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
  confirmCapabilityImport as confirmImportAction, cancelCapabilityImport,
  acceptCapabilityPackageMismatch, dismissCapabilityPackageNotice,
  uninstallCapabilityPackage,
  connectCredential, disconnectCredential, reconfirmCredential,
  credentialSummary, credentialBindingRecord,
  refreshAlwaysAllowed, revokeAlwaysAllowed,
} from '../ui/store.js';
import { computed, onMounted, ref, watch } from 'vue';

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
// above the buttons states that semantics permanently.
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

// The send rule, stated the same way in the row and the Connect dialog.
// Scheme null means the header value IS the key — no "Bearer …" shown.
function credentialSendLine(decl) {
  if (!decl) return '';
  return 'Only sent to ' + decl.origin + decl.pathPrefix + ' as ' + decl.header
    + (decl.scheme ? ': ' + decl.scheme + ' …' : '');
}

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
});

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

async function confirmImport() {
  importing.value = true;
  try {
    await confirmImportAction();
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
