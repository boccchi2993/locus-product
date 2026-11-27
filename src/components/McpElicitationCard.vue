<template>
  <!-- C3 phase-2 §8.3: the form elicitation card, rendered at the
       ApprovalCard's position (MainWorkspace.vue). Shown while the
       ApprovalController holds a pending request of the harness
       'elicitation' kind. Everything the SERVER declared (message, field
       titles/descriptions/enums) is untrusted external content: text
       interpolation only — never v-html, never clickable URLs. The three
       buttons are Submit / Decline / Cancel (the spec's MUST: clear
       decline and cancel options; the answer is editable until submit).
       Local validation (§8.3): required and type/enum mismatches block
       the submit with a per-field hint. The answers travel ONLY in the
       approval decision's content — never into the store, storage,
       conversation or tool outputs. -->
  <div v-if="pending && pending.kind === 'elicitation'" ref="cardEl" class="approval-card"
    tabindex="-1" role="group" aria-label="MCP server form"
    data-testid="mcp-elicitation-card">
    <div class="approval-title">MCP server input requested</div>
    <p class="approval-lead">{{ whoAsks }} asks for your input.</p>
    <div class="approval-body" tabindex="0">
      <div class="approval-summary">{{ message }}</div>
      <div v-if="pending.conversationId && pending.conversationId !== store.activeConversationId"
        class="approval-context">Request from running task: {{ fromTitle }}</div>
      <div v-for="field in fields" :key="field.name" class="elicitation-field">
        <label :for="'mcp-elicit-field-' + field.name">{{ field.title }}<span v-if="field.required" class="elicitation-required"> *</span></label>
        <div v-if="field.description" class="hint">{{ field.description }}</div>
        <select v-if="field.enum && field.enum.length" :id="'mcp-elicit-field-' + field.name"
          v-model="values[field.name]" @change="validateLocally()"
          :data-testid="'mcp-elicit-input-' + field.name">
          <option v-for="opt in field.enum" :key="String(opt.value)" :value="opt.value">{{ opt.label }}</option>
        </select>
        <textarea v-else-if="field.type === 'string' && field.long" :id="'mcp-elicit-field-' + field.name"
          v-model="values[field.name]" rows="3" spellcheck="false" @input="validateLocally()"
          :data-testid="'mcp-elicit-input-' + field.name"></textarea>
        <input v-else :id="'mcp-elicit-field-' + field.name" v-model="values[field.name]"
          :type="field.inputType" :spellcheck="false" autocomplete="off" @input="validateLocally()"
          :data-testid="'mcp-elicit-input-' + field.name">
        <div v-if="fieldErrors[field.name]" class="hint storage-notice"
          :data-testid="'mcp-elicit-error-' + field.name">{{ fieldErrors[field.name] }}</div>
      </div>
    </div>
    <div class="approval-actions">
      <!-- Disabled only while a resolution is in flight: the LOCAL
           validation blocks an invalid submit inside submit() (§8.3), so
           a stale field error must never keep the button pressed shut
           after the user fixed the value. -->
      <button type="button" class="approval-btn deny" :disabled="submitting"
        data-testid="mcp-elicit-decline" @click="decline">Decline</button>
      <button type="button" class="approval-btn secondary" :disabled="submitting"
        data-testid="mcp-elicit-cancel" @click="cancel">Cancel</button>
      <button type="button" class="approval-btn primary" :disabled="submitting"
        data-testid="mcp-elicit-submit" @click="submit">Submit</button>
    </div>
    <div class="approval-note">Your answer goes only to this server; it is not kept in the conversation.</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, reactive } from 'vue';
import { store, resolveApproval, cancelApproval } from '../ui/store.js';

const pending = computed(() => {
  const p = store.pendingApproval;
  return p && p.kind === 'elicitation' ? p : null;
});
const cardEl = ref(null);
const submitting = ref(false);

// Who asks: capability name + server name when the port supplied them
// (the resource label carries the server display name; the §8.3 MUST).
const whoAsks = computed(() => {
  const p = pending.value;
  return (p && p.resource && p.resource.label) || 'An MCP server';
});

// The server's message, verbatim (plain text render).
const message = computed(() => {
  const p = pending.value;
  const el = p && p.elicitation;
  return (el && el.message) || '';
});

