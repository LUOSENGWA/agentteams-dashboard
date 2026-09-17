// POST /api/matrix/delete-devices - F7 S4: revoke a Matrix device session.
//
// Deletes the device identified by the client (the browser's own
// device_id, persisted from login). Deleting the device invalidates its
// access token server-side — the "revoke this device" button in the
// client settings. The caller authenticates with the device's own access
// token (Authorization header, the same convention as the other
// /api/matrix/* proxy routes).
//
// allowPrivateNetwork: true — a stateless deployment's homeserver is a
// LAN address the browser is already on (same bounded rationale as
// /api/matrix/static-login).
import { NextRequest, NextResponse } from 'next/server';
import {
  HomeserverValidationError,
  validateHomeserverUrl,
} from '@/lib/homeserver-allowlist';

function getAccessToken(request: NextRequest): string {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return '';
  const [scheme, token] = authHeader.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token || '' : '';
}

export async function POST(request: NextRequest) {
  const accessToken = getAccessToken(request);
  if (!accessToken) {
    return NextResponse.json(
      { error: 'Missing Authorization header (Bearer <access_token>)' },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { homeserver, deviceId } = body as { homeserver?: string; deviceId?: string };
  if (!homeserver || !deviceId) {
    return NextResponse.json(
      { error: 'Missing required fields: homeserver, deviceId' },
      { status: 400 },
    );
  }

  let parsed: URL;
  try {
    parsed = validateHomeserverUrl(homeserver, { allowPrivateNetwork: true });
  } catch (err) {
    if (err instanceof HomeserverValidationError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 403 });
    }
    return NextResponse.json({ error: 'Invalid homeserver URL' }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(
      `${parsed.origin}/_matrix/client/v3/delete_devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || data.errmsg || 'Device revocation failed', code: data.errcode },
        { status: res.status },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, reason: 'unreachable' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
