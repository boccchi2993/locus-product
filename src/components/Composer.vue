<template>
  <div class="composer-wrap" :class="{ centered }">
    <!-- pending uploads: real File objects already in the VFS at
         /mnt/upload (read-only to the agent); the title shows the real
         final VFS path -->
    <div v-if="store.attachments.length" class="attach-row">
      <span v-for="(a, i) in store.attachments" :key="i" class="attach-chip" :title="a.path">
        <span v-if="a.image" class="attach-kind">Image</span>
        <span class="attach-name">{{ a.name }}</span>
        <button type="button" class="attach-x" :aria-label="'Remove ' + a.name" @click="removeAttachment(i)">×</button>
      </span>
    </div>

    <div class="composer" :class="{ busy: store.busy }">
      <!-- The textarea stays the single editable surface (no
           contenteditable). The mirror div sits BEHIND it with identical
           text metrics and invisible glyphs; recognized @-mention spans
           paint a soft accent pill that shows through the transparent
           textarea background under the normal-colored text. -->
      <div class="composer-input-wrap">
        <div ref="mirrorEl" class="composer-mirror" aria-hidden="true" data-testid="composer-mirror"><span
            v-for="(f, i) in draftFragments" :key="i"
            :class="f.mention ? 'mention-mark' : null">{{ f.text }}</span></div>
        <textarea
          ref="ta"
          v-model="draft"
          class="composer-input"
          :placeholder="placeholder"
          rows="1"
          @keydown="onKeydown"
          @input="onInput"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @blur="onBlur"
          @scroll="syncMirrorScroll"
        ></textarea>
      </div>

      <!-- @-mention candidate popup (owner task 2026-10-29): opens while
           the caret sits right after a boundary-valid "@…" fragment.
           Same surface/border/radius/item tokens as the "+" menu;
           anchored above the input, left-aligned with it, flipping below
           when the viewport has no room above. -->
      <div v-if="mention.open && mentionCandidates.length" ref="mentionMenuEl" class="mention-menu"
        :class="{ below: mention.below }" role="listbox" aria-label="Capability mentions"
        data-testid="composer-mention-menu">
        <div class="plus-menu-title">Capabilities</div>
        <div class="mention-list" data-testid="composer-mention-list">
          <div v-for="(c, i) in mentionCandidates" :key="c.id" class="plus-item mention-option" role="option"
            :aria-selected="i === mention.active ? 'true' : 'false'"
            :class="{ active: i === mention.active }"
            :data-testid="'composer-mention-option-' + c.id"
            @mousedown.prevent="insertMentionCandidate(c)" @mouseenter="mention.active = i">
            <span class="plus-cap-id">@{{ c.id }}</span>
            <span class="plus-cap-name">{{ c.displayName || c.id }}</span>
            <span v-if="!c.enabled" class="mention-will-enable">will be enabled when sent</span>
            <span v-else class="capability-state" :data-state="c.state">{{ stateText(c) }}</span>
          </div>
        </div>
      </div>

      <div class="composer-bar">
        <div class="composer-left">
          <button ref="plusBtnEl" class="icon-btn plus-btn" type="button" title="Add context" aria-label="Add context" @click.stop="togglePlusMenu">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>

          <button class="ws-chip" type="button" :title="store.workspaceName ? 'Change folder' : 'Mount folder'" @click="mountFolder">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z"/>
            </svg>
            {{ store.workspaceName || 'Mount folder' }}
          </button>
        </div>

        <div class="composer-right">
          <span class="model-label" :title="'Model — change in Settings'">{{ store.settings.model }}</span>
          <button
            v-if="store.busy"
            class="send-btn cancel-btn"
            type="button"
            :disabled="store.cancelling"
            @click="cancelTask"
          >{{ store.cancelling ? 'Cancelling…' : 'Cancel' }}</button>
          <button
            v-else
            class="send-btn"
            type="button"
            :disabled="!draft.trim() || store.pendingApproval"
            title="Send (Enter)"
            aria-label="Send"
            @click="send"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M8 12.5v-9M3.5 8 8 3.5 12.5 8"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- "+" context menu. Desktop (>640px, hover pointer): a Windows-style
           cascade — Capabilities › Add capability › import sources, the
           capability list as the second level. Narrow viewports and touch
           devices enter the same content STEP BY STEP in one panel with a
           "‹ Back" row (no cascade). The import confirmation itself is the
           global CapabilityImportDialog; these entries only BEGIN imports.
           Clicking a capability row never touches its enabled state — it
           inserts an @mention into the composer (UI-MENTION). -->
      <div v-if="store.plusMenuOpen" class="plus-backdrop" @click="closeMenu()"></div>
      <div v-if="store.plusMenuOpen" ref="menuRoot" class="plus-menu" role="menu" aria-label="Add context"
        @click.stop>
        <!-- stepped mode header: Back replaces the title on levels 2/3 -->
        <button v-if="stepped && step > 1" class="plus-item plus-back" type="button"
          role="menuitem" data-menu-level="1" data-testid="plus-menu-back" @click="backStep">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M10 3.5 5.5 8 10 12.5"/>
          </svg>
          <span>Back</span>
        </button>
        <div v-else class="plus-menu-title">Add context</div>

        <!-- ============ level 1 ============ -->
        <template v-if="!stepped || step === 1">
          <button class="plus-item" type="button" role="menuitem" data-menu-level="1"
            @mouseenter="plainEnter(1)" @click="closeMenu(); uploadFiles()">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M8 10.5v-7M5 6l3-3 3 3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>
            </svg>
            <span>Upload files</span>
          </button>
          <button class="plus-item" type="button" role="menuitem" data-menu-level="1"
            @mouseenter="plainEnter(1)" @click="closeMenu(); mountFolder()">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z"/>
            </svg>
            <span>Mount folder</span>
          </button>
          <!-- the cascade root: opens the Capabilities panel (level 2) -->
          <div class="plus-anchor">
            <button class="plus-item" type="button" role="menuitem" data-menu-level="1"
              data-testid="plus-capabilities" data-sub-level="1"
              aria-haspopup="true" :aria-expanded="stepped ? false : openLevel >= 1"
              @mouseenter="subEnter(1)" @click="openSub(1)">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
                <rect x="2.5" y="2.5" width="4.4" height="4.4" rx="1"/>
                <rect x="9.1" y="2.5" width="4.4" height="4.4" rx="1"/>
                <rect x="2.5" y="9.1" width="4.4" height="4.4" rx="1"/>
                <rect x="9.1" y="9.1" width="4.4" height="4.4" rx="1"/>
              </svg>
              <span>Capabilities</span>
              <svg class="plus-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M6 3.5 10.5 8 6 12.5"/>
              </svg>
            </button>

            <!-- ============ level 2: Capabilities ============ -->
            <div v-if="!stepped && openLevel >= 1" class="plus-sub" role="menu" aria-label="Capabilities"
              data-testid="composer-capabilities-menu" @mouseenter="subEnter(1)">
              <div class="plus-anchor plus-fixed-head">
                <button class="plus-item" type="button" role="menuitem" data-menu-level="2"
                  data-testid="plus-add-capability" data-sub-level="2"
                  aria-haspopup="true" :aria-expanded="openLevel >= 2"
                  @mouseenter="subEnter(2)" @click="openSub(2)">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
                    <path d="M8 3v10M3 8h10"/>
                  </svg>
                  <span>Add capability</span>
                  <svg class="plus-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6">
                    <path d="M6 3.5 10.5 8 6 12.5"/>
                  </svg>
                </button>

                <!-- ============ level 3: Add capability ============ -->
                <div v-if="openLevel >= 2" class="plus-sub" role="menu" aria-label="Add capability"
                  data-testid="composer-add-capability-menu" @mouseenter="subEnter(2)">
                  <button class="plus-item" type="button" role="menuitem" data-menu-level="3"
                    data-testid="composer-import-from-file"
                    @mouseenter="plainEnter(3)" @click="importFromFile()">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M4 1.5h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM9 1.5v3h3"/>
                    </svg>
                    <span>From file…</span>
                  </button>
                  <button class="plus-item" type="button" role="menuitem" data-menu-level="3"
                    data-testid="composer-import-from-path"
                    :aria-expanded="pathEntryOpen"
                    @mouseenter="plainEnter(3)" @click="togglePathEntry()">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M4 1.5h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM9 1.5v3h3"/>
                    </svg>
                    <span>From path…</span>
                  </button>
                  <!-- inline single-line entry (never window.prompt) -->
                  <div v-if="pathEntryOpen" class="plus-path-entry">
                    <input
                      ref="pathInput"
                      v-model="pathDraft"
                      type="text"
                      data-testid="composer-import-path-input"
                      placeholder="/mnt/download/example.locus"
                      spellcheck="false" autocomplete="off"
                      aria-label="Import capability package from VFS path"
                      @keydown.enter.prevent="submitPathEntry">
                    <button class="plus-path-import" type="button"
                      data-testid="composer-import-path-import" @click="submitPathEntry">Import</button>
                  </div>
                  <div class="plus-sep" role="separator"></div>
                  <div class="plus-scroll plus-files" data-testid="composer-locus-list">
                    <button v-for="f in locusFiles" :key="f.path" class="plus-item" type="button"
                      role="menuitem" data-menu-level="3"
                      :data-testid="'composer-locus-file-' + f.name"
                      :title="f.path"
                      @mouseenter="plainEnter(3)" @click="importLocusFile(f)">
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
                        <path d="M4 1.5h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM9 1.5v3h3"/>
                      </svg>
                      <span class="plus-file-name">{{ f.name }}</span>
                      <span class="plus-file-size">{{ humanSize(f.size) }}</span>
                    </button>
                    <div v-if="!locusFiles.length" class="plus-empty" data-testid="composer-locus-empty">
                      No .locus files in /mnt/download
                    </div>
                  </div>
                </div>
              </div>

              <div class="plus-sep" role="separator"></div>
              <!-- installed / built-in capabilities, enabled first. A row
                   click inserts an @mention; it NEVER enables, disables or
                   otherwise manages the capability (settings only). -->
              <div class="plus-scroll" data-testid="composer-capability-list">
                <div v-for="c in capRows" :key="c.id" class="plus-item plus-cap-row" role="menuitem"
                  data-menu-level="2" tabindex="-1"
                  :data-testid="'composer-capability-' + c.id"
                  @mouseenter="plainEnter(2)" @click="insertMention(c)">
                  <span class="plus-cap-id">@{{ c.id }}</span>
                  <span class="plus-cap-name">{{ c.displayName || c.id }}</span>
                  <span class="capability-state" :data-state="c.state || 'disabled'">{{ stateText(c) }}</span>
                  <button v-if="c.state === 'needs-connection' || c.state === 'error'" class="plus-cap-settings"
                    type="button" :data-testid="'composer-capability-settings-' + c.id"
                    :aria-label="'Open settings for ' + c.id"
                    @click.stop="openCapabilitySettings(c.id)">Settings…</button>
                </div>
                <div v-if="!capRows.length" class="plus-empty" data-testid="composer-capabilities-empty">
                  No capabilities yet
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- ============ stepped mode: levels 2 / 3 in the same panel ============ -->
        <template v-if="stepped && step === 2">
          <div class="plus-anchor">
            <button class="plus-item" type="button" role="menuitem" data-menu-level="2"
              data-testid="plus-add-capability" data-sub-level="2"
              aria-haspopup="true" aria-expanded="false"
              @click="openSub(2)">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="M8 3v10M3 8h10"/>
              </svg>
              <span>Add capability</span>
              <svg class="plus-chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M6 3.5 10.5 8 6 12.5"/>
              </svg>
            </button>
          </div>
          <div class="plus-sep" role="separator"></div>
          <div class="plus-scroll" data-testid="composer-capability-list">
            <div v-for="c in capRows" :key="c.id" class="plus-item plus-cap-row" role="menuitem"
              data-menu-level="2" tabindex="-1"
              :data-testid="'composer-capability-' + c.id"
              @click="insertMention(c)">
              <span class="plus-cap-id">@{{ c.id }}</span>
              <span class="plus-cap-name">{{ c.displayName || c.id }}</span>
              <span class="capability-state" :data-state="c.state || 'disabled'">{{ stateText(c) }}</span>
              <button v-if="c.state === 'needs-connection' || c.state === 'error'" class="plus-cap-settings"
                type="button" :data-testid="'composer-capability-settings-' + c.id"
                :aria-label="'Open settings for ' + c.id"
                @click.stop="openCapabilitySettings(c.id)">Settings…</button>
            </div>
            <div v-if="!capRows.length" class="plus-empty" data-testid="composer-capabilities-empty">
              No capabilities yet
            </div>
          </div>
        </template>
        <template v-if="stepped && step === 3">
          <button class="plus-item" type="button" role="menuitem" data-menu-level="3"
            data-testid="composer-import-from-file" @click="importFromFile()">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M4 1.5h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM9 1.5v3h3"/>
            </svg>
            <span>From file…</span>
          </button>
          <button class="plus-item" type="button" role="menuitem" data-menu-level="3"
            data-testid="composer-import-from-path"
            :aria-expanded="pathEntryOpen"
            @click="togglePathEntry()">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M4 1.5h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM9 1.5v3h3"/>
            </svg>
            <span>From path…</span>
          </button>
          <div v-if="pathEntryOpen" class="plus-path-entry">
            <input
              ref="pathInput"
              v-model="pathDraft"
              type="text"
              data-testid="composer-import-path-input"
              placeholder="/mnt/download/example.locus"
              spellcheck="false" autocomplete="off"
              aria-label="Import capability package from VFS path"
              @keydown.enter.prevent="submitPathEntry">
            <button class="plus-path-import" type="button"
              data-testid="composer-import-path-import" @click="submitPathEntry">Import</button>
          </div>
          <div class="plus-sep" role="separator"></div>
          <div class="plus-scroll plus-files" data-testid="composer-locus-list">
            <button v-for="f in locusFiles" :key="f.path" class="plus-item" type="button"
              role="menuitem" data-menu-level="3"
              :data-testid="'composer-locus-file-' + f.name"
              :title="f.path"
              @click="importLocusFile(f)">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
                <path d="M4 1.5h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM9 1.5v3h3"/>
              </svg>
              <span class="plus-file-name">{{ f.name }}</span>
              <span class="plus-file-size">{{ humanSize(f.size) }}</span>
            </button>
            <div v-if="!locusFiles.length" class="plus-empty" data-testid="composer-locus-empty">
              No .locus files in /mnt/download
            </div>
          </div>
        </template>
      </div>
    </div>
    <!-- @-mention send outcome lines: a mentioned capability whose enable
         ended in state error blocks the send (the draft is preserved);
         a mentioned capability left in needs-connection still sent. Both
         point at the capability's settings card. -->
    <div v-if="sendErrors.length" class="composer-notice composer-notice-error" data-testid="composer-mention-error">
      <div v-for="e in sendErrors" :key="e.id" class="composer-notice-row">
        <span class="composer-notice-cap">@{{ e.id }}</span>
        <span class="composer-notice-text">{{ e.message }}</span>
        <button class="plus-cap-settings" type="button"
          :data-testid="'composer-mention-error-settings-' + e.id"
          :aria-label="'Open settings for ' + e.id" @click="openCapabilitySettings(e.id)">Settings…</button>
      </div>
    </div>
    <div v-if="sendNotices.length" class="composer-notice composer-notice-soft" data-testid="composer-mention-notice">
      <div v-for="n in sendNotices" :key="n.id" class="composer-notice-row">
        <span class="composer-notice-cap">@{{ n.id }}</span>
        <span class="composer-notice-text">needs a connection before it can run in this task</span>
        <button class="plus-cap-settings" type="button"
          :data-testid="'composer-mention-notice-settings-' + n.id"
          :aria-label="'Open settings for ' + n.id" @click="openCapabilitySettings(n.id)">Settings…</button>
      </div>
    </div>
    <div class="composer-caption">Files and Python run locally in your browser. Model requests and explicit network calls may leave this machine.</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, watch, onBeforeUnmount } from 'vue';
