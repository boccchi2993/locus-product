// Shared .locus fixture builder for the wheel-only plugin e2e suites
// (D10 §6: plugins enter Python only as verified wheel artifacts inside a
// capability package). Node side builds the package bytes with the REAL
// locus-archive packLocus over a REAL runtime memory workspace — the
// exact layout CAPABILITY-PACKAGE §4 defines — and hands them to the page
// through window.__locus.capabilityComposition.installPackage(bytes).
//
// Deterministic for identical inputs (packLocus computes every size and
// SHA-256 itself; nothing is hand-written), so re-running a suite always
// produces the same digests.
import * as LA from '../../src/locus-archive.js';
import { createMemoryWorkspace } from '../../src/product/runtime-api.js';

// skill: { id, version = '1', displayName, description, body }
// plugin: null | {
//   id, version = '1.0.0', displayName, description,
//   wheel: Uint8Array|Buffer, wheelFilename,
//   pythonImports = [],
// }
export async function buildFixturePackage({
  id,
  version = '1.0.0',
  displayName,
  description,
  plugin = null,
  skills = [],
  author = 'e2e-suite',
  purpose = 'TEST ONLY fixture capability package',
} = {}) {
  if (!id) throw new Error('buildFixturePackage: id is required');
  const capDisplayName = displayName || id;
  const capDescription = description || 'TEST ONLY fixture capability.';

  const ws = createMemoryWorkspace({
    maxBytes: LA.LOCUS_LIMITS.maxTotalBytes,
    maxFileBytes: LA.LOCUS_LIMITS.maxFileBytes,
  });

  const pluginIds = plugin ? [plugin.id] : [];
  const skillIds = skills.map((s) => s.id);
  const capabilities = {
    schemaVersion: 1,
    capability: {
      id, version,
      displayName: capDisplayName,
      description: capDescription,
      plugins: pluginIds,
      skills: skillIds,
      mcps: [],
    },
  };
  await ws.write('capability.json', JSON.stringify(capabilities, null, 2) + '\n');

  if (plugin) {
    if (!plugin.wheel || !(plugin.wheel instanceof Uint8Array) || !plugin.wheelFilename) {
      throw new Error('buildFixturePackage: plugin needs real wheel bytes + wheelFilename');
    }
    await ws.write('plugins/' + plugin.id + '/plugin.json', JSON.stringify({
      schemaVersion: 1,
      plugin: {
        id: plugin.id, version: plugin.version || '1.0.0',
        displayName: plugin.displayName || plugin.id,
        description: plugin.description || 'TEST ONLY wheel fixture.',
        runtime: 'python', authority: 'none',
        provides: { pythonImports: (plugin.pythonImports || []).slice() },
      },
      artifacts: [{ path: 'artifacts/' + plugin.wheelFilename, format: 'python-wheel' }],
    }, null, 2) + '\n');
    await ws.write('plugins/' + plugin.id + '/artifacts/' + plugin.wheelFilename, plugin.wheel);
  }

  for (const s of skills) {
    if (typeof s.body !== 'string' || !s.body) {
      throw new Error('buildFixturePackage: skill ' + s.id + ' needs a body string');
    }
    await ws.write('skills/' + s.id + '/skill.json', JSON.stringify({
      schemaVersion: 1,
      skill: {
        id: s.id, version: s.version || '1',
        displayName: s.displayName || s.id,
        description: s.description || 'TEST ONLY.',
      },
      source: 'SKILL.md',
    }, null, 2) + '\n');
    await ws.write('skills/' + s.id + '/SKILL.md', s.body);
  }

  const body = '# ' + id + '\n\n' + purpose + '\n\n'
    + '## 更改记录\n\n- ' + version + '（2026-10-17）：首个版本\n';
  const packed = await LA.packLocus({
    workspace: ws, root: '', author, purpose, body,
  });
  if (!packed.ok) throw new Error('buildFixturePackage: pack failed: ' + JSON.stringify(packed.diagnostics));
  return packed.bytes;
}
