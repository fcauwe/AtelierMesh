import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractQuickPrompt, extractQuickPromptNoNpm, inline, pageHtml, renderMarkdown, slug } from '../tools/docs.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('the markdown renderer for the plugin guide pages', () => {
  it('renders headings with anchors, a contents list, lists, code blocks, tables and links', () => {
    const md = ['# Title', '', 'Intro with `code`, **bold**, *italic* and [a link](https://example.com/x?a=1&b=2).', '', '## First part', '', '- one', '- two', '  - nested', '', '1. a', '2. b', '', '```ts', 'const a = 1 < 2 && "x"', '```', '', '| h1 | h2 |', '|---|---|', '| c1 | `c2` |', '', '### Sub', '', '> a quote', '', '---'].join('\n')
    const { html, toc } = renderMarkdown(md)
    expect(html).toContain('<h1 id="title">Title</h1>')
    expect(html).toContain('<h2 id="first-part">First part</h2>')
    expect(toc).toEqual([{ level: 2, id: 'first-part', text: 'First part' }, { level: 3, id: 'sub', text: 'Sub' }])
    expect(html).toContain('<code>code</code>'); expect(html).toContain('<strong>bold</strong>'); expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">a link</a>')
    expect(html).toMatch(/<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/)
    expect(html).toContain('<ol><li>a</li><li>b</li></ol>')
    expect(html).toContain('<pre><code class="lang-ts">const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;</code></pre>')
    expect(html).toContain('<table>'); expect(html).toContain('<th>h1</th>'); expect(html).toContain('<td><code>c2</code></td>')
    expect(html).toContain('<blockquote>'); expect(html).toContain('<hr>')
  })
  it('escapes everything: no raw html, no script, no javascript: links, no handlers', () => {
    const evil = ['<script>alert(1)</script>', '', '<img src=x onerror=alert(1)>', '', '[click](javascript:alert(1))', '', '[data](data:text/html;base64,AAAA)', '', '`<b>x</b>`', '', '# <u>head</u>', '', '| <i>h</i> | b |', '|---|---|', '| <s>c</s> | d |'].join('\n')
    const { html } = renderMarkdown(evil)
    expect(html).not.toMatch(/<script|<img|<u>|<i>|<s>|<b>/)
    expect(html).not.toMatch(/href="javascript:|href="data:/i)
    expect(html).toContain('&lt;script&gt;')
    expect(inline('[x](javascript:alert(1))')).not.toContain('href')
  })
  it('turns links to our own docs into page links and other repository files into plain words', () => {
    const pages = { 'prompt-make-a-plugin.md': 'prompt-make-a-plugin.html' }
    expect(inline('[the prompt](prompt-make-a-plugin.md#the-quick-prompt)', pages)).toContain('href="prompt-make-a-plugin.html#the-quick-prompt"')
    const other = inline('[the spec](../SPEC.md)', pages)
    expect(other).not.toContain('<a '); expect(other).toContain('the spec')
    expect(inline('[up](#Some-Heading)')).toContain('href="#some-heading"')
    expect(slug('7. Performance and the triangle budget')).toBe('7-performance-and-the-triangle-budget')
  })
  it('makes a whole page with the table of contents, the way back and the theme', () => {
    const { html, toc } = renderMarkdown('# T\n\n## A\n\ntext')
    const page = pageHtml({ title: 'Guide', body: html, toc, backHref: '../' })
    expect(page).toContain('<title>Guide · AtelierMesh</title>'); expect(page).toContain('aria-label="Contents"'); expect(page).toContain('Back to AtelierMesh')
    expect(page).toContain('../theme.css'); expect(page).toContain('prefers-color-scheme')
  })
  it('renders the real guide and prompt without losing a heading', () => {
    for (const f of ['plugin-guide.md', 'prompt-make-a-plugin.md']) {
      const md = fs.readFileSync(path.join(repo, 'docs', f), 'utf8')
      const { html, toc } = renderMarkdown(md)
      const inFences = md.split(/^```.*$/m).filter((_, i) => i % 2 === 0).join('\n')
      const headings = inFences.split('\n').filter(l => /^#{2,3}\s/.test(l)).length
      expect(toc.length).toBe(headings)
      expect(html).not.toMatch(/<script/i)
      expect((html.match(/<pre>/g) ?? []).length).toBe((md.match(/^```/gm) ?? []).length / 2)   // every fenced block became one <pre>
    }
  })
})

describe('the quick prompt of the app', () => {
  it('is the fenced block under "The quick prompt" in docs/prompt-make-a-plugin.md, and nothing else', () => {
    const md = fs.readFileSync(path.join(repo, 'docs/prompt-make-a-plugin.md'), 'utf8')
    const q = extractQuickPrompt(md)!
    expect(q.startsWith('Build an AtelierMesh plugin:')).toBe(true)
    expect(q.split('\n').length).toBeLessThanOrEqual(12)
    expect(q).not.toContain('```')
    expect(extractQuickPrompt('# nothing here')).toBeNull()
    expect(extractQuickPrompt('## The quick prompt\n\ntext without a block\n\n## Next\n\n```\nx\n```')).toBeNull()
  })
  it('has a separate no-npm quick prompt that sends the agent to the no-npm files, and no customer questions', () => {
    const md = fs.readFileSync(path.join(repo, 'docs/prompt-make-a-plugin.md'), 'utf8')
    const a = extractQuickPrompt(md)!, b = extractQuickPromptNoNpm(md)!
    expect(b).not.toBe(a)
    expect(a).not.toContain('NO npm')
    for (const want of ['NO npm', 'docs/NO-NPM.md', 'mirror-plain', 'README-START-HERE.md', 'plain object']) expect(b).toContain(want)
    expect(b.split('\n').length).toBeLessThanOrEqual(12)
    expect(b).not.toContain('```')
    expect(`${a}\n${b}`).not.toMatch(/customer/i)
    expect(extractQuickPromptNoNpm('## The quick prompt\n\n```\nx\n```')).toBeNull()
  })
})

describe('the page header can carry buttons (the plugin kit download)', () => {
  it('writes a download link and escapes its label', async () => {
    const { pageHtml } = await import('../tools/docs.mjs')
    const html = pageHtml({ title: 'T', body: '<p>x</p>', toc: [], actions: [{ label: 'Download <the> kit', href: 'kit.zip', download: true }] })
    expect(html).toContain('href="kit.zip" download>Download &lt;the&gt; kit</a>')
    expect(pageHtml({ title: 'T', body: '', toc: [] })).not.toContain('class="actions"')
  })
})
