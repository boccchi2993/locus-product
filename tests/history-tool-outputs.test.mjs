// HT suite: virtual tool-output files under the read-only /home/locus/history
// view (src/conversation-history-workspace.js).
//
// What this suite proves:
//  - every tool-result row of a conversation is visible as
//    <conversationId>/tool-outputs/<sequence>.txt serving the FULL output,
//    straight from its normalized row — both native results (role
//    'tool_result') and text-fallback feedback (role 'user', kind
//    'tool_result'); no copy is stored (HT1-HT5);
//  - names that are not a tool-result row, or not a plain decimal file
//    name, fail with NotFoundError, and exists() agrees (HT6);
//  - the tool-outputs directory itself stats as a directory and refuses
//    read (HT7); write/remove/mkdir keep refusing everywhere (HT8);
//  - deleting the conversation kills the virtual files with it (HT9);
//  - historyToolOutputPath is the single path former, null on ids that
//    cannot form a safe single path segment (HT10);
//  - the pre-existing messages.jsonl view is byte-for-byte unchanged in
//    shape: one JSON row per line, all five rows (HT11);
//  - the REAL runtime shell sees the view through the production
//    'system-read-only' mount: ls/head/grep/cp/wc work over it and a `>`
//    write into it fails (HT12). grep runs on the runtime's own TEST-ONLY
//    _workerFactory seam with a deterministic fake mirroring the
//    GREP_WORKER_SOURCE protocol (node has no Blob Worker); every other
//    command runs on the real shell.
//
// The service is the REAL PersistenceService in memory mode, constructed
// exactly like the P block of tests/m3c-storage-adapters.test.mjs.
// Run: node tests/history-tool-outputs.test.mjs

import * as runtimeApi from '../src/product/runtime-api.js';
import * as historyWs from '../src/conversation-history-workspace.js';
import { ConversationHistoryWorkspace, historyToolOutputPath } from '../src/conversation-history-workspace.js';
import { PersistenceService } from '../src/persistence.js';
import { executeTool } from '../src/tools.js';

// Deep file-URL import: src/shell.js is package-internal (not in the
// package exports map), and only its exported TEST-ONLY _workerFactory
// seam lets grep run in a node process. run-unit isolates suites per
// process, so the seam restore below also guards in-suite ordering.
const shellMod = await import(new URL('../node_modules/locus-runtime/src/shell.js', import.meta.url).href);
const { GrepRegexRuntime } = shellMod;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const rejectionOf = (p) => p.then(() => null, (e) => e);

// Deterministic stand-in for the grep regex worker (mirrors the real
// GREP_WORKER_SOURCE message protocol: init → ready | invalid_pattern,
// scan → { count } | { matches, hitMatchLimit }).
function fakeGrepWorker() {
  let re = null;
  const splitLines = (text) => {
    const lines = String(text).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const w = {
    onmessage: null, onerror: null, onmessageerror: null,
    terminate() {},
    postMessage(msg) {
      queueMicrotask(() => {
        try {
          if (msg.cmd === 'init') {
            try {
              re = new RegExp(String(msg.pattern), msg.flags ? String(msg.flags) : '');
              w.onmessage({ data: { id: msg.id, type: 'ready' } });
            } catch (e) {
              re = null;
              w.onmessage({ data: { id: msg.id, type: 'invalid_pattern' } });
            }
            return;
          }
          if (msg.cmd === 'scan') {
            if (!re) { w.onmessage({ data: { id: msg.id, type: 'internal_error' } }); return; }
            const lines = splitLines(msg.text);
            if (msg.countOnly) {
              let count = 0;
              for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) count++;
              w.onmessage({ data: { id: msg.id, type: 'result', count } });
              return;
            }
            const budget = typeof msg.maxMatches === 'number' ? msg.maxMatches : Infinity;
            const matches = [];
            let hitMatchLimit = false;
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= budget) { hitMatchLimit = true; break; }
              if (re.test(lines[i])) matches.push({ lineNumber: i + 1, line: lines[i] });
            }
            w.onmessage({ data: { id: msg.id, type: 'result', matches, hitMatchLimit } });
            return;
          }
          w.onmessage({ data: { id: msg.id, type: 'internal_error' } });
        } catch (e) { if (w.onerror) w.onerror(e); }
      });
    },
  };
  return w;
}

