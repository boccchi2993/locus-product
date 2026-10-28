// Composer "+" menu (Capabilities cascade) + global import dialog:
// source-level structure gate. These are LITERAL source scans of the
// packaged-from-source files — no DOM, no build — pinning the structural
// facts the browser gate then exercises over the real app:
//   CM1  the plus menu no longer offers "Open terminal"
//   CM2  the terminal seam itself is untouched (store action + panel)
//   CM3  the Capabilities entry is a cascade parent (aria-haspopup/expanded)
//   CM4  ARIA menu roles on every level + separators
//   CM5  stepped (narrow/touch) mode has its "‹ Back" entry
//   CM6  the third level carries the import entries and never window.prompt
//   CM7  the composer never manages capability enabled-state
//   CM8  the import dialog moved to a GLOBAL component mounted at the root
//   CM9  the untrusted-content safety comment moved with the dialog
//   CM10 the store surface the menu needs (listing, deep link, scroll target)
//   CM11 the level-2/level-3 lists scroll independently of their heads
//   CM12 keyboard navigation + the <640px stepped boundary
//   CM13 the browser gate for the menu is registered in the orchestrator
// Run: node tests/composer-menu-structure.test.cjs
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const composer = read('src/components/Composer.vue');
const settings = read('src/components/SettingsPanel.vue');
const app = read('src/App.vue');
const storeJs = read('src/ui/store.js');
const theme = read('src/ui/theme.css');
const dialogPath = path.join(__dirname, '..', 'src', 'components', 'CapabilityImportDialog.vue');
const dialog = fs.existsSync(dialogPath) ? fs.readFileSync(dialogPath, 'utf8') : '';

// ---------- CM1/CM2: Open terminal out of the menu, seam untouched ----------
check('CM1 plus menu no longer offers Open terminal', !/Open terminal/.test(composer),
  'Composer.vue still mentions Open terminal');
check('CM2a store still exports openTerminal (entry point moved, seam kept)',
  /export function openTerminal\(\)/.test(storeJs));
check('CM2b TerminalPanel still mounted', /<TerminalPanel /.test(app));

// ---------- CM3/CM4: cascade parent + ARIA ----------
check('CM3 Capabilities entry is a cascade parent with aria-haspopup and aria-expanded',
  /data-testid="plus-capabilities"/.test(composer)
  && /aria-haspopup="true"/.test(composer)
  && /:aria-expanded=/.test(composer));
const menuRoles = (composer.match(/role="menu"/g) || []).length;
check('CM4a role="menu" on all three levels', menuRoles >= 3, menuRoles + ' occurrences');
check('CM4b role="menuitem" items exist', /role="menuitem"/.test(composer));
check('CM4c separators exist between the fixed head and the lists', /role="separator"/.test(composer));

// ---------- CM5: stepped mode ----------
check('CM5 stepped mode renders a Back entry', /data-testid="plus-menu-back"/.test(composer));

// ---------- CM6: import entries ----------
check('CM6a third level offers From file… and From path…',
  /data-testid="composer-import-from-file"/.test(composer)
  && /data-testid="composer-import-from-path"/.test(composer));
check('CM6b From path… expands an inline input (placeholder /mnt/download/example.locus)',
  /data-testid="composer-import-path-input"/.test(composer)
  && /\/mnt\/download\/example\.locus/.test(composer));
check('CM6c no window.prompt call anywhere in the composer', !/window\.prompt\s*\(/.test(composer));
check('CM6d imports go through the store begin* entry points',
  /beginCapabilityImportFromBytes/.test(composer) && /beginCapabilityImportFromPath/.test(composer));

// ---------- CM7: mention rows never manage enabled-state ----------
check('CM7 composer never enables/disables capabilities',
  !/enableCapability|disableCapability/.test(composer));

// ---------- CM8/CM9: the global dialog ----------
check('CM8a CapabilityImportDialog.vue exists and carries the dialog testid',
  !!dialog && /data-testid="capability-import-dialog"/.test(dialog));
check('CM8b the dialog keeps confirm/cancel/D12-connect testids',
  !!dialog && /capability-import-confirm/.test(dialog)
  && /capability-import-cancel/.test(dialog)
  && /import-credential-row-/.test(dialog)
  && /capability-import-connect/.test(dialog));
check('CM8c SettingsPanel no longer renders the import dialog (the credential Connect dialog keeps the shared CSS class)',
  !/data-testid="capability-import-dialog"/.test(settings));
check('CM8d App.vue mounts the global dialog at the root', /<CapabilityImportDialog \/>/.test(app));
check('CM9 the untrusted-content safety comment moved with the dialog',
  !!dialog && /never v-html/.test(dialog) && /text\s+interpolation/i.test(dialog));

// ---------- CM10: store surface ----------
check('CM10a store lists /mnt/download .locus files',
  /export async function listDownloadLocusFiles\(\)/.test(storeJs));
check('CM10b store deep-links to a capability card in Settings',
  /export function openCapabilitySettings\(/.test(storeJs));
check('CM10c store carries the one-shot settings scroll target',
  /settingsScrollTarget: null/.test(storeJs));

// ---------- CM11: independent scroll areas ----------
check('CM11a capability list scrolls independently (max-height)',
  /\.plus-sub \[data-testid="composer-capability-list"\] \{ max-height: 320px; \}/.test(theme));
check('CM11b .locus file list scrolls independently', /\.plus-files \{ max-height: 220px; \}/.test(theme));

// ---------- CM12: keyboard + stepped boundary ----------
check('CM12a arrow/enter/escape navigation handled',
  /ArrowRight/.test(composer) && /ArrowLeft/.test(composer)
  && /ArrowDown/.test(composer) && /ArrowUp/.test(composer)
  && /'Escape'/.test(composer));
check('CM12b stepped boundary is <640px width or touch/hover-none',
  /\(max-width: 639px\)/.test(composer) && /\(hover: none\)/.test(composer));

// ---------- CM13: browser-gate registration ----------
const suites = read('tests/helpers/browser-gate-suites.cjs');
check('CM13 e2e-composer-menu.cjs registered in the browser-gate orchestrator',
  /e2e-composer-menu\.cjs/.test(suites));

console.log('---');
console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
process.exit(failed ? 1 : 0);
