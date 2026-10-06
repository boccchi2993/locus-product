// Shared storage-scenario ENGINE for the two M3c storage-adapter browser
// gates (review round C). Exactly one copy of the five storage scenarios
// (P/O/C/R/S) exists — the source-ESM gate and the packaged-build gate
// both import THIS module into their host page, so their storage
// semantics cannot drift apart:
//   - tests/e2e-m3c-storage-adapters.cjs — SOURCE-ESM gate (its own HTTP
//     server serves /src and the installed locus-runtime / locus-harness
//     packages RAW through an import map; never touches the Vite build);
//   - tests/e2e-m3c-storage-built.cjs — PACKAGED-BUILD gate (drives
//     dist/tests/m3c-storage-host.html, a real Vite build input, through
//     vite preview only).
// Each host page resolves the Product modules itself (raw /src URLs vs
// bundled chunk graph) and hands in the namespaces plus the capability
// fixture tree as bytes. The Node-side 23-check table lives in
// tests/helpers/m3c-storage-checks.cjs. In-page doubles are
// storage/approval PORTS only.
export function installM3cStoragePage(modules, files) {
  const {
    harnessApi, runtimeApi, ConversationHistoryWorkspace,
    persistenceMod, attachmentsMod, extensionsMod, cpMod,
  } = modules;

  const subtleSha = async (bytes) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const service = new persistenceMod.PersistenceService();
  const boot = (async () => {
    await service.ready;
    return {
      persistenceMode: service.mode,
      health: service.persistenceHealth,
      opfsAvailable: service.opfsAvailable,
      // Provenance of the handed-in bindings: in BOTH gates the six
      // re-export/module namespaces must resolve to real namespace
      // objects and the workspace export to a class — this is what
      // check B0 asserts on the source page AND on the packaged bundle.
      modules: {
        runtimeApi: typeof runtimeApi,
        harnessApi: typeof harnessApi,
        persistence: typeof persistenceMod,
        attachments: typeof attachmentsMod,
        extensions: typeof extensionsMod,
        capabilityPackage: typeof cpMod,
        ConversationHistoryWorkspace: typeof ConversationHistoryWorkspace,
      },
    };
  })();

  async function runP() {
    await service.saveSettings({ apiBase: 'https://api.example.test/v1', model: 'm1' });
    const settings = await service.loadSettings();
    const config = { dialect: 'openai', apiBase: 'https://api.example.test/v1', model: 'm1' };
    await service.setRememberedApiKey('sk-browser', true, config);
    const remembered = await service.loadRememberedApiKey(config);
    const other = await service.loadRememberedApiKey({ ...config, apiBase: 'https://other.example.test/v1' });
    await service.saveConversation({ id: 'c-br', title: 't', updatedAt: '2026-10-04T00:00:00.000Z' });
    await service.saveProviderSession({ id: 'ps-br', conversationId: 'c-br', provider: 'openai', updatedAt: '2026-10-04T00:00:00.000Z' });
    await service.appendProviderFrame({ id: 'pf-1', sessionId: 'ps-br', conversationId: 'c-br', sequence: 1, role: 'user', kind: 'user', raw: { role: 'user', content: 'q' } });
    const framesBefore = await service.loadProviderFrames('ps-br');
    const deleted = await service.deleteConversation('c-br');
    const framesAfter = await service.loadProviderFrames('ps-br');
    const conversationsAfter = await service.loadConversations();
    return {
      settingsOk: settings.apiBase === 'https://api.example.test/v1' && settings.model === 'm1',
      rememberedOk: remembered === 'sk-browser' && other === null,
      framesBefore: framesBefore.length,
      deleted,
      framesAfter: framesAfter.length,
      conversationsAfter: conversationsAfter.length,
    };
  }

  async function runO() {
    await service.ensureHomeSkeleton();
    await service.opfsDirectory(['home', 'locus', '.skills']); // throws if absent
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    await service.writePlugin('pkg-x/plugin.json', payload);
    const readBack = await service.readPlugin('pkg-x/plugin.json');
    await service.clearPlugins();
    let pluginGone;
    try { await service.readPlugin('pkg-x/plugin.json'); pluginGone = false; } catch (e) { pluginGone = true; }

    const store = new attachmentsMod.AttachmentStore({ persistence: service });
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7, 7, 7]);
    const record = await store.ingestImage({ bytes: png, name: 'b.png', declaredType: 'image/png' });
    const hasBefore = await service.hasAttachmentBytes(record.storageKey);
    const wire = await store.resolveForWire(record.id);
    const wireBytes = Uint8Array.from(atob(wire.dataBase64), (c) => c.charCodeAt(0));
    const sameLen = new Uint8Array([1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
    await service.writeAttachmentBytes(record.storageKey, sameLen);
    let corruptReason = null;
    try { await store.getBytes(record.id); } catch (e) { corruptReason = attachmentsMod.isAttachmentIntegrityError(e) ? e.reason : String(e.message); }
    await service.clearAttachments();
    const hasAfter = await service.hasAttachmentBytes(record.storageKey);
    return {
      pluginRoundTrip: readBack instanceof Uint8Array && [...readBack].join() === [...payload].join(),
      pluginGone,
      attachmentDurable: hasBefore === true,
      wireOk: wire.mimeType === 'image/png' && [...wireBytes].join() === [...png].join(),
      corruptReason,
      cleared: hasAfter === false,
    };
  }

  async function runC() {
    const ws = new extensionsMod.StaticFileWorkspace({ name: 'fixture', files });
    const validation = await cpMod.validateProject({ workspace: ws, root: '' });
    const build = await cpMod.buildProject({ workspace: ws, root: '' });
    if (!build.ok) return { validateOk: validation.ok, buildOk: false, diagnostics: build.diagnostics };
    const skillBytes = build.bundle.readBytes('skills/test-workflow/SKILL.md');
    const lockSkill = build.bundle.lock.skills.find((s) => s.descriptor.id === 'test-workflow');
    const inspect = cpMod.inspectBundle(build.bundle);
    return {
      validateOk: validation.ok === true && validation.diagnostics.length === 0,
      buildOk: build.ok === true && build.bundle instanceof cpMod.CapabilityBundle,
      hashAgreesWithSubtle: lockSkill.sha256 === await subtleSha(skillBytes)
        && lockSkill.size === skillBytes.byteLength,
      inspectValid: inspect.valid === true && inspect.capability.id === 'package-test-capability',
    };
  }

  async function runR() {
    const adapter = harnessApi.getProviderAdapter({ dialect: 'openai', apiBase: 'https://api.example.test/v1' });
    const session = {
      id: 's-br', conversationId: 'c-br', replayCheckpointSequence: 2,
      provider: 'openai', adapterId: adapter.adapterId, dialect: 'openai',
      endpointIdentity: 'https://api.example.test/v1', model: 'm1', protocolVersion: 'chat-completions-v1',
    };
    const frames = [
      { sequence: 1, sessionId: 's-br', conversationId: 'c-br', kind: 'user', role: 'user', raw: { role: 'user', content: 'hi' } },
      { sequence: 2, sessionId: 's-br', conversationId: 'c-br', kind: 'assistant', role: 'assistant', raw: { role: 'assistant', content: 'done' } },
    ];
    const ok = persistenceMod.validateReplayPrefix(session, frames, adapter);
    let badCode = null;
    try {
      persistenceMod.validateReplayPrefix(session, [frames[0], { ...frames[1], sessionId: 's-x' }], adapter);
    } catch (e) { badCode = e.code; }
    return {
      identity: persistenceMod.validateReplayPrefix === harnessApi.validateReplayPrefix,
      validAccepted: !!ok && ok.valid === true && ok.checkpoint === 2,
      corruptedCode: badCode,
    };
  }

  async function runS() {
    const storage = {
      files: new Map([['cap1/note.skill', { bytes: new TextEncoder().encode('v1') }]]),
      async list() { return [{ name: 'cap1', kind: 'directory' }]; },
      async readBytes(rel) {
        const f = this.files.get(rel);
        if (!f) { const e = new Error('no such file: ' + rel); e.name = 'NotFoundError'; throw e; }
        return f.bytes.slice();
      },
      async read(rel) { return new TextDecoder().decode(await this.readBytes(rel)); },
      async writeBytes(rel, bytes) { this.files.set(rel, { bytes: new Uint8Array(bytes) }); },
      async exists(rel) { return this.files.has(rel); },
      async stat(rel) {
        const f = this.files.get(rel);
        if (!f) { const e = new Error('no such file: ' + rel); e.name = 'NotFoundError'; throw e; }
        return { kind: 'file', size: f.bytes.byteLength, modified: null };
      },
      async removeFile(rel) { this.files.delete(rel); },
    };
    const noApprovals = new extensionsMod.SkillInstanceWorkspace({
      storage,
      context: { taskEnvironment: { capabilities: [{ id: 'cap1', state: 'enabled', skillIds: ['note'] }], skills: [] }, approvals: null, getSignal: () => ({ aborted: false }) },
    });
    let noApprovalsCode = null;
    try { await noApprovals.write('cap1/note.skill', 'x'); } catch (e) { noApprovalsCode = e.code; }
    return {
      pathIdentity: harnessApi.skillInstancePath('cap1', 'note')
        === harnessApi.SKILL_INSTANCE_ROOT + '/cap1/note.skill',
      markerWriteCode: await (async () => {
        const ws = new extensionsMod.SkillInstanceWorkspace({
          storage,
          context: {
            taskEnvironment: { capabilities: [{ id: 'cap1', state: 'enabled', skillIds: ['note'] }], skills: [] },
            approvals: { request: async () => ({ outcome: 'confirm' }) },
            conversationId: 'c', taskGeneration: 1, getSignal: () => ({ aborted: false }),
          },
        });
        try { await ws.write('cap1/' + harnessApi.SKILL_INSTANCE_MARKER, 'x'); return null; }
        catch (e) { return e.code; }
      })(),
      noApprovalsCode,
      bound: harnessApi.SKILL_INSTANCE_MAX_BYTES,
    };
  }

  window.__m3c = {
    ready: false,
    boot: null,
    error: null,
    errors: [],
    resources: () => performance.getEntriesByType('resource').map((r) => r.name),
    async runAll() {
      await boot;
      const out = {};
      for (const [key, fn] of [['p', runP], ['o', runO], ['c', runC], ['r', runR], ['s', runS]]) {
        try { out[key] = await fn(); }
        catch (e) { out[key] = { error: String(e && e.message || e) }; }
      }
      return out;
    },
  };
  window.addEventListener('error', (e) => window.__m3c.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => window.__m3c.errors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)));
  boot.then(() => { window.__m3c.bootData = boot; window.__m3c.ready = true; })
    .catch((e) => { window.__m3c.error = String(e && e.message || e); window.__m3c.ready = true; });
}
