/* Picture suggestions in the Question maker: the parts both sides share.

   The browser takes the key words of the paragraph being typed and asks the
   Worker; the Worker asks a free, openly licensed picture library. Only these
   few words ever leave the school, never the rest of the paper. The Worker
   fetches pictures only from the libraries' own hosts (no open proxy). */

const STOP = new Set(`a an the and or but if then than so of to in on at by for from with without into onto over under up down out off
is am are was were be been being do does did done have has had having can could will would shall should may might must
i me my we our you your he him his she her it its they them their this that these those there here who whom whose which what
when where why how not no yes very too also just only all any both each few more most other some such own same
write name choose select pick tick mark find fill blank blanks correct answer answers question questions following given below above
draw picture pictures identify colour color circle match one two three four five six seven eight nine ten
give explain describe define state list example examples see look read say tell use using used like
q ans marks mark eg ie etc`.split(/\s+/))

const MAX_WORDS = 3
export const MAX_QUERY = 60

/** The key words of a sentence, for a picture search: no stop words, no numbers, at most 3 words and 60 characters. */
export function pictureKeywords(text: string): string {
  const words = (text.toLowerCase().normalize('NFC').match(/[\p{L}\p{M}]+/gu) ?? [])
    .filter((w) => !STOP.has(w) && (w.length >= 3 || /[^\x00-\x7f]/.test(w)))
  const seen: string[] = []
  // The last words of a question are usually the thing to picture ("... apple").
  for (let i = words.length - 1; i >= 0 && seen.length < MAX_WORDS; i--) if (!seen.includes(words[i])) seen.unshift(words[i])
  let q = seen.join(' ')
  while (q.length > MAX_QUERY) q = q.split(' ').slice(1).join(' ')
  return q
}

/** The picture kinds a teacher can ask for. */
export type PictureKind = 'clipart' | 'photo'

/** One suggestion, as the Worker returns it. `thumb` and `full` are library URLs, fetched through the Worker. */
export interface PictureHit {
  thumb: string
  full: string
  title: string
  creator: string
  licence: string
  source: string
}

const OPENVERSE_THUMB = /^\/v1\/images\/[0-9a-f-]{36}\/thumb\/$/
const COMMONS = /^\/wikipedia\/commons\/[\w%().,~!'*+-]+(\/[\w%().,~!'*+-]+)*$/

/** True only for a picture on a library's own host, over https, with nothing unexpected in it. */
export function isLibraryPictureUrl(u: string): boolean {
  let url: URL
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false
  if (url.hostname === 'api.openverse.org') return OPENVERSE_THUMB.test(url.pathname)
  if (url.hostname === 'upload.wikimedia.org') return COMMONS.test(url.pathname) && !url.pathname.includes('..')
  return false
}