import {
  store, submitWithMentions, cancelTask, togglePlusMenu,
  uploadFiles, removeAttachment, mountFolder,
  beginCapabilityImportFromBytes, beginCapabilityImportFromPath,
  openCapabilitySettings, listDownloadLocusFiles,
} from '../ui/store.js';
import { splitMentionFragments, mentionQueryBefore } from '../ui/mentions.js';

defineProps({ centered: { type: Boolean, default: false } });

const draft = ref('');
const ta = ref(null);

const placeholder = computed(() => {
  if (store.pendingApproval) return 'Waiting for approval…';
  return store.busy ? 'Working… (Esc to cancel)' : 'Describe a task for your workspace…';
});

// ---------- @-mentions: mirror highlight + candidate popup ----------
// Recognition lives in src/ui/mentions.js (pure, unit-tested); this
// component only projects it onto the draft: mirror fragments recompute
// on every keystroke, so an edited mention that stops being an installed
// id loses its pill immediately.
const mirrorEl = ref(null);
const draftFragments = computed(() =>
  splitMentionFragments(draft.value, (store.capabilities || []).map((c) => c.id)));

const mention = reactive({ open: false, at: -1, query: '', active: 0, below: false });
const mentionMenuEl = ref(null);
let mentionSuppressed = false; // Esc: stay closed until the text changes again
let composing = false;         // an IME composition is in progress
let sendInFlight = false;
const sendErrors = ref([]);
const sendNotices = ref([]);

