export function slug(s: string): string
export function inline(text: string, pages?: Record<string, string>): string
export function renderMarkdown(md: string, pages?: Record<string, string>): { html: string; toc: Array<{ level: number; id: string; text: string }> }
export function extractQuickPrompt(md: string): string | null
export function extractQuickPromptNoNpm(md: string): string | null
export function pageHtml(o: { title: string; body: string; toc: Array<{ level: number; id: string; text: string }>; backHref?: string; lang?: string; note?: string; actions?: Array<{ label: string; href: string; download?: boolean }> }): string
