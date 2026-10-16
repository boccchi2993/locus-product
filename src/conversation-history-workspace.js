// ============================================================
//  PRODUCT: conversation history as a read-only VFS provider.
//  (M2a, repository split — moved verbatim out of src/workspace.js:
//  this is a Product persistence view shaped as a WorkspaceAdapter,
//  not a Runtime filesystem primitive.) Mounted by the product store
//  at /home/locus/history over PersistenceServiceInstance.
//
//  M3c: real ES module. The provider base class and the one path
//  algorithm come from the Runtime public surface through the
//  product runtime API (src/product/runtime-api.js).
// ============================================================
import { WorkspaceAdapter, normalizeWorkspacePath } from './product/runtime-api.js';

// /home/locus/history/<conversationId>/tool-outputs/<sequence>.txt serves
// the FULL output of one tool result, straight from its normalized row
// (docs/CONTEXT-MANAGEMENT.md §3.1). No copy is stored: the file lives and
// dies with the conversation's normalized messages (DECISIONS.md D9).
export const HISTORY_MOUNT_PATH = '/home/locus/history';
const HISTORY_FILES = ['events.jsonl', 'messages.jsonl', 'provider-frames.jsonl'];
const TOOL_OUTPUTS_DIR = 'tool-outputs';

// Absolute model-visible path of one tool result's full output, or null
// when the ids cannot form a safe single path segment.
export function historyToolOutputPath(conversationId, sequence) {
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(conversationId)
    || conversationId === '.' || conversationId === '..') return null;
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  return HISTORY_MOUNT_PATH + '/' + conversationId + '/' + TOOL_OUTPUTS_DIR + '/' + sequence + '.txt';
}

function historyNotFound(path) {
  const e = new Error('no such file or directory: ' + path);
  e.name = 'NotFoundError';
  return e;
}

function toolOutputSequence(name) {
  const m = /^([1-9][0-9]*)\.txt$/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

export class ConversationHistoryWorkspace extends WorkspaceAdapter {
  constructor(service) { super(); this.service = service; this.name = 'history'; }

  _parts(path) {
    const rel = normalizeWorkspacePath(path);
    return rel ? rel.split('/') : [];
  }

  async list(path) {
    const parts = this._parts(path);
    const conversations = await this.service.loadConversations();
    if (!parts.length) return conversations.map((c) => ({ name: c.id, kind: 'directory' }));
    if (parts.length === 1) return [
      ...HISTORY_FILES.map((name) => ({ name, kind: 'file' })),
      { name: TOOL_OUTPUTS_DIR, kind: 'directory' },
    ];
    if (parts.length === 2 && parts[1] === TOOL_OUTPUTS_DIR) {
      return (await this._toolResultRows(parts[0])).map((r) => ({ name: r.sequence + '.txt', kind: 'file' }));
    }
    throw new Error('not a directory: ' + path);
  }

  async read(path) {
    const parts = this._parts(path);
    if (parts.length === 3 && parts[1] === TOOL_OUTPUTS_DIR) return this._toolOutput(parts[0], parts[2], path);
    if (parts.length !== 2 || parts[1] === TOOL_OUTPUTS_DIR) throw new Error('is a directory: ' + path);
    const conversationId = parts[0];
    const name = parts[1];
    const rows = name === 'events.jsonl'
      ? await this.service._byIndex('presentationEvents', 'conversationId', conversationId)
      : name === 'messages.jsonl'
        ? await this.service.loadNormalizedMessages(conversationId)
        : name === 'provider-frames.jsonl'
          ? await (async () => {
            const session = await this.service.loadProviderSession(conversationId);
            return session ? this.service.loadProviderFrames(session.id) : [];
          })()
          : null;
    if (!rows) throw new Error('no such file: ' + path);
    return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  }

  async readBytes(path) { return new TextEncoder().encode(await this.read(path)); }

  // Both native results (role 'tool_result') and text-fallback feedback
  // (role 'user', kind 'tool_result') carry the full output in toolResult.
  async _toolResultRows(conversationId) {
    const rows = await this.service.loadNormalizedMessages(conversationId);
    return rows.filter((r) => r && r.kind === 'tool_result' && Number.isInteger(r.sequence));
  }

  async _toolOutput(conversationId, name, path) {
    const sequence = toolOutputSequence(name);
    if (sequence == null) throw historyNotFound(path);
    let row = null;
    for (const r of await this._toolResultRows(conversationId)) if (r.sequence === sequence) row = r;
    if (!row) throw historyNotFound(path);
    return row.toolResult == null ? '' : String(row.toolResult);
  }

  async write(path) { throw new Error('read-only filesystem: ' + path); }
  async remove(path) { throw new Error('read-only filesystem: ' + path); }
  async mkdir(path) { throw new Error('read-only filesystem: ' + path); }
  async exists(path) {
    try { await this.stat(path); return true; } catch (e) { if (e && e.name === 'NotFoundError') return false; throw e; }
  }
  async stat(path) {
    const parts = this._parts(path);
    if (!parts.length) return { kind: 'directory', size: 0, modified: null };
    const conversations = await this.service.loadConversations();
    if (parts.length === 1 && conversations.some((c) => c.id === parts[0])) return { kind: 'directory', size: 0, modified: null };
    if (parts.length === 2 && HISTORY_FILES.includes(parts[1])) {
      return { kind: 'file', size: (await this.read(path)).length, modified: null };
    }
    if (parts.length === 2 && parts[1] === TOOL_OUTPUTS_DIR && conversations.some((c) => c.id === parts[0])) {
      return { kind: 'directory', size: 0, modified: null };
    }
    if (parts.length === 3 && parts[1] === TOOL_OUTPUTS_DIR) {
      const text = await this._toolOutput(parts[0], parts[2], path);
      return { kind: 'file', size: new TextEncoder().encode(text).byteLength, modified: null };
    }
    const e = new Error('no such file or directory: ' + path); e.name = 'NotFoundError'; throw e;
  }
}
