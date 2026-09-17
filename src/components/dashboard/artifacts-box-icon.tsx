import * as React from 'react';

/**
 * 产物 tab 图标（9/14 罗总：「看看别的图标是什么风格，然后用 SVG 画一个
 * 箱子之类的东西」）。侧边栏其余图标均为 lucide 线性风格——24×24 viewBox、
 * stroke=2、round linecap/linejoin、无填充。
 *
 * 9/16 重画（verify-98a7109 装验反馈：「那个图标可以画得更像个箱子，
 * 现在像本书」）：初版的敞口箱盖两片斜线视觉上读成了摊开的书，改为封闭
 * 立方体（顶面菱形 + 箱体 + 前缝）——箱子语义一眼可辨，与知识库摊书
 * 图标（knowledge-book-icon）拉开区分度。
 *
 * props 对齐 lucide 图标（SVGProps + size），可直接当 LucideIcon 用。
 */
export const ArtifactsBoxIcon = React.forwardRef<
  SVGSVGElement,
  React.SVGProps<SVGSVGElement> & {
    size?: string | number;
    /** lucide 同款 prop（NavItem.icon 类型兼容；本图标描边恒为 2）。 */
    absoluteStrokeWidth?: boolean;
  }
>(({ size = 24, absoluteStrokeWidth: _absoluteStrokeWidth, ...props }, ref) => (
  <svg
    ref={ref}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {/* 顶面（菱形） */}
    <path d="M12 3.5 3 8.5l9 5 9-5-9-5" />
    {/* 箱体 */}
    <path d="M3 8.5v8l9 5 9-5v-8" />
    {/* 前缝 */}
    <path d="M12 13.5v8" />
  </svg>
));

ArtifactsBoxIcon.displayName = 'ArtifactsBoxIcon';