// Same order as the "+" menu's capability list: enabled first, then id.
const mentionCandidates = computed(() => {
  if (!mention.open) return [];
  const q = mention.query.toLowerCase();
  return capRows.value.filter((c) => !q
    || c.id.toLowerCase().includes(q)
    || String(c.displayName || '').toLowerCase().includes(q));
});

function closeMention() {
  if (!mention.open) return;
  mention.open = false;
  mention.at = -1;
  mention.query = '';
  mention.active = 0;
}

// Re-evaluate the popup from the LIVE textarea value + caret (not the
// draft — v-model flushes composition text late, and the popup must be
// exact the moment composition ends).
function refreshMention() {
  const el = ta.value;
  if (!el || composing || mentionSuppressed) {
    closeMention();
    return;
  }
  const hit = mentionQueryBefore(el.value, el.selectionStart);
  if (!hit) {
    closeMention();
    return;
  }
  if (mention.at !== hit.at || mention.query !== hit.query) mention.active = 0;
  mention.open = true;
  mention.at = hit.at;
  mention.query = hit.query;
  nextTick(placeMentionMenu);
}

function onInput() {
  mentionSuppressed = false;
  autogrow();
  refreshMention();
}

function onCompositionStart() {
  composing = true;
  closeMention();
}

function onCompositionEnd() {
  composing = false;
  // v-model flushes the composed text with this same event; re-evaluate
  // once it has landed.
  nextTick(refreshMention);
}

