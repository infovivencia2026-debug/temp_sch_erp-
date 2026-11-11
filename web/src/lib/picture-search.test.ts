import { describe, expect, it } from 'vitest'
import { isLibraryPictureUrl, pictureKeywords } from '@shared/picture-search'

describe('pictureKeywords', () => {
  it('keeps the last key words and drops stop words', () => {
    expect(pictureKeywords('Which fruit is red? apple')).toBe('fruit red apple')
    expect(pictureKeywords('Write the name of the following.')).toBe('')
    expect(pictureKeywords('Q1. Draw a picture of a leaf (2 marks)')).toBe('leaf')
    expect(pictureKeywords('apple apple APPLE')).toBe('apple')
  })
  it('drops numbers and short words, keeps Indian scripts', () => {
    expect(pictureKeywords('5 + 3 = 8')).toBe('')
    expect(pictureKeywords('ఆపిల్ పండు')).toBe('ఆపిల్ పండు')
    expect(pictureKeywords('सेब')).toBe('सेब')
  })
  it('stays within 60 characters', () => {
    expect(pictureKeywords('photosynthesisphotosynthesis chlorophyllchlorophyllchlorophyll mitochondriamitochondria').length).toBeLessThanOrEqual(60)
  })
})

describe('isLibraryPictureUrl', () => {
  it('allows the libraries own picture paths', () => {
    expect(isLibraryPictureUrl('https://api.openverse.org/v1/images/abe939b0-9741-4d30-b63e-19b08b3baf71/thumb/')).toBe(true)
    expect(isLibraryPictureUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/Red_apple.svg/330px-Red_apple.svg.png')).toBe(true)
  })
  it('refuses everything else', () => {
    for (const u of [
      'http://upload.wikimedia.org/wikipedia/commons/a.png',
      'https://upload.wikimedia.org.evil.com/wikipedia/commons/a.png',
      'https://evil.com/wikipedia/commons/a.png',
      'https://upload.wikimedia.org/wikipedia/en/a.png',
      'https://upload.wikimedia.org/wikipedia/commons/a.png?x=1',
      'https://upload.wikimedia.org:8443/wikipedia/commons/a.png',
      'https://user@upload.wikimedia.org/wikipedia/commons/a.png',
      'https://api.openverse.org/v1/images/?q=apple',
      'https://api.openverse.org/v1/images/abe939b0-9741-4d30-b63e-19b08b3baf71/',
      'not a url', '',
    ]) expect(isLibraryPictureUrl(u)).toBe(false)
  })
})
