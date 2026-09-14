import * as React from 'react';

/**
 * 产物 tab 图标（9/14 罗总：「看看别的图标是什么风格，然后用 SVG 画一个
 * 箱子之类的东西」）。侧边栏其余图标均为 lucide 线性风格——24×24 viewBox、
 * stroke=2、round linecap/linejoin、无填充。本图标为手绘同款规格：
 * 一个敞口的箱子（底框 + 前缝 + 两片张开的箱盖），区别于 lucide 现成的
 * Package（封箱+胶带）/Box（封闭立方体），语义=装着产物的开箱。
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
    {/* 箱盖（两片，张开） */}
    <path d="M3 9.5 6 5.5l6 3" />
    <path d="M21 9.5 18 5.5l-6 3" />
    {/* 箱口（前缘 V） */}
    <path d="M3 9.5 12 14l9-4.5" />
    {/* 箱体 */}
    <path d="M3 9.5v7l9 4 9-4v-7" />
    {/* 前缝 */}
    <path d="M12 14v7" />
  </svg>
));

ArtifactsBoxIcon.displayName = 'ArtifactsBoxIcon';