function onBlur() {
  closeMention();
}

function onSelectionChange() {
  if (!mention.open) return;
  if (document.activeElement !== ta.value) {
    closeMention();
    return;
  }
  refreshMention();
}
document.addEventListener('selectionchange', onSelectionChange);
onBeforeUnmount(() => document.removeEventListener('selectionchange', onSelectionChange));

// Mirror/textarea pixel sync: same scrollTop, and — when the textarea
// shows a scrollbar — the same effective wrap width (its content box
// shrinks by the scrollbar; the mirror has none).
function syncMirrorScroll() {
  const el = ta.value;
  const m = mirrorEl.value;
  if (!el || !m) return;
  m.style.paddingRight = Math.max(0, el.offsetWidth - el.clientWidth) + 'px';
  m.scrollTop = el.scrollTop;
}

// Insert the selected candidate: the "@…partial" before the caret becomes
// "@<id> ", caret after it. While the popup is open Enter NEVER submits.
function insertMentionCandidate(c) {
  const el = ta.value;
  if (!el) return;
  const text = el.value;
  const caret = typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
  const hit = mentionQueryBefore(text, caret);
  closeMention();
  if (!hit) return;
  const insert = '@' + c.id + ' ';
  const before = text.slice(0, hit.at) + insert;
  draft.value = before + text.slice(caret);
  // The textarea is not part of the re-rendered popup subtree, so the
  // DOM value can be synced by hand right here (same trick as
  // insertMention — v-model catches up with the same string on flush).
  el.value = draft.value;
  el.focus();
  el.setSelectionRange(before.length, before.length);
  mentionSuppressed = false;
  autogrow();
}

