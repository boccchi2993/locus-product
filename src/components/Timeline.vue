<template>
  <div class="timeline">
    <template v-for="item in conversation.items" :key="item.id">
      <!-- user message: quiet warm bubble, right of the content column.
           Image attachments render as a count chip only — pixels never
           enter the presentation timeline. -->
      <div v-if="item.kind === 'user'" class="item item-user">
        <div class="user-bubble">
          <span v-if="item.imageCount" class="user-image-chip" title="Image attachment sent with this message">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="1.5"/>
              <path d="m2 11 3.5-3.5 2.5 2.5L11 7l3 3"/>
              <circle cx="6" cy="6.2" r="1"/>
            </svg>
            {{ item.imageCount }} {{ item.imageCount === 1 ? 'image' : 'images' }}
          </span>
          <!-- @-mention fragments render as plain text interpolation
               (splitMentionFragments — never v-html); a recognized
               capability mention gets the same soft pill as the
               composer. History is recognized against the CURRENTLY
               installed capabilities. -->
          <span class="user-text"><template v-for="(f, i) in mentionFragments(item.content)" :key="i"><span
              v-if="f.mention" class="mention-mark" :data-mention="f.mention">{{ f.text }}</span><span
              v-else>{{ f.text }}</span></template></span>
        </div>
      </div>

      <ReasoningItem v-else-if="item.kind === 'reasoning'" :item="item" />
      <ToolCallItem v-else-if="item.kind === 'tool'" :item="item" />
      <ToolResultItem v-else-if="item.kind === 'tool_result'" :item="item" :standalone="true" />

      <!-- assistant final text: blends into the page, no card.
           markdown-lite segment rendering: html segments go through
           v-html (input fully escaped before any syntax runs), code
           blocks become a live block (copy button, raw text via text
           interpolation) and sandbox: file links become FileCards.
           Under the task's LAST assistant message the files written
           during the task (if any) render as the 本次生成的文件 row. -->
      <div v-else-if="item.kind === 'assistant'" class="item item-assistant">
        <div class="assistant-text">
          <template v-for="(seg, si) in segments(item.content)" :key="si">
            <div v-if="seg.type === 'code'" class="md-code" data-testid="md-code-block">
              <div class="md-code-head">
                <span v-if="seg.lang" class="md-code-lang">{{ seg.lang }}</span>
                <button
                  class="md-code-copy"
                  type="button"
                  :data-testid="'code-copy-' + si"
                  @click="copyCode(seg, $event)"
                >Copy</button>
              </div>
              <pre><code>{{ seg.code }}</code></pre>
            </div>
            <FileCard v-else-if="seg.type === 'file'" :path="seg.path" />
            <div v-else class="md-html" v-html="seg.html"></div>
          </template>
          <div
            v-if="taskOutputFiles(item).length"
            class="task-files"
            data-testid="task-output-files"
          >
            <span class="task-files-label">本次生成的文件</span>
            <FileCard v-for="f in taskOutputFiles(item)" :key="f" :path="f" />
          </div>
        </div>
      </div>

      <div v-else-if="item.kind === 'warning'" class="item item-warning">
        <span class="state-glyph">!</span>{{ item.message }}
      </div>
      <div v-else-if="item.kind === 'error'" class="item item-error">
        <span class="state-glyph">×</span>{{ item.message }}
      </div>
    </template>

    <div v-if="conversation.status === 'running'" class="item item-working">
      <span class="working-dot"></span>Working…
    </div>
  </div>
</template>

<script setup>
import ReasoningItem from './ReasoningItem.vue';
import ToolCallItem from './ToolCallItem.vue';
import ToolResultItem from './ToolResultItem.vue';
import FileCard from './FileCard.vue';
import { LocusMarkdown } from '../ui/markdown.js';
import { store } from '../ui/store.js';
import { splitMentionFragments } from '../ui/mentions.js';

const props = defineProps({ conversation: { type: Object, required: true } });

// Parsed segments memoize per content string: timeline items are
// immutable once appended, so the parse runs once per message.
const segCache = new Map();
const segments = (text) => {
  if (!segCache.has(text)) {
    if (segCache.size > 400) segCache.clear();
    segCache.set(text, LocusMarkdown.renderSegments(text));
  }
  return segCache.get(text);
};

const lastAssistantItem = () => {
  const items = props.conversation.items || [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i] && items[i].kind === 'assistant') return items[i];
  }
  return null;
};

// Files written under /mnt/download during THIS task (store.js journals
// every provider write and diffs against the task_start snapshot, then
// attaches them to the task's last assistant message), minus the paths
// THIS message already shows as sandbox: cards.
const taskOutputFiles = (item) => {
  const files = item && item.taskOutputFiles;
  if (!Array.isArray(files) || !files.length) return [];
  const linked = new Set(LocusMarkdown.extractSandboxPaths(item.content));
  return files.filter((p) => !linked.has(p));
};

// Copies the RAW code block text. Clipboard API first; the execCommand
// fallback covers denied permissions (headless, non-focused windows).
const copyCode = async (seg, ev) => {
  const btn = ev && ev.currentTarget;
  let ok = false;
  try {
    await navigator.clipboard.writeText(seg.code);
    ok = true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = seg.code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e2) { ok = false; }
  }
  if (btn) {
    const prev = 'Copy';
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  }
};

// The same recognition the composer used at send time, re-run against
// the CURRENTLY installed capability ids (history stays honest about
// what is a capability mention on this page session).
const mentionFragments = (text) =>
  splitMentionFragments(text, (store.capabilities || []).map((c) => c.id));
</script>
