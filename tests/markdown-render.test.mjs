// Markdown-lite extended rendering (owner task 2026-10-31, add-only):
// fenced code blocks (language, unclosed, raw content), ordered lists,
// GFM tables (alignment, escapes), protocol-allowlisted links
// (http/https only; javascript:/data:/file: stay literal), sandbox:
// file-card slots (path normalization, extraction) and the injection
// sweep — `<script>` etc. must be escaped inside EVERY new syntax.
// Run: node tests/markdown-render.test.mjs

const { LocusMarkdown: M } = await import('../src/ui/markdown.js');
const { locusEnvironmentNotes } = await import('../src/ui/product-prompt.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

(async () => {
  // ---------- MD-C. fenced code blocks ----------
  {
    const segs = M.renderSegments('```json\n{"k": [1, 2]}\n```');
    check('MD-C1 code block segment with language',
      segs.length === 1 && segs[0].type === 'code' && segs[0].lang === 'json'
      && segs[0].code === '{"k": [1, 2]}', JSON.stringify(segs));

    // Unclosed fence runs to the end of the message; preceding prose stays prose.
    const u = M.renderSegments('before\n```py\nx = 1\ny = 2');
    check('MD-C2 unclosed fence consumes to end',
      u.length === 2 && u[0].type === 'html' && u[1].type === 'code'
      && u[1].lang === 'py' && u[1].code === 'x = 1\ny = 2', JSON.stringify(u));

    // Inline grammar must NOT run inside the block: ** stays literal, raw
    // < is escaped at render time (string view) and raw in the segment.
    const raw = M.renderSegments('```\n**not bold** and <b>\n```')[0];
    check('MD-C3 block content keeps ** and < raw',
      raw.code === '**not bold** and <b>', JSON.stringify(raw));
    const html = M.render('```\n**not bold** and <b>\n```');
    check('MD-C4 block content escaped in the string view',
      html.includes('<pre><code>**not bold** and &lt;b&gt;</code></pre>')
      && !html.includes('<b>') && !html.includes('<strong>'), html);

    const tilde = M.renderSegments('~~~js\nlet x = 1;\n~~~');
    check('MD-C5 tilde fence with language',
      tilde.length === 1 && tilde[0].type === 'code' && tilde[0].lang === 'js'
      && tilde[0].code === 'let x = 1;', JSON.stringify(tilde));

    // A DIFFERENT fence character never closes; a SHORTER same-char fence
    // never closes; a longer one does (CommonMark closing-fence rule).
    const inner = M.renderSegments('```\na\n~~~\nb\n```');
    check('MD-C6a other-char fence does not close',
      inner.length === 1 && inner[0].code === 'a\n~~~\nb', JSON.stringify(inner));
    const short = M.renderSegments('`````\na\n```\nb\n`````');
    check('MD-C6b shorter same-char fence does not close',
      short.length === 1 && short[0].code === 'a\n```\nb', JSON.stringify(short));

    const blank = M.renderSegments('```\n\nkeep blank lines\n\n```');
    check('MD-C7 blank lines kept verbatim', blank[0].code === '\nkeep blank lines\n', JSON.stringify(blank));

    check('MD-C8 language label lowercased and first word only',
      M.renderSegments('```Python extra words\nx\n```')[0].lang === 'python');
  }

  // ---------- MD-O. ordered lists ----------
  {
    const html = M.render('1. one\n2. two\n3. three');
    check('MD-O1 ordered list renders <ol>',
      html.includes('<ol><li>one</li><li>two</li><li>three</li></ol>'), html);
    check('MD-O2 ordered item keeps inline syntax',
      M.render('1. **bold** and `c`').includes('<li><strong>bold</strong> and <code>c</code></li>'),
      M.render('1. **bold** and `c`'));
    check('MD-O3 paren marker accepted',
      M.render('1) a\n2) b').includes('<ol><li>a</li><li>b</li></ol>'), M.render('1) a\n2) b'));
    check('MD-O4 unordered and ordered do not merge',
      M.render('- a\n1. b').includes('<ul><li>a</li></ul><ol><li>b</li></ol>'),
      M.render('- a\n1. b'));
  }

  // ---------- MD-T. GFM tables ----------
  {
    const html = M.render('| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |');
    check('MD-T1 alignment from delimiter row',
      html.includes('<th>Left</th>')
      && html.includes('<th style="text-align:center">Center</th>')
      && html.includes('<th style="text-align:right">Right</th>')
      && html.includes('<td style="text-align:right">c</td>'), html);
    check('MD-T2 inline syntax inside cells',
      M.render('| x |\n| --- |\n| **b** `c` |').includes('<td><strong>b</strong> <code>c</code></td>'),
      M.render('| x |\n| --- |\n| **b** `c` |'));
    check('MD-T3 rows accumulate; padding/truncation to header width',
      (() => {
        const h = M.render('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |');
        return h.includes('<td>1</td><td></td>') && h.includes('<td>1</td><td>2</td></tr>');
      })(), M.render('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |'));
    check('MD-T4 escaped pipe stays a literal pipe in the cell',
      M.render('| a |\n| --- |\n| x\\|y |').includes('<td>x|y</td>'),
      M.render('| a |\n| --- |\n| x\\|y |'));
    // GFM rule: an UNESCAPED pipe splits cells even inside code spans —
    // the leftover backtick stays literal (unclosed span).
    check('MD-T5 unescaped pipe splits cells inside code spans (GFM rule)',
      M.render('| a |\n| --- |\n| `x|y` |').includes('<td>`x</td>'),
      M.render('| a |\n| --- |\n| `x|y` |'));
    check('MD-T6 no delimiter row → plain paragraph, no table',
      M.render('| a | b |\n| not | a | delim |').startsWith('<p>| a | b |')
      && !M.render('| a | b |\n| not | a | delim |').includes('<table>'),
      M.render('| a | b |\n| not | a | delim |'));
  }

  // ---------- MD-L. links: http/https only ----------
  {
    const a = M.render('[docs](https://example.com/x?y=1&z=2)');
    check('MD-L1 https link attributes',
      a.includes('<a href="https://example.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer"')
      && a.includes('title="https://example.com/x?y=1&amp;z=2"')
      && a.includes('ext-link-icon'), a);
    check('MD-L2 http link also anchors',
      M.render('[h](http://example.com/)').includes('<a href="http://example.com/"'));
    check('MD-L3 bare https URL anchors with trailing punctuation outside',
      M.render('see https://ex.com/p, then go.').includes('<a href="https://ex.com/p"')
      && !M.render('see https://ex.com/p, then go.').includes('ex.com/p,'), M.render('see https://ex.com/p, then go.'));
    const lit1 = M.render('[c](javascript:alert(1))');
    check('MD-L4 javascript: stays literal', lit1 === '<p>[c](javascript:alert(1))</p>', lit1);
    check('MD-L5 data: stays literal',
      M.render('[c](data:text/html,<b>x</b>)').includes('](data:'));
    const lit3 = M.render('[c](file:///etc/passwd)');
    check('MD-L6 file: stays literal', !lit3.includes('<a ') && lit3.includes('](file:///etc/passwd)'), lit3);
    check('MD-L7 vbscript: stays literal',
      !M.render('[c](vbscript:x)').includes('<a '));
    check('MD-L8 relative target stays literal',
      !M.render('[c](docs/readme.md)').includes('<a '));
    check('MD-L9 javascript: bare word is not a bare-URL match',
      !M.render('call javascript:void(0) now').includes('<a '));
  }

  // ---------- MD-F. sandbox: file cards ----------
  {
    const segs = M.renderSegments('[report.csv](sandbox:/mnt/download/report.csv)');
    check('MD-F1 sandbox link becomes a file segment',
      segs.length === 1 && segs[0].type === 'file'
      && segs[0].path === '/mnt/download/report.csv' && segs[0].name === 'report.csv',
      JSON.stringify(segs));
    check('MD-F2 string view keeps an inert placeholder with the path',
      M.render('[f](sandbox:/mnt/download/f.txt)').includes('data-locus-path="/mnt/download/f.txt"'),
      M.render('[f](sandbox:/mnt/download/f.txt)'));
    check('MD-F3 percent escapes decode before use',
      M.renderSegments('[x](sandbox:/mnt/download/a%20b.txt)')[0].path === '/mnt/download/a b.txt');
    check('MD-F4 relative path refused → literal text',
      M.render('[x](sandbox:rel/file)').includes('[x](sandbox:rel/file)')
      && M.renderSegments('[x](sandbox:rel/file)')[0].type === 'html');
    check('MD-F5 .. traversal refused → literal text',
      M.renderSegments('[x](sandbox:/mnt/../../etc)')[0].type === 'html'
      && M.renderSegments('[x](sandbox:%2e%2e/x)')[0].type === 'html');
    check('MD-F6 non-absolute and bare root refused',
      M.normalizeVfsPath('mnt/x') === null && M.normalizeVfsPath('/') === null);
    check('MD-F7 dot segments collapse, duplicates collapse, order kept',
      M.normalizeVfsPath('/mnt/./download//a.txt') === '/mnt/download/a.txt');
    const mix = M.renderSegments('here [a.txt](sandbox:/mnt/download/a.txt) and [b.locus](sandbox:/mnt/download/b.locus)');
    check('MD-F8 cards hoist out of the paragraph in order',
      mix.length === 4 && mix[0].type === 'html' && mix[0].html.includes('here ')
      && mix[1].path === '/mnt/download/a.txt'
      && mix[2].type === 'html' && mix[2].html.includes(' and ')
      && mix[3].path === '/mnt/download/b.locus',
      JSON.stringify(mix));
    check('MD-F9 extractSandboxPaths dedupes and keeps order',
      JSON.stringify(M.extractSandboxPaths(
        '[x](sandbox:/mnt/download/1.txt) [y](sandbox:/mnt/download/1.txt) [z](sandbox:/mnt/download/2.locus)',
      )) === JSON.stringify(['/mnt/download/1.txt', '/mnt/download/2.locus']));
  }

  // ---------- MD-X. injection sweep over every new syntax ----------
  {
    const evil = '<script>alert(1)</script>';
    const samples = [
      ['fence', '```\n' + evil + '\n```'],
      ['fence lang', '```' + evil + '\nx\n```'],
      ['ordered list', '1. ' + evil],
      ['table head', '| ' + evil + ' |\n| --- |\n| x |'],
      ['table cell', '| h |\n| --- |\n| ' + evil + ' |'],
      ['link text', '[' + evil + '](https://x.example)'],
      ['link target', '[x](https://ex.example/' + evil + ')'],
      ['bare url', 'https://ex.example/?' + evil],
      ['sandbox path', '[x](sandbox:/mnt/download/' + evil + ')'],
      ['img onerror', '<img src=x onerror=alert(1)>'],
      ['iframe', '<iframe src="https://ex.example"></iframe>'],
    ];
    for (const [name, input] of samples) {
      const html = M.render(input);
      check('MD-X ' + name + ' escapes script tags',
        !html.includes('<script>') && !html.includes('<img src=x')
        && !html.includes('<iframe'), html.slice(0, 160));
    }
    // The quote escape closes the one attribute-injection route the file
    // slot has (its data-locus-path attribute): a raw quote in the path
    // can only ever appear as &quot; inside the attribute value.
    const attr = M.render('[x](sandbox:/mnt/download/a"onmouseover="alert(1))');
    check('MD-X file slot attribute cannot break out',
      attr.includes('<span class="locus-file-slot" data-locus-path="')
      && !/onmouseover="/.test(attr), attr);
    check('MD-X file slot path round-trips its quotes through the segment',
      M.renderSegments('[x](sandbox:/mnt/download/a"b)')[0].path === '/mnt/download/a"b',
      JSON.stringify(M.renderSegments('[x](sandbox:/mnt/download/a"b)')));
  }

  // ---------- MD-E. environment note line (file-delivery doc) ----------
  {
    const notes = locusEnvironmentNotes({});
    const line = '- To give the user a file, save it under /mnt/download and link it in your reply as [file name](sandbox:/mnt/download/<file name>); the user sees a download card (and an Import button for .locus files).';
    check('MD-E environment notes carry the sandbox doc line verbatim',
      notes.split('\n').includes(line), notes.split('\n').join(' ⏎ '));
  }

  console.log('---');
  console.log('markdown-render.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
