'use client';

import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

/** Worker SOUL 行数预算（设计约束 v2.39.2：Worker ≤150 行）——超了提示不阻断，与插件一致。 */
export const WORKER_SOUL_LINE_BUDGET = 150;

/**
 * SOUL 输入（对齐插件：多行 textarea + 📎 上传 .md/.txt 粘贴 + 行数预算提示）。
 * WorkerCreateDialog 与建队内联新建 Worker 共用。
 */
export function SoulField({
  value,
  onChange,
  placeholder = 'Worker 人格描述（可选）',
  rows = 3,
}: {
  value: string;
  onChange: (_soul: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const lineCount = value ? value.split('\n').length : 0;

  const handleFile = (file: File) => {
    if (!/\.(md|txt)$/i.test(file.name)) {
      setFileError('仅支持 .md / .txt 文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (!text) {
        setFileError('文件读取为空，已忽略');
        return;
      }
      setFileError(null);
      onChange(text);
    };
    reader.onerror = () => setFileError('文件读取失败，请手动粘贴');
    reader.readAsText(file);
  };

  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <Textarea
          className="w-full min-w-0 resize-y"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={fileRef}
          type="file"
          accept=".md,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs text-muted-foreground"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip className="h-3 w-3 mr-1" aria-hidden="true" />
          上传 SOUL 文件（.md/.txt）
        </Button>
        {lineCount > WORKER_SOUL_LINE_BUDGET && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            SOUL 建议 ≤{WORKER_SOUL_LINE_BUDGET} 行（当前 {lineCount} 行）
          </span>
        )}
        {fileError && <span className="text-xs text-red-600 dark:text-red-400">{fileError}</span>}
      </div>
    </div>
  );
}
