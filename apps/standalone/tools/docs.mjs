// Turns the plugin guide and the agent prompt (markdown in docs/) into static, styled pages for the standalone app, and pulls the quick prompt out of the
// prompt file so the app can offer it with a "Copy" button without a second hand-written copy. No dependencies. Everything that comes from the markdown
// is escaped: the pages contain only the tags this file writes, and a link is only kept when it is http(s), a page of ours or an anchor.

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const slug = s => String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-') || 'section'

/** Inline markdown: code, bold, italic, links. `pages` maps a markdown file name to the html file it became. */
export function inline(text, pages = {}) {
  const codes = []
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\uE000${codes.length - 1}\uE000` })
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const raw = href.replace(/&amp;/g, '&')
    if (/^https?:\/\//i.test(raw)) return `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    if (raw.startsWith('#')) return `<a href="#${esc(slug(raw.slice(1)))}">${label}</a>`
    const file = raw.split('#')[0].split('/').pop() ?? ''
    if (pages[file]) return `<a href="${esc(pages[file])}${raw.includes('#') ? '#' + esc(slug(raw.split('#')[1] ?? '')) : ''}">${label}</a>`
    return `<span class="ref">${label}</span>`   // a file that is not part of the app: the words stay, the link does not
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`)
}

/** Markdown to { html, toc }: headings with anchors, paragraphs, lists (one level of nesting), fenced code, tables, quotes, rules. */
export function renderMarkdown(md, pages = {}) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  const out = [], toc = [], used = new Map()
  const anchor = t => { const base = slug(t); const n = (used.get(base) ?? 0) + 1; used.set(base, n); return n > 1 ? `${base}-${n}` : base }
  let i = 0
  const isBlockStart = l => /^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|\|.*\||---+\s*$)/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i++; continue }
    let m
    if ((m = /^```(\S*)\s*$/.exec(line))) {
      const body = []; i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre><code${m[1] ? ` class="lang-${esc(m[1])}"` : ''}>${esc(body.join('\n'))}</code></pre>`)
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      const level = m[1].length, id = anchor(m[2])
      if (level >= 2 && level <= 3) toc.push({ level, id, text: m[2].replace(/[`*_]/g, '') })
      out.push(`<h${level} id="${id}">${inline(m[2], pages)}</h${level}>`); i++
    } else if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++ }
    else if (/^>\s?/.test(line)) {
      const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(q.join('\n'), pages).html}</blockquote>`)
    } else if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const head = cells(line); i += 2
      const rows = []; while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map(c => `<th>${inline(c, pages)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, pages)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = []
      const kind = /^\s*\d+\./.test(line) ? 'ol' : 'ul'
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s+\S/.test(lines[i]) && items.length > 0))) {
        const l = lines[i]
        const mm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l)
        if (mm && mm[1].length < 2) items.push({ text: mm[3], sub: [] })
        else if (mm) items[items.length - 1].sub.push(mm[3])
        else items[items.length - 1].text += ' ' + l.trim()
        i++
      }
      out.push(`<${kind}>${items.map(it => `<li>${inline(it.text, pages)}${it.sub.length ? `<ul>${it.sub.map(s => `<li>${inline(s, pages)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${kind}>`)
    } else {
      const p = [line]; i++
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) p.push(lines[i++])
      out.push(`<p>${inline(p.join(' '), pages)}</p>`)
    }
  }
  return { html: out.join('\n'), toc }
}

/** The first fenced block under the first heading that matches `heading`. */
function fencedUnder(md, heading) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  const h = lines.findIndex(l => heading.test(l))
  if (h < 0) return null
  let i = h + 1
  while (i < lines.length && !/^```/.test(lines[i])) { if (/^#{1,6}\s/.test(lines[i])) return null; i++ }
  if (i >= lines.length) return null
  const body = []; i++
  while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
  return body.join('\n')
}

/** The first fenced block under the heading "The quick prompt" (the one for people who have npm). */
export function extractQuickPrompt(md) { return fencedUnder(md, /^#{1,6}\s+The quick prompt(?!\s+without npm)/i) }

/** The first fenced block under the heading "The quick prompt without npm". */
export function extractQuickPromptNoNpm(md) { return fencedUnder(md, /^#{1,6}\s+The quick prompt without npm/i) }

/** A whole page: the app's design tokens and theme, a table of contents, a way back. `backHref` points at the app. */
export function pageHtml({ title, body, toc, backHref = '../', lang = 'en', note = '', actions = [] }) {
  const nav = toc.length ? `<nav class="toc" aria-label="Contents"><h2>Contents</h2><ul>${toc.map(t => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : ''
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AtelierMesh</title>
<link rel="icon" href="../brand/ateliermesh-favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../theme.css">
<style>
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg-page, #f3f4f6); color: var(--fg-default, #1f2937); font: 16px/1.6 var(--font-sans, system-ui, sans-serif); }
header.bar { background: var(--bg-dark, #1a1a1a); color: #fff; display: flex; align-items: center; gap: 12px; padding: 8px 16px; position: sticky; top: 0; z-index: 2; }
header.bar a { color: #fff; text-decoration: none; display: inline-flex; align-items: center; gap: 10px; min-height: 44px; font-weight: 800; letter-spacing: -.03em; }
header.bar img { width: 28px; height: 28px; }
header.bar .back { margin-left: auto; font-weight: 600; letter-spacing: 0; border: 1px solid rgba(255,255,255,.4); border-radius: 8px; padding: 0 14px; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 32px; }
.toc { position: sticky; top: 72px; align-self: start; max-height: calc(100vh - 96px); overflow: auto; font-size: 14px; }
.toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-muted, #6b7280); margin: 0 0 8px; }
.toc ul { list-style: none; margin: 0; padding: 0; } .toc li { margin: 2px 0; } .toc li.l3 { padding-left: 14px; }
.toc a { color: var(--fg-default, #1f2937); text-decoration: none; display: block; padding: 4px 0; } .toc a:hover { color: var(--brand-action, #c2410c); text-decoration: underline; }
main { min-width: 0; background: var(--bg-surface, #fff); border: 1px solid var(--border-default, #e5e7eb); border-radius: 16px; padding: 8px 28px 32px; }
main h1 { font-size: 30px; line-height: 1.2; letter-spacing: -.02em; color: var(--fg-strong, #111827); }
main h2 { font-size: 22px; margin-top: 2em; color: var(--fg-strong, #111827); } main h3 { font-size: 17px; margin-top: 1.6em; color: var(--fg-strong, #111827); }
main h2, main h3, main h4 { scroll-margin-top: 72px; }
main a { color: var(--brand-action, #c2410c); } main a:hover { text-decoration: none; }
main .ref { border-bottom: 1px dotted var(--border-control, #a3a3a3); }
code { font: 0.9em var(--font-mono, ui-monospace, monospace); background: var(--bg-surface-2, #fafaf9); border: 1px solid var(--border-default, #e5e7eb); border-radius: 4px; padding: 1px 5px; }
pre { background: var(--bg-surface-2, #fafaf9); border: 1px solid var(--border-default, #e5e7eb); border-radius: 10px; padding: 14px 16px; overflow: auto; line-height: 1.45; }
pre code { background: none; border: 0; padding: 0; font-size: 13.5px; }
.tablewrap { overflow-x: auto; } table { border-collapse: collapse; font-size: 14px; min-width: 60%; }
th, td { border-bottom: 1px solid var(--border-default, #e5e7eb); padding: 8px 10px; text-align: left; vertical-align: top; } th { color: var(--fg-muted, #6b7280); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
blockquote { margin: 1em 0; padding: 4px 16px; border-left: 4px solid var(--brand-500, #f97316); background: var(--bg-surface-2, #fafaf9); border-radius: 0 8px 8px 0; }
hr { border: 0; border-top: 1px solid var(--border-default, #e5e7eb); margin: 2em 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; } .actions .btn { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--border-control, #a3a3a3); background: var(--brand-action, #c2410c); color: var(--on-brand, #fff) !important; font-weight: 700; text-decoration: none; }
.note { background: var(--status-info-soft, rgba(99,102,241,.07)); border: 1px solid var(--border-default, #e5e7eb); border-radius: 10px; padding: 10px 14px; font-size: 14px; margin: 16px 0; }
:focus-visible { outline: 3px solid var(--status-info, #6366f1); outline-offset: 2px; }
@media (max-width: 860px) { .wrap { grid-template-columns: 1fr; } .toc { position: static; max-height: none; } main { padding: 4px 16px 24px; } }
</style>
<script>try{var m=localStorage.getItem('am.theme');if(m==='dark'||m==='light')document.documentElement.dataset.theme=m;else document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){}</script>
</head>
<body>
<header class="bar"><a href="${esc(backHref)}"><img src="../brand/ateliermesh-mark-white.svg" alt="" width="28" height="28">AtelierMesh</a><a class="back" href="${esc(backHref)}">Back to AtelierMesh</a></header>
<div class="wrap">
${nav}
<main id="content">
${note ? `<p class="note">${esc(note)}</p>` : ''}
${actions.length ? `<p class="actions">${actions.map(a => `<a class="btn" href="${esc(a.href)}"${a.download ? ' download' : ''}>${esc(a.label)}</a>`).join(' ')}</p>` : ''}
${body}
</main>
</div>
</body>
</html>
`
}