// The form fields derived from the harness-validated requestedSchema.
// Supported shapes (§8.2): string, number, integer, boolean, single
// enums (enum / enumNames, or oneOf const+title), multi enums (array +
// items). Unknown shapes render a disabled note field — the runtime
// already refuses nested objects with -32602 before the port is called,
// so this is belt and braces.
const fields = computed(() => {
  const p = pending.value;
  const schema = p && p.elicitation && p.elicitation.requestedSchema;
  const props = schema && typeof schema === 'object' ? schema.properties : null;
  if (!props || typeof props !== 'object') return [];
  const required = schema && Array.isArray(schema.required) ? schema.required : [];
  const out = [];
  for (const name of Object.keys(props).slice(0, 32)) {
    const s = props[name];
    if (!s || typeof s !== 'object') continue;
    const type = s.type === 'number' || s.type === 'integer' ? 'number'
      : s.type === 'boolean' ? 'boolean' : 'string';
    let enumList = null;
    if (Array.isArray(s.enum) && s.enum.length) {
      const names = Array.isArray(s.enumNames) && s.enumNames.length === s.enum.length
        ? s.enumNames : null;
      enumList = s.enum.map((v, i) => ({ value: v, label: names ? String(names[i]) : String(v) }));
    } else if (Array.isArray(s.oneOf) && s.oneOf.length) {
      enumList = s.oneOf
        .filter((o) => o && typeof o === 'object' && o.const !== undefined)
        .map((o) => ({ value: o.const, label: o.title !== undefined ? String(o.title) : String(o.const) }));
    } else if (type === 'boolean') {
      enumList = [{ value: true, label: 'Yes' }, { value: false, label: 'No' }];
    }
    out.push({
      name,
      title: s.title !== undefined ? String(s.title) : name,
      description: s.description !== undefined ? String(s.description) : null,
      type,
      inputType: type === 'number' ? 'text' : 'text',
      long: type === 'string' && (s.format === 'textarea' || (s.maxLength || 0) > 120),
      enum: enumList,
      required: required.includes(name),
      default: s.default,
    });
  }
  return out;
});

// The answers, seeded from defaults (§8.3: pre-filled). Lives in a plain
// reactive object rebuilt per request; cleared with the card.
const values = reactive({});
const fieldErrors = reactive({});

function seedValues() {
  for (const k of Object.keys(values)) delete values[k];
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
  for (const f of fields.value) {
    values[f.name] = f.default === undefined ? (f.enum && f.enum.length ? null : '') : f.default;
  }
}

// Local validation per §8.3: required, and a type/enum sanity pass.
// `pattern` is deliberately NOT evaluated (C3 §4.6 — never a local regex).
function validateLocally() {
  const errors = {};
  for (const f of fields.value) {
    const v = values[f.name];
    if (f.required && (v === null || v === undefined || v === '')) {
      errors[f.name] = 'This field is required.';
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    if (f.enum && f.enum.length) {
      if (!f.enum.some((o) => o.value === v)) errors[f.name] = 'Pick one of the listed options.';
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.name] = 'Enter a number.';
    } else if (f.type === 'boolean') {
      if (typeof v !== 'boolean') errors[f.name] = 'Pick Yes or No.';
    }
  }
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
  Object.assign(fieldErrors, errors);
  return Object.keys(errors).length === 0;
}

// Submit sends ONLY the keys the schema declared (§8.3), coerced to the
// declared types. A failed local check keeps the card open.
async function submit() {
  const p = pending.value;
  if (!p || submitting.value) return;
  if (!validateLocally()) return;
  const content = {};
  for (const f of fields.value) {
    const v = values[f.name];
    if (v === undefined) continue;
    if (f.type === 'number' && typeof v === 'string' && v.trim() !== '') content[f.name] = Number(v);
    else content[f.name] = v;
  }
  submitting.value = true;
  try {
    resolveApproval(p.id, { outcome: 'accept', content });
  } finally {
    submitting.value = false;
  }
}

function decline() {
  const p = pending.value;
  if (!p || submitting.value) return;
  resolveApproval(p.id, { outcome: 'decline' });
}

function cancel() {
  const p = pending.value;
  if (!p || submitting.value) return;
  cancelApproval(p.id);
}

const fromTitle = computed(() => {
  const p = pending.value;
  if (!p || !p.conversationId) return null;
  const conv = store.conversations.find((c) => c.id === p.conversationId);
  return conv ? (conv.title || 'running task') : 'running task';
});

// Focus discipline mirrors ApprovalCard: the card container — never a
// button — gets focus; answers stay editable until submit (§8.3).
function focusCard() {
  nextTick(() => {
    const el = cardEl.value;
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  });
}
watch(pending, (p, prev) => {
  if (p) {
    seedValues();
    focusCard();
  } else {
    for (const k of Object.keys(values)) delete values[k];
    for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
    if (prev) {
      nextTick(() => {
        const ta = document.querySelector('.composer-input');
        if (ta && typeof ta.focus === 'function') ta.focus({ preventScroll: true });
      });
    }
  }
}, { immediate: true });
</script>

<style scoped>
.elicitation-field { margin: 8px 0; display: flex; flex-direction: column; gap: 4px; }
.elicitation-field label { font-weight: 600; font-size: 12px; }
.elicitation-required { color: var(--danger, #b00); }
.elicitation-field input,
.elicitation-field textarea,
.elicitation-field select {
  border: 1px solid var(--border, #ccc);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  background: var(--input-bg, #fff);
  color: inherit;
}
</style>
