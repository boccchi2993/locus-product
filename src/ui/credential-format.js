// The send rule, stated the same way in the settings rows and the
// Connect dialogs. Scheme null means the header value IS the key — no
// "Bearer …" shown. Shared by SettingsPanel and the global
// CapabilityImportDialog (the D12 connect step renders the same line).
export function credentialSendLine(decl) {
  if (!decl) return '';
  return 'Only sent to ' + decl.origin + decl.pathPrefix + ' as ' + decl.header
    + (decl.scheme ? ': ' + decl.scheme + ' …' : '');
}