function placeMentionMenu() {
  const menu = mentionMenuEl.value;
  const host = menu && menu.parentElement;
  if (!menu || !host) return;
  mention.below = host.getBoundingClientRect().top < menu.offsetHeight + 24;
}

// ---------- send: enable mentioned capabilities, then submit ----------
// submitWithMentions (store) recognizes the mentions, enables the ones
// not enabled yet (the settings panel Add action), and submits only when
// every mentioned capability resolved. status 'blocked' keeps the draft
// and shows the error line; a needs-connection capability still sent
// shows the soft notice line.
async function send() {
  const text = draft.value;
  // A pending approval suspends the running task — it must never be
  // bypassed (or double-tracked) by submitting over it. busy/cancelling:
  // nothing is sent and nothing is enabled.
  if (!text.trim() || store.busy || store.cancelling || store.pendingApproval) return;
  if (sendInFlight) return;
  sendInFlight = true;
  closeMention();
  sendErrors.value = [];
  sendNotices.value = [];
  let outcome;
  try {
    outcome = await submitWithMentions(text);
  } finally {
    sendInFlight = false;
  }
  if (outcome.status === 'sent') {
    // Only clear the draft if the user did not keep typing during the
    // enable window; their newer text stays untouched then.
    if (draft.value === text) {
      draft.value = '';
      autogrow();
    }
    if (outcome.needsConnection.length) sendNotices.value = outcome.needsConnection;
  } else if (outcome.status === 'blocked') {
    sendErrors.value = outcome.errors;
  }
}

