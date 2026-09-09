import { NextRequest, NextResponse } from 'next/server';
import {
  BACKEND_NAMES,
  backendCandidatesSync,
  effectiveUrl,
  isHttpUrl,
  isTestTargetAllowed,
  listMatchesSaved,
  probeBackend,
  selectAndMark,
  toProbeRow,
  type BackendName,
  type ProbeRow,
} from '@/lib/backend-config';

// POST /api/agentteams/setup/backends/test — server-side connectivity test.
//
// Plugin /config_test semantics (F1c parity):
// - body { backends: { [name]: { internal?, external? } } } = test the DRAFT
//   (unsaved form values) for the given backends; omit/empty = test the
//   currently configured candidate list.
// - A draft test NEVER touches the effective cache; only when the tested
//   list equals the SAVED config list (applied) does selectAndMark re-elect.
// - A failed test NEVER clears the current effective address.
// - Rows carry the two-layer model: ok = network connected (401/403 count),
//   httpOk = status < 400 (only these are election-eligible).
//
// Public (pre-login) by design — the first-launch setup page tests before
// any session exists. SSRF surface pinned by DASHBOARD_ALLOWED_HOSTS.

type DraftAddrs = { internal?: string; external?: string };

function parseDrafts(body: unknown): Partial<Record<BackendName, DraftAddrs>> | null {
  if (body == null) return {};
  if (typeof body !== 'object') return null;
  const raw = (body as { backends?: unknown }).backends;
  if (raw == null) return {};
  if (typeof raw !== 'object') return null;
  const out: Partial<Record<BackendName, DraftAddrs>> = {};
  for (const name of BACKEND_NAMES) {
    const entry = (raw as Record<string, unknown>)[name];
    if (!entry || typeof entry !== 'object') continue;
    const addrs: DraftAddrs = {};
    if (isHttpUrl((entry as DraftAddrs).internal)) addrs.internal = (entry as DraftAddrs).internal!.trim();
    if (isHttpUrl((entry as DraftAddrs).external)) addrs.external = (entry as DraftAddrs).external!.trim();
    if (addrs.internal || addrs.external) out[name] = addrs;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as unknown;
  const drafts = parseDrafts(body);
  if (drafts === null) {
    return NextResponse.json({ ok: false, error: 'invalid-request' }, { status: 400 });
  }

  // Targets: draft values where provided, otherwise the configured list.
  const targets: Partial<Record<BackendName, string[]>> = {};
  for (const name of BACKEND_NAMES) {
    const draft = drafts[name];
    const fromDraft = draft ? [draft.internal, draft.external].filter((v): v is string => !!v) : [];
    const urls = fromDraft.length > 0 ? fromDraft : backendCandidatesSync(name);
    if (urls.length > 0) targets[name] = urls;
  }
  if (Object.keys(targets).length === 0) {
    return NextResponse.json(
      { ok: false, error: 'nothing-to-test', message: 'no addresses provided or configured' },
      { status: 400 },
    );
  }

  // SSRF filter: reject the whole request if any target is disallowed.
  for (const name of Object.keys(targets) as BackendName[]) {
    for (const url of targets[name]!) {
      if (!isTestTargetAllowed(url)) {
        return NextResponse.json({ ok: false, error: 'host-not-allowed', url }, { status: 403 });
      }
    }
  }

  const results: Partial<Record<BackendName, ProbeRow[]>> = {};
  const switched: Partial<Record<BackendName, boolean>> = {};
  let applied = false;

  await Promise.all(
    (Object.keys(targets) as BackendName[]).map(async (name) => {
      const urls = targets[name]!;
      const probeResults = await Promise.all(urls.map((url) => probeBackend(name, url, 6000)));
      const rows = urls.map((url, i) => toProbeRow(url, probeResults[i]));
      results[name] = rows;

      // Effective-cache update is APPLIED-ONLY (plugin config_test): a draft
      // test must never rewrite the working address; a failed probe never
      // clears it (selectAndMark returns null when nobody is eligible).
      if (listMatchesSaved(name, urls)) {
        const prev = effectiveUrl(name);
        const picked = selectAndMark(name, rows);
        applied = true;
        if (picked && prev && prev !== picked) switched[name] = true;
      }
    }),
  );

  const effective: Partial<Record<BackendName, string>> = {};
  for (const name of Object.keys(targets) as BackendName[]) {
    const url = effectiveUrl(name);
    if (url) effective[name] = url;
  }

  return NextResponse.json({ ok: true, results, effective, applied, switched });
}
