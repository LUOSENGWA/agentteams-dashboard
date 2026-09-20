import { NextRequest, NextResponse } from 'next/server';
import { createMinioClient } from '@/lib/minio-client';
import { enforceLevelOnlyRbac } from '@/lib/server-auth';
import { isSensitiveObjectKey } from '@/lib/sensitive-files';
import type { StorageObject } from '@/lib/agentteams-api';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bucket: string }> }
) {
  const denied = await enforceLevelOnlyRbac(request, 'view', 'storage', 'objects');
  if (denied) return denied;
  const { bucket } = await params;
  const prefix = request.nextUrl.searchParams.get('prefix') || '';

  try {
    const client = createMinioClient();
    const objects: StorageObject[] = [];

    await new Promise<void>((resolve, reject) => {
      const stream = client.listObjects(decodeURIComponent(bucket), prefix, false);
      stream.on('data', (obj: Record<string, unknown>) => {
        if (typeof obj.prefix === 'string') {
          objects.push({ key: obj.prefix, size: 0, isPrefix: true });
        } else if (typeof obj.name === 'string') {
          // 敏感文件（worker 凭据类）不进列表：不暴露其存在性。
          if (isSensitiveObjectKey(obj.name)) return;
          objects.push({
            key: obj.name,
            size: typeof obj.size === 'number' ? obj.size : 0,
            lastModified: obj.lastModified ? String(obj.lastModified) : undefined,
            etag: typeof obj.etag === 'string' ? obj.etag : undefined,
          });
        }
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });

    return NextResponse.json({ objects });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown storage error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