function onKeydown(e) {
  // IME composition: never intercept — Enter/arrows belong to the
  // composition until it ends (the popup stays closed meanwhile).
  if (e.isComposing) return;
  const candidates = mentionCandidates.value;
  if (mention.open && candidates.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mention.active = (mention.active + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMentionCandidate(candidates[mention.active]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      mentionSuppressed = true;
      closeMention();
      return;
    }
  }
  // Enter submits, Shift+Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function autogrow() {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  syncMirrorScroll();
}

// ---------- the "+" cascading menu ----------
// Desktop: three levels — 1 Add context, 2 Capabilities, 3 Add capability.
// openLevel is the DEEPEST open submenu (0 = level 1 only, 1 = Capabilities
// open, 2 = Add capability open). Narrow viewports (<640px) and touch
// devices never cascade: the same content is entered step by step in one
// panel (`step`), with a "‹ Back" row.
const OPEN_DELAY_MS = 150;   // hover before a submenu opens
const CLOSE_GRACE_MS = 300;  // tolerance before a submenu closes
const STEPPED_WIDTH = '(max-width: 639px)';

const menuRoot = ref(null);
const pathInput = ref(null);
const plusBtnEl = ref(null);
const openLevel = ref(0);
const stepped = ref(false);
const step = ref(1);
const pathEntryOpen = ref(false);
const pathDraft = ref('');
const locusFiles = ref([]);

let openTimer = null;
let closeTimer = null;

const capRows = computed(() => (store.capabilities || []).slice()
  .sort((a, b) => ((b.enabled ? 1 : 0) - (a.enabled ? 1 : 0))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

function stateText(c) {
  if (!c.enabled) return 'not enabled';
  return { ready: 'Ready', 'needs-connection': 'Connection required', error: 'Error', disabled: 'Not added' }[c.state] || c.state;
}

function humanSize(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function clearTimers() {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}

// Hover on a submenu parent (or inside its panel): cancel pending closes,
// open this submenu after the 150ms delay.
function subEnter(subLevel) {
  if (stepped.value) return;
  clearTimers();
  openTimer = setTimeout(() => {
    openTimer = null;
    openLevel.value = Math.max(openLevel.value, subLevel);
    onLevelOpen(subLevel);
    nextTick(placePanels);
  }, OPEN_DELAY_MS);
}

// Hover on a plain item of level L: deeper submenus close after the grace
// period (the tolerance that keeps diagonally-traveling pointers alive).
function plainEnter(itemLevel) {
  if (stepped.value) return;
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (openLevel.value > itemLevel - 1) {
      openLevel.value = itemLevel - 1;
      nextTick(placePanels);
    }
  }, CLOSE_GRACE_MS);
}

// Pointer left the whole menu: nothing closes by itself. Panels stay open
// until an outside click (plus-backdrop), Escape, or an activation closes
// them — the Windows/macOS convention the owner asked for; the 300ms
// grace below only smooths moves BETWEEN items.

// Click / keyboard activation of a submenu parent — toggles its level.
function openSub(subLevel) {
  if (stepped.value) {
    step.value = subLevel + 1;
    onLevelOpen(subLevel);
    nextTick(focusFirstItem);
    return;
  }
  clearTimers();
  // Toggle: an open submenu (and everything inside it) closes; a closed
  // one opens together with its ancestors.
  openLevel.value = openLevel.value >= subLevel ? subLevel - 1 : subLevel;
  if (openLevel.value >= subLevel) onLevelOpen(subLevel);
  nextTick(placePanels);
}

// Level 3 lists the .locus packages ONCE per open — a fresh VFS read.
function onLevelOpen(subLevel) {
  if (subLevel === 2) {
    listDownloadLocusFiles().then((files) => { locusFiles.value = files; }).catch(() => { locusFiles.value = []; });
  }
}

function backStep() {
  if (step.value > 1) {
    step.value -= 1;
    nextTick(focusFirstItem);
  }
}

function togglePathEntry() {
  pathEntryOpen.value = !pathEntryOpen.value;
  if (pathEntryOpen.value) {
    nextTick(() => { if (pathInput.value) pathInput.value.focus(); });
  }
}

function submitPathEntry() {
  const p = pathDraft.value.trim();
  if (!p) return;
  pathDraft.value = '';
  pathEntryOpen.value = false;
  closeMenu();
  beginCapabilityImportFromPath(p);
}

function importLocusFile(f) {
  closeMenu();
  beginCapabilityImportFromPath(f.path);
}

function importFromFile() {
  closeMenu();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.locus';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await beginCapabilityImportFromBytes(bytes, file.name);
  });
  input.click();
}

