// What an asset setting wants and a check of what was chosen. Kept apart from App.tsx so it can be tested without a browser.
export type AssetKind = 'font' | 'svg' | 'image' | 'file'
export const ASSET_ACCEPT: Record<AssetKind, string> = { font: '.ttf,.otf,.woff,.woff2', svg: '.svg,image/svg+xml', image: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', file: '' }
/** What an asset setting wants, from its manifest: `widget: font` or `accept: ['font']` is a font, only SVG is a drawing, any other picture type a picture, else any file. */
export const assetKind = (d: { widget?: string; accept?: string[] | string }): AssetKind => {
  const acc = (Array.isArray(d.accept) ? d.accept : d.accept ? [d.accept] : []).map(x => x.toLowerCase())
  if (d.widget === 'font' || acc.includes('font')) return 'font'
  if (acc.length > 0 && acc.every(x => x === 'image/svg+xml')) return 'svg'
  if (acc.some(x => x.startsWith('image/'))) return 'image'
  return acc.length === 0 && d.widget !== 'gallery' ? 'font' : 'file'
}
/** PNG, JPEG or WebP, by its first bytes. */
export const isPicture = (b: Uint8Array): boolean => (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
