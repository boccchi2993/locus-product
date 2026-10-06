// MutationPolicy tests (M1b, repository split): the skill-identity rules
// are PRODUCT policy (src/mutation-policy.js) consumed by the generic
// runtime shell through opts.mutationPolicy — the shell carries NO
// hardcoded /home/locus/.skills knowledge anymore.
//
//  MP1  the byte-stable refusal matrix through the REAL shell: mv out of /
//       into the skills tree, rm of skill DIRECTORIES (recursive or not) —
//       with the exact refusal texts the shell used to hardcode;
//  MP2  the shell executes the INJECTED policy, not a baked-in rule: a
//       different policy (guarding another tree) is enforced verbatim and
//       ~/.skills moves are ALLOWED by it;
//  MP3  no policy injected = the generic runtime's neutral behavior
//       (skills paths are plain writable paths);
//  MP4  path shapes: relative paths, .., redundant segments, trailing
//       slashes resolve BEFORE the policy sees them — no spelling slips
//       through;
//  MP5  the mv final destination (basename appended for mv-into-directory)
//       and multi-source moves are judged on the real target;
//  MP6  a single declared skill FILE stays deletable (the per-file
//       approval guard owns it), while capability directories are refused;
//  MP7  non-skill operations are not over-blocked;
//  MP8  the VFS's own protections (protected roots, read-only mounts)
//       still refuse WITH a policy present — the policy never grants;
//  MP9  isPolicyRefusal: python commit-phase errors from the policy family
//       report as honest conflicts with the policy injected, and as plain
//       write failures without it.
//
// Real-product assembly (the store injects THIS policy into every bash
// call and fails loudly without it) is pinned in
// tests/store-python-lifecycle.test.mjs; the browser e2e skill-instances
// suite drives the same chain through the built app.
//
// M3c integration: the suite drives the REAL installed runtime through its
// PUBLIC session surface — session.execute({ kind: 'shell' }) — with the
// Product policy injected per call, exactly as the store's ToolPort does.
// MP9 disposition: the old section injected a hand-stubbed interpreter
// (opts.pythonRuntime — no longer public); the shell→python-commit→
// policy-classification MECHANISM is pinned runtime-side by locus-runtime
// tests/mutation-policy.test.cjs MP-G7, and this suite keeps the
// PRODUCT-specific half (which error codes the Locus policy classifies as
// refusals) as direct policy checks. Real browser python stays gated by
// the e2e python suites.
// Run: node tests/mutation-policy.test.cjs

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null };

let runtimeApi = null;
let LocusMutationPolicy = null;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const IDENTITY_MSG = 'Skill instance paths are stable; edit the skill in place, '
  + 'delete the individual skill with approval, or remove/re-add the capability.';
let policy = null;   // created in run() after the imports
const bare = () => runtimeApi.createWorkspace();

async function freshSkillsTree(vfs) {
  await vfs.mkdir('/home/locus/.skills');
  await vfs.mkdir('/home/locus/.skills/cap-a');
  await vfs.mkdir('/home/locus/.skills/cap-a/sub');
  await vfs.write('/home/locus/.skills/cap-a/synthetic-skill.skill', 'guidance\n');
  await vfs.write('/home/locus/notes.txt', 'mine\n');
  await vfs.mkdir('/tmp/work');
  await vfs.write('/tmp/work/other.txt', 'other\n');
}