async function run() {
  // The real PersistenceService (memory mode in Node), one conversation
  // with the five normalized rows: a user message, an assistant tool call,
  // a native tool result, an assistant message and a text-fallback
  // tool-result feedback.
  const service = new PersistenceService();
  await service.ready;
  await service.saveConversation({ id: 'c-1', title: 't', updatedAt: '2026-10-17T00:00:00.000Z' });
  await service.saveNormalizedMessage({ conversationId: 'c-1', sequence: 1, role: 'user', kind: 'message', text: 'q' });
  await service.saveNormalizedMessage({ conversationId: 'c-1', sequence: 2, role: 'assistant', kind: 'tool_call', text: '', toolCalls: [{ id: 't1', name: 'bash', input: { input: 'ls' } }] });
  await service.saveNormalizedMessage({ conversationId: 'c-1', sequence: 3, role: 'tool_result', kind: 'tool_result', toolCallId: 't1', toolName: 'bash', toolResult: 'L'.repeat(20000) + '汉字', success: true });
  await service.saveNormalizedMessage({ conversationId: 'c-1', sequence: 4, role: 'assistant', kind: 'message', text: 'x' });
  await service.saveNormalizedMessage({ conversationId: 'c-1', sequence: 5, role: 'user', kind: 'tool_result', text: '<tool_result>…</tool_result>', toolName: 'bash', toolResult: 'fallback output', success: true });

  const hws = new ConversationHistoryWorkspace(service);
  const full = 'L'.repeat(20000) + '汉字';

  // ================= HT1. the conversation directory gains tool-outputs =================
  {
    const entries = await hws.list('c-1');
    const toolOutputs = entries.find((e) => e.name === 'tool-outputs');
    check('HT1 list(c-1) keeps the three jsonl files and adds the tool-outputs directory',
      ['events.jsonl', 'messages.jsonl', 'provider-frames.jsonl'].every((n) => entries.some((e) => e.name === n && e.kind === 'file'))
      && !!toolOutputs && toolOutputs.kind === 'directory',
      JSON.stringify(entries));
  }

  // ================= HT2. the tool-outputs directory lists exactly the tool-result rows =================
  {
    const entries = await hws.list('c-1/tool-outputs');
    const names = entries.map((e) => e.name).sort();
    check('HT2 list(c-1/tool-outputs) is exactly the two tool-result sequences, as files',
      JSON.stringify(names) === JSON.stringify(['3.txt', '5.txt'])
        && entries.every((e) => e.kind === 'file'),
      JSON.stringify(entries));
  }

  // ================= HT3. the native result serves its FULL output =================
  {
    const text = await hws.read('c-1/tool-outputs/3.txt');
    check('HT3 read(c-1/tool-outputs/3.txt) is the complete 20003-char tool result',
      text === full, 'len=' + (text || '').length);
  }

  // ================= HT4. stat reports UTF-8 bytes =================
  {
    const st = await hws.stat('c-1/tool-outputs/3.txt');
    check('HT4 stat(3.txt) is a file of 20006 UTF-8 bytes (20000 + 2 × 3-byte chars)',
      st.kind === 'file' && st.size === 20006 && st.modified === null,
      JSON.stringify(st));
  }

  // ================= HT5. the text-fallback feedback serves its output too =================
  {
    const text = await hws.read('c-1/tool-outputs/5.txt');
    check('HT5 read(5.txt) serves the text-fallback tool result',
      text === 'fallback output', JSON.stringify(String(text).slice(0, 40)));
  }

  // ================= HT6. not-a-tool-result and malformed names fail closed =================
  {
    const paths = [
      'c-1/tool-outputs/4.txt', // a row, but not a tool result
      'c-1/tool-outputs/99.txt', // no such sequence
      'c-1/tool-outputs/03.txt', // leading zero: not a plain decimal name
      'c-1/tool-outputs/3', // missing .txt
      'c-1/tool-outputs/abc.txt', // not a sequence
    ];
    const errs = [];
    for (const p of paths) errs.push(await rejectionOf(hws.read(p)));
    const gone = await hws.exists('c-1/tool-outputs/99.txt');
    check('HT6 non-tool-result, missing and malformed names are NotFoundError (and exists agrees)',
      errs.every((e) => e && e.name === 'NotFoundError') && gone === false,
      JSON.stringify(errs.map((e) => e && (e.name + ': ' + e.message))));
  }

  // ================= HT7. the tool-outputs directory itself =================
  {
    const st = await hws.stat('c-1/tool-outputs');
    const readErr = await rejectionOf(hws.read('c-1/tool-outputs'));
    check('HT7 stat(tool-outputs) is a directory; read(tool-outputs) refuses with "is a directory"',
      st.kind === 'directory' && !!readErr && /is a directory/.test(readErr.message),
      JSON.stringify({ st, err: readErr && readErr.message }));
  }

  // ================= HT8. the read-only refusal set covers the new paths =================
  {
    const p = 'c-1/tool-outputs/3.txt';
    const wErr = await rejectionOf(hws.write(p, 'x'));
    const rErr = await rejectionOf(hws.remove(p));
    const mErr = await rejectionOf(hws.mkdir(p));
    check('HT8 write/remove/mkdir on a virtual tool output refuse read-only filesystem',
      [wErr, rErr, mErr].every((e) => e && e.message.startsWith('read-only filesystem')),
      JSON.stringify([wErr, rErr, mErr].map((e) => e && e.message)));
  }

  // ================= HT11. the pre-existing messages.jsonl view is unchanged =================
  {
    const raw = await hws.read('c-1/messages.jsonl');
    let rows = null;
    if (raw.endsWith('\n')) {
      const lines = raw.slice(0, -1).split('\n');
      try { rows = lines.map((l) => JSON.parse(l)); } catch (e) { rows = null; }
      if (rows && (rows.length !== 5 || lines.length !== 5)) rows = null;
    }
    check('HT11 messages.jsonl still serves exactly the five normalized rows, one JSON per line',
      !!rows && JSON.stringify(rows.map((r) => r.sequence)) === JSON.stringify([1, 2, 3, 4, 5])
        && rows[2].toolResult === full && rows[4].toolResult === 'fallback output',
      'rows=' + (rows && rows.length));
  }

  // ================= HT10. the one path former =================
  {
    const bad = [historyToolOutputPath('a/b', 3), historyToolOutputPath('..', 3), historyToolOutputPath('c-1', 0), historyToolOutputPath('c-1', 1.5), historyToolOutputPath(null, 3)];
    check('HT10 historyToolOutputPath forms the mounted path and refuses unsafe segments',
      historyToolOutputPath('c-1', 3) === '/home/locus/history/c-1/tool-outputs/3.txt'
        && bad.every((v) => v === null),
      JSON.stringify(bad));
  }

  // ================= HT12. the real runtime shell over the production mount =================
  {
    const prevFactory = GrepRegexRuntime._workerFactory;
    GrepRegexRuntime._workerFactory = fakeGrepWorker;
    try {
      const host = await runtimeApi.createRuntime({
        workerAssets: {
          pyWorkerSource: runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE,
          grepWorkerSource: runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE,
        },
      });
      const session = host.createSession();
      const vfs = runtimeApi.createWorkspace();
      vfs.mount('/home/locus/history', new ConversationHistoryWorkspace(service), 'system-read-only');
      const sh = (cmd) => executeTool('bash', cmd, vfs, { runtimeSession: session, telemetry: { records: [], record(r) { this.records.push(r); return r; } } });

      const ls = await sh('ls /home/locus/history/c-1/tool-outputs');
      check('HT12a ls lists the virtual tool outputs through the real shell',
        ls.success === true && ls.output.includes('3.txt') && ls.output.includes('5.txt'),
        JSON.stringify({ success: ls.success, output: String(ls.output).slice(0, 80) }));

      const head = await sh('head -c 5 /home/locus/history/c-1/tool-outputs/3.txt');
      check('HT12b head -c serves the first bytes of the full output',
        head.success === true && head.output.replace(/\n$/, '') === 'LLLLL',
        JSON.stringify({ success: head.success, output: String(head.output).slice(0, 40) }));

      const grep = await sh('grep -c 汉字 /home/locus/history/c-1/tool-outputs/3.txt');
      check('HT12c grep -c counts the matching line (deterministic fake worker, real grep algorithm)',
        grep.success === true && grep.output.trim() === '1',
        JSON.stringify({ success: grep.success, output: String(grep.output).slice(0, 60) }));

      await sh('cp /home/locus/history/c-1/tool-outputs/3.txt /tmp/ht-out.txt');
      const wc = await sh('wc -c /tmp/ht-out.txt');
      check('HT12d cp copies the full file out and wc -c counts 20006 bytes',
        /\b20006\b/.test(String(wc.output)),
        JSON.stringify({ success: wc.success, output: String(wc.output).slice(0, 60) }));

      const writeBack = await sh('echo x > /home/locus/history/c-1/tool-outputs/3.txt');
      check('HT12e a shell write into the read-only mount fails',
        writeBack.success === false,
        JSON.stringify({ success: writeBack.success, output: String(writeBack.output).slice(0, 80) }));
    } finally {
      GrepRegexRuntime._workerFactory = prevFactory;
    }
  }

  // ================= HT9. deleting the conversation kills the virtual files =================
  {
    await service.deleteConversation('c-1');
    const err = await rejectionOf(hws.read('c-1/tool-outputs/3.txt'));
    const convs = await hws.list('');
    check('HT9 after deleteConversation the virtual tool output is NotFoundError (and unlisted)',
      err && err.name === 'NotFoundError' && !convs.some((c) => c.id === 'c-1'),
      JSON.stringify({ err: err && (err.name + ': ' + err.message), convs: convs.map((c) => c.id) }));
  }
}

await run();
console.log('---');
if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('all ' + passed + ' checks passed');
