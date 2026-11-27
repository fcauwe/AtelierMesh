import { describe, expect, it } from 'vitest'
import { LATEST_NEWS, NEWS, newsKey, unseenNews } from '../src/news'
import { welcomeMode } from '../src/Welcome'
import en from '../src/locales/en.json'
import nl from '../src/locales/nl.json'
import fr from '../src/locales/fr.json'

const base = { query: null, webdriver: false, welcomed: null, newsSeen: null }

describe('what the welcome popup shows', () => {
  it('shows the whole welcome to a first-time visitor', () => {
    expect(welcomeMode(base)).toBe('welcome')
  })
  it('shows only the news to a visitor who has seen the welcome but not the latest news, once', () => {
    expect(welcomeMode({ ...base, welcomed: '1' })).toBe('news')                          // from before there was news
    expect(welcomeMode({ ...base, welcomed: '1', newsSeen: '0.2.4' })).toBe('news')
    expect(welcomeMode({ ...base, welcomed: '1', newsSeen: LATEST_NEWS })).toBeNull()
  })
  it('shows nothing in an automated browser or with ?welcome=0, and ?welcome=1 or =news force it', () => {
    expect(welcomeMode({ ...base, webdriver: true })).toBeNull()
    expect(welcomeMode({ ...base, query: '0' })).toBeNull()
    expect(welcomeMode({ ...base, query: '1', webdriver: true, welcomed: '1', newsSeen: LATEST_NEWS })).toBe('welcome')
    expect(welcomeMode({ ...base, query: 'news', webdriver: true, welcomed: '1', newsSeen: LATEST_NEWS })).toBe('news')
  })
})

describe('the news list', () => {
  it('is newest first, with one entry per version', () => {
    const versions = NEWS.map(e => e.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect(unseenNews(null).map(e => e.version)).toEqual([LATEST_NEWS])
  })
  it('gives a visitor what is newer than what they have seen, and nothing once they are up to date', () => {
    expect(unseenNews('0.0.1').map(e => e.version)).toEqual(NEWS.map(e => e.version))
    expect(unseenNews(LATEST_NEWS)).toEqual([])
    expect(unseenNews('99.0.0')).toEqual([])
  })
  it('has the text of every item in every language, under welcome.news.v<version>', () => {
    expect(newsKey('1.2.0', 'x')).toBe('welcome.news.v1_2_0.x')
    for (const [lang, d] of [['en', en], ['nl', nl], ['fr', fr]] as const) {
      const w = (d as unknown as { welcome: Record<string, unknown> }).welcome
      for (const k of ['newTitle', 'newIn', 'newsOnlyTitle', 'gotIt']) expect(typeof w[k], `${lang} welcome.${k}`).toBe('string')
      for (const e of NEWS) for (const item of e.items) {
        const text = newsKey(e.version, item).split('.').slice(1).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], w)
        expect(typeof text, `${lang} ${newsKey(e.version, item)}`).toBe('string')
      }
    }
  })
})
