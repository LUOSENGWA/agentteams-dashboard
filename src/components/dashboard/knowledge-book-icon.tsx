import * as React from 'react';

/**
 * 知识库 tab 图标（9/14 罗总：「知识库加个新 tab，图标用 SVG 画个不违和契合
 * 风格的，像画产物那个那样，画本书」）。侧边栏其余图标均为 lucide 线性风格——
 * 24×24 viewBox、stroke=2、round linecap/linejoin、无填充。本图标为手绘同款规格：
 * 一本摊开的书（中缝 + 左右两页 + 页缘），语义=知识库。区别于 lucide 现成的
 * Book（合拢的书本，语义偏「书籍/阅读」）与 BookOpen（官方摊书——中缝单线、
 * 页面无分栏），本图为双页分栏摊书，视觉重心更稳、信息量更「库」。
 *
 * props 对齐 lucide 图标（SVGProps + size），可直接当 LucideIcon 用。
 */
export const KnowledgeBookIcon = React.forwardRef<
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
    {/* 左页（外缘 + 内页缘分栏线） */}
    <path d="M12 6.5C10.5 5 8.3 4.2 4 4.2v13.6c4.3 0 6.5.8 8 2.2" />
    <path d="M12 6.5V20" />
    {/* 右页（与左页镜像） */}
    <path d="M12 6.5C13.5 5 15.7 4.2 20 4.2v13.6c-4.3 0-6.5.8-8 2.2" />
    {/* 左页页缘两行（页内文字意象） */}
    <path d="M6.5 8.5c1.5.2 2.7.6 3.5 1.2" />
    <path d="M6.5 11.5c1.5.2 2.7.6 3.5 1.2" />
    {/* 右页页缘两行 */}
    <path d="M17.5 8.5c-1.5.2-2.7.6-3.5 1.2" />
    <path d="M17.5 11.5c-1.5.2-2.7.6-3.5 1.2" />
  </svg>
));

KnowledgeBookIcon.displayName = 'KnowledgeBookIcon';
