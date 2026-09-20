// POST /api/matrix/login - Login to Matrix homeserver
import { NextRequest, NextResponse } from 'next/server';
import {
  HomeserverValidationError,
  validateHomeserverUrl,
} from '@/lib/homeserver-allowlist';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { homeserver, username, password } = body;

    if (!homeserver || !username || !password) {
      return NextResponse.json(
        { error: 'Missing required fields: homeserver, username, password' },
        { status: 400 }
      );
    }

    try {
      // SEC-05：登录请求携带原始用户名/密码，目标 homeserver 必须在允许列表内。
      validateHomeserverUrl(homeserver, { requireAllowlist: true });
    } catch (err) {
      if (err instanceof HomeserverValidationError) {
        return NextResponse.json(
          { error: err.message, reason: err.reason },
          { status: 403 }
        );
      }
      return NextResponse.json({ error: 'Invalid homeserver URL' }, { status: 400 });
    }

    const loginUrl = `${homeserver}/_matrix/client/v3/login`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(loginUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: {
            type: 'm.id.user',
            user: username,
          },
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        return NextResponse.json(
          { error: data.error || data.errmsg || 'Login failed', code: data.errcode },
          { status: res.status }
        );
      }

      return NextResponse.json(data);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