// A capability row inserts an @mention at the composer caret: a space is
// added first when the preceding character is not whitespace/line start.
// The menu closes and the caret lands after the inserted text. This never
// enables, disables or "checks" anything — capability management lives in
// the settings panel only.
function insertMention(c) {
  const el = ta.value;
  const text = draft.value;
  const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
  const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  const caret = Math.min(start, end);
  const before = text.slice(0, caret);
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const insert = (needsSpace ? ' ' : '') + '@' + c.id + ' ';
  draft.value = before + insert + text.slice(Math.max(start, end));
  closeMenu();
  // The textarea is NOT part of the unmounting menu subtree, so focus +
  // caret can land synchronously: sync the DOM value by hand (v-model
  // catches up with the same string on flush), otherwise the caret clamp
  // would still see the pre-insert value.
  if (el) {
    el.value = draft.value;
    el.focus();
    const at = (before + insert).length;
    el.setSelectionRange(at, at);
    autogrow();
  }
}

function closeMenu(refocus) {
  store.plusMenuOpen = false;
  if (refocus && plusBtnEl.value) plusBtnEl.value.focus();
}

// ---------- open/close lifecycle ----------
watch(() => store.plusMenuOpen, (open) => {
  if (open) {
    stepped.value = isSteppedViewport();
    openLevel.value = 0;
    step.value = 1;
    pathEntryOpen.value = false;
    pathDraft.value = '';
    locusFiles.value = [];
    document.addEventListener('keydown', onGlobalKeydown, true);
    window.addEventListener('resize', placePanels);
    nextTick(() => { focusFirstItem(); placePanels(); });
  } else {
    clearTimers();
    openLevel.value = 0;
    step.value = 1;
    pathEntryOpen.value = false;
    document.removeEventListener('keydown', onGlobalKeydown, true);
    window.removeEventListener('resize', placePanels);
  }
});

onBeforeUnmount(() => {
  clearTimers();
  document.removeEventListener('keydown', onGlobalKeydown, true);
  window.removeEventListener('resize', placePanels);
});

function isSteppedViewport() {
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia(STEPPED_WIDTH).matches;
  // Touch-first devices only. A bare maxTouchPoints>0 would also catch
  // touch-capable laptops driven by a mouse, and pointerless headless
  // browsers match (hover: none) — hence the conjunction: a REAL touch
  // device has contact points AND no hover-capable primary pointer.
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
    && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
  return !!(narrow || touch);
}

