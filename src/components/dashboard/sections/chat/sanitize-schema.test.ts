import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import { chatMarkdownSchema } from './sanitize-schema';

// 与 markdown-message.tsx 相同的插件链（组件层除外），验证 SEC-04 净化属性。
// 注意：rehypeKatex 与生产一致，排在 sanitize 之后（可信插件输出不再清洗）。
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, chatMarkdownSchema)
  .use(rehypeKatex)
  .use(rehypeStringify);

async function render(md: string): Promise<string> {
  return String(await processor.process(md));
}

/** 把输出 HTML 解析回 DOM，收集全部元素的属性名（贴近浏览器真实安全语义）。 */
function collectAttrNames(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const names: string[] = [];
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) names.push(attr.name.toLowerCase());
  }
  return names;
}

function collectTagNames(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.body.querySelectorAll('*')).map((el) => el.tagName.toLowerCase());
}

// 事件属性：on* 家族 + style（默认 schema 已拒，此处固化）
const EVENT_ATTR = fc.constantFrom(
  'onerror',
  'onload',
  'onclick',
  'onmouseover',
  'onfocus',
  'onanimationstart',
);
const DANGEROUS_TAG = fc.constantFrom('script', 'iframe', 'object', 'embed', 'form', 'link');
const JS_PAYLOAD = fc.constantFrom('alert(1)', 'void(0)', 'top');

// 恶意载荷注入器：把脚本向量塞进合法 Markdown 骨架的任意位置
// （payload 不含引号，保证生成的是结构合法的恶意 HTML）。
const maliciousHtml = fc
  .tuple(
    fc.constantFrom(
      (t: string, a: string, p: string) => `<${t} ${a}="${p}">x</${t}>`,
      (t: string, a: string, p: string) => `<img src="x" ${a}="${p}">`,
      (t: string, a: string, p: string) => `text <div ${a}="${p}">d</div> tail`,
    ),
    DANGEROUS_TAG,
    EVENT_ATTR,
    JS_PAYLOAD,
  )
  .map(([tpl, tag, attr, payload]) => tpl(tag, attr, payload));

describe('sanitize-schema 属性测试（SEC-04）', () => {
  it(
    'P1: 任意注入位置的事件属性均不出现在净化 DOM 中（属性全量拒绝）',
    async () => {
      await fc.assert(
        fc.asyncProperty(maliciousHtml, async (html) => {
          const out = await render(html);
          const attrNames = collectAttrNames(out);
          const dangerous = attrNames.filter((n) => n.startsWith('on'));
          expect(dangerous).toEqual([]);
        }),
        { numRuns: 200 },
      );
    },
    30_000,
  );

  it(
    'P2: 任意注入位置的 script/iframe/object/embed/form 标签均被移除',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(maliciousHtml, DANGEROUS_TAG).map(([html]) => html),
          async (html) => {
            const out = await render(html);
            const tags = collectTagNames(out);
            const dangerous = tags.filter((t) =>
              ['script', 'iframe', 'object', 'embed', 'form'].includes(t),
            );
            expect(dangerous).toEqual([]);
          },
        ),
        { numRuns: 200 },
      );
    },
    30_000,
  );

  it(
    'P3: javascript:/data: URL 在链接与图片中均被拒绝',
    async () => {
      const schemes = fc.constantFrom('javascript:', 'data:text/html;base64,', 'vbscript:');
      const injection = fc
        .tuple(schemes, fc.constantFrom('alert(1)', 'PHNjcmlwdD4='), fc.constantFrom('a', 'img'))
        .map(([scheme, payload, tag]) =>
          tag === 'a'
            ? `[click](${scheme}${payload})`
            : `![x](${scheme}${payload})`,
        );
      await fc.assert(
        fc.asyncProperty(injection, async (md) => {
          const out = await render(md);
          expect(out).not.toMatch(/(href|src)\s*=\s*["']?(javascript|vbscript|data:text\/html)/i);
        }),
        { numRuns: 200 },
      );
    },
    30_000,
  );

  // 固化单元用例：已知绕过尝试 + 良性内容不误杀
  it('已知绕过样例被净化', async () => {
    const cases = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<a href="javascript:alert(1)">x</a>',
      '<math><mtext></mtext><script>alert(1)</script></math>',
      '<details open ontoggle=alert(1)>',
      '<style>@import url("//evil");</style>',
    ];
    for (const html of cases) {
      const out = await render(html);
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/\son[a-z]+\s*=/i);
      expect(out).not.toMatch(/javascript:/i);
    }
  });

  it('良性内容不误杀：GFM 表格对齐、代码块语言、MathML、图片', async () => {
    const benign = [
      '| a | b |\n| :- | -: |\n| 1 | 2 |',
      '```js\nconsole.log("hi")\n```',
      '$$\\frac{1}{2}$$',
      '![pic](https://matrix.example/_matrix/media/r0/download/x/y)',
      '[room](https://matrix.to/#/#room:example.org)',
      '- [x] done task',
    ];
    for (const md of benign) {
      const out = await render(md);
      expect(out.length).toBeGreaterThan(0);
    }
    const katexOut = await render('$$\\frac{1}{2}$$');
    expect(katexOut).toMatch(/class="katex/);
    const tableOut = await render('| a | b |\n| :- | -: |\n| 1 | 2 |');
    expect(tableOut).toMatch(/align|text-align/);
  });
});
