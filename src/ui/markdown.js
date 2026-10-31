// ============================================================
//  MARKDOWN-LITE (presentation only)
//
//  Minimal, XSS-safe renderer for assistant/user-visible text:
//  HTML is escaped FIRST, then a small inline/block grammar is applied
//  on the ESCAPED text — model output can never inject markup (every
//  `<`/`>`/`"`/`&` it emits is an entity before any syntax runs, and
//  the only tags in the output are the ones this file writes).
//
//  Block grammar: fenced code blocks (``` / ~~~, optional info string,
//  unclosed fences run to the end of the message), unordered and
//  ordered lists, GFM tables (header + :--- delimiter row), ATX
//  headers, paragraphs. Inline grammar: code spans, bold, emphasis,
//  links and bare URLs.
//
//  Links are protocol-allowlisted: ONLY http:/https: render as <a>
//  (target=_blank, rel=noopener noreferrer, external-link glyph,
//  full URL as title). `sandbox:/abs/path` links render as a file-slot
//  placeholder ({type:'file'} segment) that the Timeline turns into a
//  file card. Every other scheme (javascript:, data:, file:, …) and
//  every relative target stays literal text.
//
//  Segments API: renderSegments(text) → [{type:'html', html} |
//  {type:'code', lang, code} | {type:'file', path}] — the Timeline
//  renders code blocks and file cards as live components (copy button,
//  VFS stat, download) and the html segments through v-html.
//  render(text) is the plain-string view of the same parse (code
//  blocks become <pre>, file slots become inert placeholders); it is
//  what nothing interactive needs and the unit suites pin.
// ============================================================