async function run() {
  runtimeApi = await import('../src/product/runtime-api.js');
  ({ LocusMutationPolicy } = await import('../src/mutation-policy.js'));
  policy = LocusMutationPolicy.create();
  // ONE real runtime host + session (the public surface); every section
  // builds a fresh workspace and injects the policy per call.
  const host = await runtimeApi.createRuntime({
    workerAssets: {
      pyWorkerSource: runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE,
      grepWorkerSource: runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE,
    },
  });
  const session = host.createSession();
  const shellRun = (cmd, vfs, opts) => session.execute({
    kind: 'shell', input: cmd,
    context: Object.assign({ filesystem: vfs }, opts || {}),
  });

  try {
  // ================= MP1. byte-stable refusal matrix =================
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: policy });

    const mv1 = await run('mv /home/locus/.skills/cap-a/synthetic-skill.skill /home/locus/renamed.skill');
    check('MP1 mv of a skill instance is refused with the identity contract',
      mv1.isError && mv1.output === 'mv: /home/locus/.skills/cap-a/synthetic-skill.skill: ' + IDENTITY_MSG,
      JSON.stringify(mv1.output));
    check('MP1b nothing was moved',
      await vfs.exists('/home/locus/.skills/cap-a/synthetic-skill.skill')
        && !(await vfs.exists('/home/locus/renamed.skill')));

    const mv2 = await run('mv /home/locus/notes.txt /home/locus/.skills/cap-a/incoming.skill');
    check('MP1c mv INTO the skills tree is refused (destination side)',
      mv2.isError && mv2.output === 'mv: /home/locus/notes.txt: ' + IDENTITY_MSG, JSON.stringify(mv2.output));
    check('MP1d the source survived and nothing landed inside',
      await vfs.exists('/home/locus/notes.txt') && !(await vfs.exists('/home/locus/.skills/cap-a/incoming.skill')));

    const mv3 = await run('mv /home/locus/.skills/cap-a /home/locus/moved-cap');
    check('MP1e mv of a capability DIRECTORY is refused',
      mv3.isError && mv3.output === 'mv: /home/locus/.skills/cap-a: ' + IDENTITY_MSG, JSON.stringify(mv3.output));

    const rm1 = await run('rm -r /home/locus/.skills/cap-a');
    check('MP1f rm -r of a capability directory is refused with the exact text',
      rm1.isError && rm1.output === 'rm: refusing to remove capability skill directory: /home/locus/.skills/cap-a. ' + IDENTITY_MSG,
      JSON.stringify(rm1.output));
    check('MP1g the directory survived with its files',
      await vfs.exists('/home/locus/.skills/cap-a/synthetic-skill.skill'));

    const rm2 = await run('rm -r /home/locus/.skills');
    check('MP1h rm -r of the skills ROOT is refused identically',
      rm2.isError && rm2.output === 'rm: refusing to remove capability skill directory: /home/locus/.skills. ' + IDENTITY_MSG,
      JSON.stringify(rm2.output));

    const rm3 = await run('rm /home/locus/.skills/cap-a');
    check('MP1i rm of a skill directory WITHOUT -r is refused by the policy too',
      rm3.isError && rm3.output.startsWith('rm: refusing to remove capability skill directory:'), JSON.stringify(rm3.output));
  }

  // ============ MP2. the shell executes the INJECTED policy ============
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    // A DIFFERENT product policy: guards /mnt/protected, never ~/.skills.
    const other = {
      checkMove(a) {
        if (a.source.indexOf('/mnt/protected') === 0 || a.destination.indexOf('/mnt/protected') === 0) {
          return { allowed: false, reason: 'custom tree is immutable' };
        }
        return { allowed: true };
      },
      checkRemove(a) {
        if (a.target.indexOf('/mnt/protected') === 0) {
          return { allowed: false, reason: 'custom tree is immutable' };
        }
        return { allowed: true };
      },
      isPolicyRefusal(e) { return !!e && e.code === 'custom_refusal'; },
    };
    // A REAL writable mount (a plain memory provider) guarded by the
    // alternative policy — the custom tree must be a legal VFS target.
    vfs.mount('/mnt/protected', runtimeApi.createMemoryWorkspace({ name: 'protected' }), 'read-write');
    await vfs.write('/mnt/protected/data.txt', 'locked\n');
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: other });

    const r1 = await run('mv /mnt/protected/data.txt /tmp/work/data.txt');
    check('MP2 the alternative policy is enforced verbatim',
      r1.isError && r1.output === 'mv: /mnt/protected/data.txt: custom tree is immutable',
      JSON.stringify(r1.output));
    const r2 = await run('mv /home/locus/.skills/cap-a/synthetic-skill.skill /tmp/work/skill.skill');
    check('MP2b the same shell ALLOWS a skills-tree move under the alternative policy',
      !r2.isError && !(await vfs.exists('/home/locus/.skills/cap-a/synthetic-skill.skill'))
        && (await vfs.exists('/tmp/work/skill.skill')),
      JSON.stringify(r2.output));
    const r3 = await run('rm -r /mnt/protected');
    check('MP2c the alternative policy refuses its own tree on rm',
      r3.isError && r3.output === 'rm: custom tree is immutable', JSON.stringify(r3.output));
    // mv -f style flag refusals and VFS rules are runtime-owned and unchanged.
    const r4 = await run('mv -f /home/locus/notes.txt /tmp/work/x.txt');
    check('MP2d runtime-owned command rules are untouched by the policy port',
      r4.isError && r4.output.includes('mv: -f is not supported'), JSON.stringify(r4.output));
  }

  // ============ MP3. no policy = neutral generic runtime ============
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const r1 = await shellRun('mv /home/locus/.skills/cap-a/synthetic-skill.skill /tmp/work/skill.skill', vfs, {});
    check('MP3 without a policy the skills tree is a plain path (generic runtime)',
      !r1.isError && (await vfs.exists('/tmp/work/skill.skill')), JSON.stringify(r1.output));
    const r2 = await shellRun('rm -r /home/locus/.skills', vfs, {});
    check('MP3b rm -r of the skills tree without a policy is VFS-rules-only',
      !r2.isError && !(await vfs.exists('/home/locus/.skills')), JSON.stringify(r2.output));
  }

  // ============ MP4. path shapes resolve before the policy ============
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: policy });

    const spellings = [
      'mv /home/locus/.skills/../.skills/cap-a/synthetic-skill.skill /tmp/work/x.skill',
      'mv /home/locus//.skills/cap-a/synthetic-skill.skill /tmp/work/x.skill',
      'mv /home/locus/.skills/./cap-a/synthetic-skill.skill /tmp/work/x.skill',
      'mv /home/locus/.skills/cap-a/synthetic-skill.skill/ /tmp/work/x.skill',
    ];
    for (let i = 0; i < spellings.length; i++) {
      await freshSkillsTree(vfs); // restore the file each round
      const r = await run(spellings[i]);
      check('MP4.' + i + ' spelling is normalized before the policy: ' + spellings[i].slice(0, 46) + '…',
        r.isError && r.output === 'mv: ' + spellings[i].split(' ')[1] + ': ' + IDENTITY_MSG,
        JSON.stringify(r.output));
    }

    // Relative paths against an explicit cwd are resolved by the shell.
    const r5 = await shellRun('cd /home/locus && mv .skills/cap-a/synthetic-skill.skill /tmp/work/x.skill', vfs,
      { mutationPolicy: policy });
    check('MP4b a relative path into the skills tree is refused after resolution',
      r5.isError && r5.output === 'mv: .skills/cap-a/synthetic-skill.skill: ' + IDENTITY_MSG,
      JSON.stringify(r5.output));
    const r6 = await shellRun('cd /home/locus/.skills/cap-a/sub && rm -r ../../../.skills', vfs,
      { mutationPolicy: policy });
    check('MP4c .. traversal out of a nested cwd still lands on the skills root',
      r6.isError && r6.output === 'rm: refusing to remove capability skill directory: /home/locus/.skills. ' + IDENTITY_MSG,
      JSON.stringify(r6.output));
  }

  // ============ MP5. final destination + multi-source ============
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: policy });

    // mv INTO a directory appends the basename — the FINAL target is under
    // the skills tree, so the refusal fires on the resolved destination.
    const m1 = await run('mv /home/locus/notes.txt /home/locus/.skills');
    check('MP5 mv-into-directory is judged on the basename-appended target',
      m1.isError && m1.output === 'mv: /home/locus/notes.txt: ' + IDENTITY_MSG, JSON.stringify(m1.output));

    // A skills-tree source moved INTO an existing directory elsewhere: the
    // SOURCE side still refuses.
    const m2 = await run('mv /home/locus/.skills/cap-a /tmp/work');
    check('MP5b moving a capability directory OUT is refused',
      m2.isError && m2.output === 'mv: /home/locus/.skills/cap-a: ' + IDENTITY_MSG, JSON.stringify(m2.output));

    // Multi-source mv into the skills tree: refused, nothing moved.
    const m3 = await run('mv /home/locus/notes.txt /tmp/work/other.txt /home/locus/.skills');
    check('MP5c multi-source mv into the skills tree is refused',
      m3.isError && m3.output === 'mv: /home/locus/notes.txt: ' + IDENTITY_MSG, JSON.stringify(m3.output));
    check('MP5d no source moved',
      await vfs.exists('/home/locus/notes.txt') && (await vfs.exists('/tmp/work/other.txt')));

    // A move whose final target is OUTSIDE the skills tree passes: dest dir
    // /home/locus is not under the root, finalAbs = /home/locus/x.skill.
    await vfs.write('/tmp/work/incoming.skill', 'x\n');
    const m4 = await run('mv /tmp/work/incoming.skill /home/locus');
    check('MP5e a destination NEXT TO the skills tree is allowed',
      !m4.isError && (await vfs.exists('/home/locus/incoming.skill')), JSON.stringify(m4.output));
  }

  // ============ MP6. single skill files stay on their approval path ======
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: policy });
    const r = await run('rm /home/locus/.skills/cap-a/synthetic-skill.skill');
    check('MP6 a single declared skill FILE is not refused by the policy (per-file guard owns it)',
      !r.isError && !(await vfs.exists('/home/locus/.skills/cap-a/synthetic-skill.skill')),
      JSON.stringify(r.output));
  }

  // ============ MP7. non-skill operations are not over-blocked ==========
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: policy });
    const r1 = await run('mv /home/locus/notes.txt /tmp/work/notes.txt');
    check('MP7 ordinary mv is untouched', !r1.isError && (await vfs.exists('/tmp/work/notes.txt')), JSON.stringify(r1.output));
    const r2 = await run('rm -r /tmp/work');
    check('MP7b ordinary rm -r outside the skills tree is untouched',
      !r2.isError && !(await vfs.exists('/tmp/work')), JSON.stringify(r2.output));
    const r3 = await run('echo created > /home/locus/created.txt');
    check('MP7c non-mv/rm file work is untouched by the policy port (the mount guard owns those)',
      !r3.isError && (await vfs.exists('/home/locus/created.txt')), JSON.stringify(r3.output));
  }

  // ============ MP8. VFS protections still hold WITH the policy =========
  {
    const vfs = bare();
    await freshSkillsTree(vfs);
    const run = (cmd) => shellRun(cmd, vfs, { mutationPolicy: policy });
    const r1 = await run('rm -r /home/locus');
    check('MP8 the protected-root refusal stays a RUNTIME check (never the policy)',
      r1.isError && r1.output.startsWith('rm: refusing to recursively remove protected path: /home/locus'),
      JSON.stringify(r1.output));
    // Order preservation: the policy check sits exactly where the old
    // hardcoded check sat — BEFORE the stat/into-itself rules — so a skill
    // path gets the identity refusal, not the geometric one.
    const r2 = await run('mv /home/locus/.skills /home/locus/.skills/cap-a/sub');
    check('MP8b skill paths get the identity refusal first (original check order preserved)',
      r2.isError && r2.output === 'mv: /home/locus/.skills: ' + IDENTITY_MSG, JSON.stringify(r2.output));
    // The geometric rule itself stays runtime-owned for non-skill trees.
    vfs.mount('/mnt/area', runtimeApi.createMemoryWorkspace({ name: 'area' }), 'read-write');
    await vfs.write('/mnt/area/keep.txt', 'x\n');
    const r3 = await run('mv /mnt/area /mnt/area/inside');
    check('MP8c mount-root protection is still the runtime\'s refusal',
      r3.isError && r3.output.includes('cannot move a directory into itself'),
      JSON.stringify(r3.output));
  }

  // ============ MP9. the PRODUCT policy's refusal classification =========
  // (M3c integration: the shell→python-commit→classification MECHANISM is
  // pinned runtime-side by locus-runtime MP-G7 with the same fake-worker
  // technique — interpreter injection is no longer public surface, and
  // real browser python is the e2e gates' job. This suite keeps the
  // PRODUCT-specific half: WHICH error codes the Locus policy reports as
  // its own refusals, consulted by the runtime's commit phase.)
  {
    const declined = Object.assign(new Error('declined by the user'), { code: 'skill_mutation_declined' });
    const plain = Object.assign(new Error('disk full'), { code: 'quota_exceeded' });
    check('MP9 the policy classifies the declined-mutation family as its own refusal',
      policy.isPolicyRefusal(declined) === true, JSON.stringify({ code: declined.code }));
    check('MP9b an ordinary write error is NOT a policy refusal (plain failure, never a conflict)',
      policy.isPolicyRefusal(plain) === false && policy.isPolicyRefusal(new Error('nope')) === false,
      'plain errors must fall through to the honest write-failure report');
  }

  } finally {
    await host.dispose('mutation-policy suite end');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
