// THE judge for the packaged storage gate's negative self-proof (m3c
// review round 2, F2). ONE implementation, TWO consumers — the real
// browser driver (tests/e2e-m3c-storage-built.cjs) and the unit tests
// (tests/m3c-storage-built-verdict.test.cjs, which feed it the review's
// injected failures) — so the unit suite can never drift from what the
// browser gate actually decides.
//
// The old judge answered "did runBuiltGate throw?" — which classified a
// browser/CDP infrastructure failure exactly like the expected
// broken-artifact rejection ("PASS SELFPROOF" while Chrome never
// launched). The judge now consumes a STRUCTURED driver outcome plus
// request-level observations and requires POSITIVE evidence of the
// expected breakage; anything else fails.
'use strict';

// Driver outcome kinds (produced by runBuiltGate):
//   'infrastructure' — browser launch / CDP / navigation-layer failure
//                      (phase: 'browser-launch' | 'cdp' | 'navigation')
//   'no-boot'        — navigation happened, the page never became ready
//   'boot-error'     — the page booted but reported its own boot failure
//   'assertion'      — booted, checks ran, at least one failed
//   'completed'      — booted, checks ran, all passed
// observations:
//   requests:     [{ url, status, failed, errorText }] — CDP Network
//                 events wired BEFORE navigation (first request included)
//   pageBooted:   bool — window.__m3c.ready observed
//   fallbackLoads:[url] — successful loads outside the allowed set
//                 (product page, source trees, unexpected HTML)
//   serverLog:    [{ path, status }] — the throwaway server's own record
//                 (corroboration; must agree with the CDP observation)

// caseKind: 'host-html-missing' | 'entry-chunk-missing'
// expected: { hostUrl, entryChunkUrl } — the EXACT URLs on this run's own
// test server (entryChunkUrl omitted for the host-html-missing case).
// result:   { kind, phase, error, observations } — one runBuiltGate pass.
// Returns { pass, reason, evidence }.
function classifySelfProof(caseKind, expected, result) {
  const evidence = {
    kind: result ? result.kind : null,
    phase: result ? result.phase || null : null,
    pageBooted: result && result.observations ? result.observations.pageBooted === true : null,
    fallbackLoads: result && result.observations ? result.observations.fallbackLoads || [] : null,
    hostRequest: null,
    chunkRequest: null,
  };
  const fail = (reason) => ({ pass: false, reason, evidence });

  if (!result || !result.observations) return fail('no structured driver result — the judge requires observations, not an exception string');
  const obs = result.observations;
  const requests = Array.isArray(obs.requests) ? obs.requests : [];

  // 1) Browser/CDP/test-server infrastructure failure is NEVER the
  //    expected rejection — it proves nothing about the artifact gate.
  if (result.kind === 'infrastructure') {
    return fail('browser/CDP infrastructure failure (' + (result.phase || 'unknown phase')
      + '): ' + String(result.error && result.error.message || result.error || 'unknown error').slice(0, 300));
  }

  // 2) A page that booted (or booted-and-failed) means the artifact is not
  //    broken as required — including any fallback that started instead.
  if (obs.pageBooted === true) {
    return fail('the target host BOOTED — the broken artifact was not what stopped it'
      + (obs.fallbackLoads && obs.fallbackLoads.length ? '; fallback loads: ' + obs.fallbackLoads.join(', ') : ''));
  }

  // 3) No fallback may paper over the broken artifact.
  if (Array.isArray(obs.fallbackLoads) && obs.fallbackLoads.length > 0) {
    return fail('unexpected fallback loads while the target host never booted: ' + obs.fallbackLoads.join(', '));
  }

  const byUrl = (u) => requests.find((r) => r.url === u) || null;
  const hostReq = byUrl(expected.hostUrl);
  evidence.hostRequest = hostReq && { url: hostReq.url, status: hostReq.status, failed: hostReq.failed === true };
  if (!hostReq) {
    return fail('the exact host URL (' + expected.hostUrl + ') was NEVER requested — no request-level evidence that the browser hit the missing artifact');
  }

  if (caseKind === 'host-html-missing') {
    if (hostReq.status !== 404) {
      return fail('expected the host page request to answer an explicit 404, got ' + (hostReq.failed ? 'network failure' : 'HTTP ' + hostReq.status));
    }
    // Nothing can reference the entry chunk without the page: a successful
    // chunk load would prove something else served a working page.
    const chunkReq = expected.entryChunkUrl ? byUrl(expected.entryChunkUrl) : null;
    evidence.chunkRequest = chunkReq && { url: chunkReq.url, status: chunkReq.status, failed: chunkReq.failed === true };
    if (chunkReq && chunkReq.status === 200) {
      return fail('the entry chunk loaded successfully although the host page is missing — something else served a working page');
    }
  } else if (caseKind === 'entry-chunk-missing') {
    if (hostReq.status !== 200) {
      return fail('case B requires the host HTML to be SERVED first (HTTP 200), got ' + (hostReq.failed ? 'network failure' : 'HTTP ' + hostReq.status));
    }
    const chunkReq = expected.entryChunkUrl ? byUrl(expected.entryChunkUrl) : null;
    evidence.chunkRequest = chunkReq && { url: chunkReq.url, status: chunkReq.status, failed: chunkReq.failed === true };
    if (!chunkReq) {
      return fail('the exact entry chunk (' + expected.entryChunkUrl + ') was NEVER requested — no evidence the broken bundle is what failed');
    }
    if (!(chunkReq.status === 404 || chunkReq.failed === true)) {
      return fail('expected the entry chunk request to fail/404, got HTTP ' + chunkReq.status);
    }
  } else {
    return fail('unknown self-proof case kind: ' + String(caseKind));
  }

  // 4) Corroboration: the throwaway server's own log must agree with what
  //    the browser observed (the request hit THIS test server).
  const serverLog = Array.isArray(obs.serverLog) ? obs.serverLog : [];
  const hostPath = serverPathOf(expected.hostUrl);
  const serverHostEntry = serverLog.find((e) => e.path === hostPath);
  if (!serverHostEntry) {
    return fail('the test server never logged the host request (' + hostPath + ') — browser and server observations disagree');
  }
  if (caseKind === 'host-html-missing' && serverHostEntry.status !== 404) {
    return fail('test server logged HTTP ' + serverHostEntry.status + ' for the host page, expected 404');
  }
  if (caseKind === 'entry-chunk-missing') {
    if (serverHostEntry.status !== 200) {
      return fail('test server logged HTTP ' + serverHostEntry.status + ' for the host page, expected 200 (case B serves the HTML)');
    }
    const chunkPath = serverPathOf(expected.entryChunkUrl);
    const serverChunkEntry = serverLog.find((e) => e.path === chunkPath);
    if (!serverChunkEntry || !(serverChunkEntry.status === 404)) {
      return fail('test server did not log a 404 for the entry chunk (' + chunkPath + ') — browser and server observations disagree');
    }
  }

  return {
    pass: true,
    reason: 'expected broken-artifact rejection observed at the exact resource',
    evidence,
  };
}

// http://127.0.0.1:PORT/tests/m3c-storage-host.html -> /tests/...
function serverPathOf(url) {
  try { return new URL(url).pathname; } catch (e) { return null; }
}

module.exports = { classifySelfProof, serverPathOf };