export const LocusMarkdown = (function () {
  'use strict';

  var PLACE = '\u0000'; // placeholder fence — stripped from input first

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // sandbox: target → absolute, normalized VFS path or null.
  // Relative paths and any `..` segment are refused outright (never
  // resolved — a renderer must never guess what a model meant).
  // %XX escapes are decoded first (markdown link destinations are
  // percent-encoded by convention; decoding BEFORE validation means
  // %2E%2E is caught as `..` too).
  function normalizeVfsPath(raw) {
    var p = String(raw || '').trim();
    if (!p || p.charAt(0) !== '/') return null;
    try { p = decodeURIComponent(p); } catch (e) { /* malformed % → use raw */ }
    if (p.charAt(0) !== '/' || /[\r\n\u0000]/.test(p)) return null;
    var segs = p.split('/');
    var out = [];
    for (var i = 1; i < segs.length; i++) {
      var s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') return null;
      out.push(s);
    }
    if (!out.length) return null; // "/" alone is not a file
    return '/' + out.join('/');
  }

  // ---------- inline grammar (runs on ESCAPED text) ----------

  // One placeholder namespace for the whole inline pass: `code spans`,
  // anchors and file slots all park their finished HTML here (index-keyed
  // PLACE fences) so later rules — emphasis, bold — can never rewrite
  // content that is already final. Restored once, at the very end.
  function makeInlineCtx() {
    var slots = [];
    return {
      keep: function (html) { slots.push(html); return PLACE + (slots.length - 1) + PLACE; },
      restore: function (s) {
        return s.replace(new RegExp(PLACE + '(\\d+)' + PLACE, 'g'), function (m, i) {
          return slots[Number(i)];
        });
      },
    };
  }

  // `code spans` go first so no other rule can touch their content.
  function extractCode(ctx, esc) {
    return esc.replace(/`([^`\n]+)`/g, function (m, body) {
      return ctx.keep('<code>' + body + '</code>');
    });
  }

  // [text](target) — protocol-allowlisted. `target` and `textHtml` arrive
  // in the ESCAPED domain (the inline pass runs on escaped text), so they
  // are attribute-safe as-is; re-escaping would double-encode. The file
  // slot decodes the escaping FIRST (a VFS path may contain & < > "),
  // normalizes the real path, then re-escapes exactly once for the
  // attribute — and carries the path-derived basename as its text: that
  // is what the plain-string render shows, and what the segment splitter
  // lifts out into a live {type:'file'} segment for the Timeline's card.
  function renderLink(textHtml, target) {
    var t = String(target || '').trim();
    if (/^sandbox:/i.test(t)) {
      var p = normalizeVfsPath(decodeAttr(t.replace(/^sandbox:/i, '')));
      if (p) {
        return '<span class="locus-file-slot" data-locus-path="' + escapeHtml(p) + '">'
          + escapeHtml(p.split('/').pop()) + '</span>';
      }
      return null; // bad path → literal
    }
    if (/^https?:\/\//i.test(t)) {
      return '<a href="' + t + '" target="_blank" rel="noopener noreferrer" title="' + t + '">'
        + textHtml
        + '<svg class="ext-link-icon" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 3h7v7"/><path d="M13 3 7.5 8.5"/><path d="M11 9v4H3V5h4"/></svg></a>';
    }
    return null; // javascript:/data:/file:/relative/… → literal text
  }

  function inline(escaped) {
    var ctx = makeInlineCtx();
    var s = extractCode(ctx, escaped);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, text, target) {
      var link = renderLink(text, target);
      return link === null ? m : ctx.keep(link);
    });
    // Bare URLs: scheme must not continue a word (foohttps:// x), trailing
    // sentence punctuation stays outside the anchor.
    s = s.replace(/(^|[^\w'&=;/])(https?:\/\/[^\s\u0000]+?)([.,;:!?)\]]*)(?=[\s\u0000]|$)/g, function (m, pre, url, trail) {
      var link = renderLink(url, url);
      if (link === null) return m;
      return pre + ctx.keep(link) + trail;
    });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return ctx.restore(s);
  }

  // ---------- block parse ----------

  // Fence opener: ```lang / ~~~ lang. Returns { mark, len, info } or null.
  function fenceOpen(trimmed) {
    var m = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!m) return null;
    return { mark: m[1].charAt(0), len: m[1].length, info: m[2].trim() };
  }
  function fenceClose(trimmed, open) {
    var m = trimmed.match(/^(`{3,}|~{3,})\s*$/);
    return !!m && m[1].charAt(0) === open.mark && m[1].length >= open.len;
  }

  // GFM delimiter row: | :--- | :---: | ---: | … (≥3 dashes per cell).
  // Returns the alignment array, or null when the line is not one.
  function tableDelimiter(trimmed) {
    if (!/\|/.test(trimmed)) return null;
    var cells = splitRow(trimmed);
    if (cells.length < 1) return null;
    var aligns = [];
    for (var i = 0; i < cells.length; i++) {
      var m = cells[i].match(/^(:?)-{3,}(:?)$/);
      if (!m) return null;
      aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : 'left');
    }
    return aligns;
  }
  // Split one table row into cell texts (escapes `\|` to a literal pipe,
  // matching the GFM rule that only `\|` carries a pipe into a cell).
  function splitRow(line) {
    var cells = [];
    var cur = '';
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '\\' && line.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    // A leading/trailing pipe yields empty edge cells — drop exactly those.
    if (cells.length && cells[0] === '' && /^\s*\|/.test(line)) cells.shift();
    if (cells.length && cells[cells.length - 1] === '' && /\|\s*$/.test(line)) cells.pop();
    return cells;
  }

  // The slot span the inline grammar emits. Splitting sources: attribute
  // values are escapeHtml output (no raw quotes), so the match is exact.
  var SLOT_SPAN_RE = /<span class="locus-file-slot" data-locus-path="([^"]*)">[^<]*<\/span>/;
  function decodeAttr(s) {
    return String(s).replace(/&(amp|lt|gt|quot);/g, function (c) {
      return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }[c];
    });
  }

  // Parse the whole message into block segments. Code blocks and file
  // slots come out as structured segments; everything else accumulates
  // into html segments (each fully escaped by the inline/block rules).
  // A paragraph that carries a file slot splits AROUND it: each text
  // piece keeps its own <p>, the slot becomes a {type:'file'} segment —
  // so the Timeline can mount a card exactly where the link stood.
  // keepSlotsInline (plain-string render) skips that split: slots stay
  // as the inert inline spans the fallback shows.
  function parseBlocks(text, keepSlotsInline) {
    var clean = String(text || '').replace(/\u0000/g, '');
    var lines = clean.split(/\r?\n/);
    var segs = [];
    var html = [];
    var list = null;     // { type: 'ul'|'ol', items: [] }
    var para = null;

    function flushPara() {
      if (para && para.length) {
        var joined = para.join('<br>');
        if (!keepSlotsInline && SLOT_SPAN_RE.test(joined)) {
          joined.split(/(<span class="locus-file-slot" data-locus-path="[^"]*">[^<]*<\/span>)/)
            .forEach(function (part) {
              if (!part) return;
              var m = part.match(SLOT_SPAN_RE);
              if (m) {
                flushHtml();
                var p = decodeAttr(m[1]);
                segs.push({ type: 'file', path: p, name: p.split('/').pop() });
              } else {
                html.push('<p>' + part + '</p>');
              }
            });
        } else {
          html.push('<p>' + joined + '</p>');
        }
      }
      para = null;
    }
    function flushList() {
      if (list) {
        html.push('<' + list.type + '>' + list.items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</' + list.type + '>');
      }
      list = null;
    }
    function flushHtml() { if (html.length) { segs.push({ type: 'html', html: html.join('') }); html = []; } }
    function inlineOf(raw) { return inline(escapeHtml(raw)); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) { flushPara(); flushList(); continue; }

      // fenced code block (unclosed → runs to the end of the message)
      var open = fenceOpen(trimmed);
      if (open) {
        flushPara(); flushList();
        var body = [];
        i++;
        while (i < lines.length && !fenceClose(lines[i].trim(), open)) { body.push(lines[i]); i++; }
        flushHtml();
        segs.push({ type: 'code', lang: (open.info.split(/\s+/)[0] || '').toLowerCase(), code: body.join('\n') });
        continue;
      }

      // table: header row here, delimiter row next
      if (i + 1 < lines.length && /\|/.test(trimmed)) {
        var aligns = tableDelimiter(lines[i + 1].trim());
        if (aligns) {
          flushPara(); flushList();
          var head = splitRow(trimmed);
          var cols = aligns.length;
          while (head.length < cols) head.push('');
          var rows = [];
          var j = i + 2;
          while (j < lines.length && lines[j].trim() && /\|/.test(lines[j])) {
            var cells = splitRow(lines[j].trim());
            while (cells.length < cols) cells.push('');
            rows.push(cells.slice(0, cols));
            j++;
          }
          i = j - 1;
          var t = '<table><thead><tr>' + head.slice(0, cols).map(function (h, ci) {
            return '<th' + (aligns[ci] !== 'left' ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inlineOf(h) + '</th>';
          }).join('') + '</tr></thead><tbody>'
            + (rows.length ? rows.map(function (r) {
              return '<tr>' + r.map(function (c, ci) {
                return '<td' + (aligns[ci] !== 'left' ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inlineOf(c) + '</td>';
              }).join('') + '</tr>';
            }).join('') : '')
            + '</tbody></table>';
          html.push(t);
          continue;
        }
      }

      var head = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (head) {
        flushPara(); flushList();
        var level = Math.min(head[1].length + 2, 6); // ## → h4 …, keeps headers small
        html.push('<h' + level + '>' + inline(escapeHtml(head[2])) + '</h' + level + '>');
        continue;
      }

      var li = trimmed.match(/^[-*]\s+(.*)$/);
      if (li) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(inlineOf(li[1]));
        continue;
      }
      var oli = trimmed.match(/^\d{1,9}[.)]\s+(.*)$/);
      if (oli) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(inlineOf(oli[1]));
        continue;
      }
      flushList();
      if (!para) para = [];
      para.push(inline(escapeHtml(line)));
    }
    flushPara(); flushList();
    flushHtml();
    return segs;
  }

  // Renders to an HTML string safe for v-html (input fully escaped).
  // File slots are inert placeholders here; the interactive Timeline
  // uses renderSegments and mounts real cards instead.
  function render(text) {
    return parseBlocks(text, true).map(function (seg) {
      if (seg.type === 'html') return seg.html;
      return '<pre><code>' + escapeHtml(seg.code) + '</code></pre>';
    }).join('');
  }

  // Structured view of the same parse. Paragraph-level slots already came
  // out of parseBlocks as {type:'file'} segments; slots that stayed inline
  // inside list items or table cells are lifted into sibling file segments
  // here (the surrounding fragment keeps its auto-closable tags — v-html
  // fragments are parsed in isolation, so stray close tags are dropped).
  function renderSegments(text) {
    var out = [];
    parseBlocks(text).forEach(function (seg) {
      if (seg.type !== 'html' || !SLOT_SPAN_RE.test(seg.html)) { out.push(seg); return; }
      var parts = String(seg.html).split(/(<span class="locus-file-slot" data-locus-path="[^"]*">[^<]*<\/span>)/);
      parts.forEach(function (part) {
        if (!part) return;
        var m = part.match(SLOT_SPAN_RE);
        if (m) {
          var p = decodeAttr(m[1]);
          out.push({ type: 'file', path: p, name: p.split('/').pop() });
        } else if (part.replace(/<[^>]+>/g, '').trim()) {
          out.push({ type: 'html', html: part });
        }
      });
    });
    return out;
  }

  // Every sandbox: target a message links to (normalized paths, in
  // order, deduplicated) — the task-output list uses this to hide files
  // the message already shows as cards.
  function extractSandboxPaths(text) {
    var clean = String(text || '').replace(/\u0000/g, '');
    var seen = {};
    var out = [];
    clean.replace(/\[[^\]\n]*\]\(sandbox:([^)\s]+)\)/gi, function (m, target) {
      var p = normalizeVfsPath(target);
      if (p && !seen[p]) { seen[p] = true; out.push(p); }
      return m;
    });
    return out;
  }

  return {
    render: render,
    renderSegments: renderSegments,
    extractSandboxPaths: extractSandboxPaths,
    normalizeVfsPath: normalizeVfsPath,
  };
})();
