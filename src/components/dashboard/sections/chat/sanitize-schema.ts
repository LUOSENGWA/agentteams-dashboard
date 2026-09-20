// 聊天 Markdown 渲染的 rehype-sanitize schema（SEC-04）。
//
// rehypeRaw 会把用户可控消息里的原始 HTML 变成真实 DOM，因此必须在
// rehypeRaw 之后立刻过 sanitize；rehypeHighlight / rehypeKatex 排在其后，
// 由可信插件生成的内容（hljs/katex class）不经过清洗即可保留。
//
// schema 在 hast-util-sanitize defaultSchema（含协议白名单、clobber
// 防护）之上做最小扩展：
// - MathML 标签族：rehypeKatex 的 MathML 输出
// - className 全局放行：GFM 表格对齐 / highlight / katex 均依赖 class
// - img: src/srcset/sizes（Matrix 图片按需内联）
// - a: target/rel（外链新窗口）
import { defaultSchema } from 'hast-util-sanitize';
import type { Options as SanitizeOptions } from 'rehype-sanitize';

const MATHML_TAGS = [
  'math',
  'semantics',
  'annotation',
  'annotation-xml',
  'mrow',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'mroot',
  'msqrt',
  'mstyle',
  'merror',
  'mphantom',
  'munder',
  'mover',
  'munderover',
  'mmultiscripts',
  'mtable',
  'mtr',
  'mtd',
];

export const chatMarkdownSchema: SanitizeOptions = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...MATHML_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className'],
    a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
    img: [...(defaultSchema.attributes?.img ?? []), 'srcSet', 'sizes'],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className'],
    input: [...(defaultSchema.attributes?.input ?? []), 'checked', 'disabled', 'type'],
  },
  // Matrix 房间链接与既有白名单协议；javascript:/data: 等仍被拒绝。
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'matrix', 'mxc'],
  },
};
