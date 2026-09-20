import { NextRequest, NextResponse } from 'next/server';
import { removePluginPackage } from '@/lib/plugins/server-package';
import { PluginManifestError } from '@/lib/plugins/manifest';
import { getSessionFromRequest } from '@/lib/dashboard-session';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/dashboard/plugins/[id]
 *
 * Removes an installed server plugin package from `public/plugins/<id>/`.
 * The dashboard plugin registry entry is dropped client-side on uninstall.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // SEC-08: Dashboard session + admin level (parity with the POST route).
  const session = getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.level < 3) {
    return NextResponse.json({ error: 'Forbidden: admin (L3) required' }, { status: 403 });
  }

  const { id } = await params;
  try {
    await removePluginPackage(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PluginManifestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[plugins] 删除插件失败:', err);
    return NextResponse.json({ error: '删除插件失败' }, { status: 500 });
  }
}