// ---------- keyboard navigation (one document-level handler while open) ----------
function menuItems(level) {
  const root = menuRoot.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll('[role="menuitem"][data-menu-level="' + level + '"]'))
    .filter((el) => !el.disabled && el.getClientRects().length > 0);
}

function activeContentLevel() {
  return stepped.value ? step.value : openLevel.value + 1;
}

// Arrows operate on the level the FOCUS is on when focus sits inside the
// menu (a real keyboard user is always "in" one level), falling back to
// the deepest open level when focus never entered the menu (pure
// hover-driven use).
function activeKeyLevel() {
  const ae = document.activeElement;
  if (menuRoot.value && ae && ae.getAttribute && menuRoot.value.contains(ae)) {
    const lvl = Number(ae.getAttribute('data-menu-level'));
    if (Number.isFinite(lvl) && lvl >= 1) return lvl;
  }
  return activeContentLevel();
}

function onGlobalKeydown(e) {
  if (!store.plusMenuOpen) return;
  const root = menuRoot.value;
  if (!root) return;
  const within = root.contains(e.target) || e.target === document.body;

  if (e.key === 'Escape') {
    // One level back; at the first level the whole menu closes.
    e.preventDefault();
    e.stopPropagation();
    if (activeContentLevel() > 1) goBackOneLevel();
    else closeMenu(true);
    return;
  }
  if (!within) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = menuItems(activeKeyLevel());
    if (!items.length) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement);
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const next = items[idx === -1 ? (dir === 1 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length];
    next.focus();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'Enter') {
    const el = document.activeElement;
    const subLevel = el && el.getAttribute ? el.getAttribute('data-sub-level') : null;
    if (subLevel !== null) {
      e.preventDefault(); // also suppresses the native button click
      openSub(Number(subLevel));
      nextTick(() => { const first = menuItems(Number(subLevel) + 1)[0]; if (first) first.focus(); });
      return;
    }
    if (e.key === 'Enter') {
      // Plain NON-button menuitem (the roving capability rows are divs):
      // activate it. Native buttons activate themselves on Enter.
      if (el && el.tagName !== 'BUTTON' && el.getAttribute && el.getAttribute('role') === 'menuitem') {
        e.preventDefault();
        el.click();
      }
    }
    return;
  }
  if (e.key === 'ArrowLeft') {
    if (activeContentLevel() > 1) {
      e.preventDefault();
      goBackOneLevel();
    }
  }
}

function goBackOneLevel() {
  if (stepped.value) {
    backStep();
    return;
  }
  const closing = openLevel.value;
  openLevel.value = closing - 1;
  nextTick(() => {
    placePanels();
    const parent = menuRoot.value && menuRoot.value.querySelector('[data-sub-level="' + closing + '"]');
    if (parent) parent.focus();
  });
}

function focusFirstItem() {
  const first = menuItems(activeContentLevel())[0];
  if (first) first.focus();
}

// ---------- submenu placement (desktop cascade) ----------
// Default position: right of the parent item, top-aligned with it. If the
// right edge would leave the viewport, the panel flips to the left of the
// parent; if the bottom would overflow, the panel shifts up — it never
// leaves the viewport.
function placePanels() {
  if (stepped.value) return;
  const root = menuRoot.value;
  if (!root) return;
  const margin = 8;
  for (const panel of root.querySelectorAll('.plus-sub')) {
    panel.style.left = '';
    panel.style.right = '';
    panel.style.top = '0px';
    const anchor = panel.parentElement;
    const ar = anchor.getBoundingClientRect();
    let pr = panel.getBoundingClientRect();
    if (pr.width === 0) continue; // not rendered
    if (pr.right > window.innerWidth - margin && ar.left - pr.width >= margin) {
      panel.style.left = 'auto';
      panel.style.right = '100%';
      pr = panel.getBoundingClientRect();
    }
    let dy = Math.min(0, window.innerHeight - margin - pr.bottom);
    if (pr.top + dy < margin) dy = margin - pr.top;
    panel.style.top = dy + 'px';
  }
}
</script>
