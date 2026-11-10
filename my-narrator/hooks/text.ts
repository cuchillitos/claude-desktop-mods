// What the narrator says, as text a synthesizer reads well, and the language it is in.

// The first line of the narrator's reply: the language's code alone, maybe quoted or bracketed.
const LANGUAGE_LINE = /^\s*\W*([a-z]{2,3})(?:[-_][a-z0-9]{2,8})?\W*\s*\n([\s\S]*)$/i
// Common words, to tell the language of a text no model narrated.
const WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'to', 'of', 'it', 'you', 'that', 'with', 'for', 'this', 'are'],
  es: ['el', 'la', 'que', 'de', 'y', 'en', 'los', 'las', 'es', 'para', 'por', 'una', 'del', 'he'],
  pt: ['o', 'que', 'não', 'em', 'um', 'uma', 'os', 'você', 'está', 'do', 'da', 'foi'],
  fr: ['le', 'la', 'les', 'et', 'est', 'des', 'une', 'pour', 'que', 'dans', 'vous', 'pas'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'mit', 'für', 'sie', 'den', 'ein'],
  it: ['il', 'che', 'di', 'è', 'per', 'una', 'con', 'non', 'sono', 'gli', 'della', 'ho']
}

// A commit's hash, which a synthesizer reads letter by letter: hex digits, a number and a letter among them.
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g
const EXTENSION = /(.)(?:\.[a-z][a-z0-9]{0,4})+$/i

/** How a person names a file or folder: by its last part, without the extension (`hooks/register.tsx`: register). */
const fileName = (path: string) => (path.split(/[\\/]/).filter(Boolean).pop() ?? '').replace(EXTENSION, '$1')

/** Whether a word with a slash in it is a path, not `and/or` or a date: from the root, home or here, or with an extension or two slashes, its last part a name. */
const isPath = (word: string) =>
  /[a-z]/i.test(fileName(word)) && (/^(?:~|\.{1,2})?\//.test(word) || EXTENSION.test(word) || word.split('/').length > 2)

/** `text` cut to `size` characters, at a sentence's end when there is one in its second half. */
export function cut (text: string, size: number) {
  if (text.length <= size) return text
  const head = text.slice(0, size)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  return end > size / 2 ? head.slice(0, end + 1) : `${head.trimEnd()}…`
}

/**
 * Markdown as a synthesizer should read it: no code blocks, marks, links' addresses or bullets, a
 * path said by its file's name, and no hashes.
 */
export function plain (markdown: string) {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    // Code that is a path or a file is said by its name; any other, as it is.
    .replace(/`([^`]*)`/g, (code, inside: string) => (/^[^\s/\\]*([/\\][^\s/\\]*)+$|^[\w-]+\.[a-z][a-z0-9]{0,4}$/i.test(inside) ? fileName(inside) : inside))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+•]|\d+[.)]|>)\s+/gm, '')
    .replace(/[\w.@~-]*\/[\w.@~/-]*[\w@~/-]/g, word => (isPath(word) ? fileName(word) : word))
    .replace(HASH, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[*_~|#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .replace(/^[\s-]+/, '')
    .trim()
}

/** The language of `text` by its most common words, or '' when too few say. */
export function guessLanguage (text: string) {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  let best = ''
  let most = 2
  for (const [language, common] of Object.entries(WORDS)) {
    const count = words.filter(word => common.includes(word)).length
    if (count > most) [best, most] = [language, count]
  }
  return best
}

/** The narrator's reply as its language and what to say; a reply without the code line is guessed. */
export function parseNarration (reply: string) {
  const found = LANGUAGE_LINE.exec(reply.trim() + '\n')
  const text = plain(found ? found[2]! : reply)
  return { language: found ? found[1]!.toLowerCase() : guessLanguage(text), text }
}
