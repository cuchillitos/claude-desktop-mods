import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import { LINUX, MACOS, MACOS_VOICES, QUEUE, WINDOWS, WINDOWS_VOICES, dispatcherRate, espeakWords, powershell } from './speaker'
import { cut, guessLanguage, parseNarration, plain } from './text'

type Platform = 'macos' | 'windows' | 'linux' | 'other'
/** A program that speaks, and what it is told through its environment. */
type Command = { argv: string[]; env: Record<string, string>; program: string; isFallback?: boolean }
/** How a speaker spoke: the voice it used, and whether that is not the one asked for (none matched); or that the line dropped it. */
type Spoke = { voice: string; isFallback: boolean; isSkipped?: boolean }
/**
 * One narration: the model call that writes it, then the program that speaks it, until silenced;
 * once that speaks, how many narrations of other windows wait their turn behind it.
 */
type Narration = { isActive: boolean; abort: AbortController; isSpeaking?: boolean; waiting?: number }
/** The synthesizer found on Linux, the languages it has voices for and their names, lowercased (empty: it did not say). */
type LinuxSpeech = { tool?: 'spd-say' | 'espeak-ng' | 'espeak'; languages: Set<string>; names: Set<string> }

const SWEEP_MS = 100
// A little quicker than the voice's normal pace, unless the settings say otherwise.
const SPEED = 1.3
const MAX_ACTIONS = 40
const PREVIEW = 'Hello! This is a voice preview for Narrator.'
// The tool inputs that say best what a call did, in order of preference.
const DETAILS = ['description', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'command', 'prompt']
const LANGUAGE_CODE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i

/** The English name of a language code, or undefined where the runtime's language data does not know it. */
function languageName (code: string) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code)
  } catch {
    return undefined
  }
}

/** The language the narrator is told to speak: the one set, else the one the user wrote in. */
function spoken (language: string) {
  if (!language) return "Speak the language the user wrote the request in (English, French or Spanish: never mix them, and do not translate); if that is unclear, the language of Claude's final message."
  return `Always speak ${languageName(language) ?? language} (${language}), whatever language the request or Claude's final message is in.`
}

const NARRATOR = (language: string) => `You are the voice of Claude Code, a coding assistant. After each of its turns you read the user a spoken summary of Claude's final message, speaking as Claude in the first person.

You get Claude's final message, plus for context the user's request and the actions Claude took. Summarize what Claude's message tells the user: what it found, what it did and how it turned out, where the work stands, and anything the user has to do or decide next. Summarize Claude's message, never the user's request: do not repeat back what the user asked.

${spoken(language)}

Rules:
- A speech synthesizer reads it aloud: plain sentences only. No markdown, lists, emojis or code, and no file paths, URLs, hashes or version strings read out character by character: name files and commands the way a person says them ("the register file", "the tests").
- Under 100 words, and as short as the message allows: a one-line answer gets a one-line summary. Keep only the essentials of a long message, in the order they matter, and drop detail, examples and caveats.
- No preamble ("Sure", "In summary"), no questions back, nothing Claude did not say or do.

Reply in exactly this form: the first line holds only the ISO 639-1 code of the language you speak (es, en, pt, fr...), and the narration starts on the second line.`

const enabled = atom({ plugin: 'my-narrator', key: 'isEnabled' } as const, false)
const speech = atom({ plugin: 'my-narrator', key: 'speech' } as const, null)
const sweepStep = atom({ plugin: 'my-narrator', key: 'sweepStep' } as const, 0)

/** An answer this short is read out as it is: no model call to write a narration of it. */
const SHORT_ANSWER = 0

let settings = { voice: '', model: 'haiku', speed: SPEED, shortAnswer: SHORT_ANSWER, language: '' }
// The main loop's turn so far: the prompt that started it and each tool call it made.
let request = ''
let actions: string[] = []
let current: Narration | undefined
let platform: Promise<Platform> | undefined
let wsl: Promise<boolean> | undefined
let linuxSpeech: Promise<LinuxSpeech> | undefined
let hasWarned = false
// The language the last narration was said in: a short answer whose words do not tell is read in it.
let spokenLanguage = ''
// The sweep across the switch, running while it speaks.
let sweep: Timer | undefined

/**
 * A language setting as its ISO 639 code (`es-MX` is `es`), checked against the language data the
 * runtime ships (`Intl.DisplayNames`), so a typo or any other text is not a language: empty, automatic.
 */
export function languageOf (value: unknown) {
  const code = String(value ?? '').trim()
  const language = LANGUAGE_CODE.test(code) ? code.split(/[-_]/)[0]!.toLowerCase() : ''
  return language && languageName(language) ? language : ''
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One tool call as a line the narrator reads: its tool, then the input that says most. */
function describe (e: object) {
  const input = e as Record<string, unknown>
  const detail = DETAILS.map(key => input[key]).find(value => typeof value === 'string' && value.trim() !== '')
  return detail === undefined ? String(input.tool) : `${String(input.tool)}: ${cut(String(detail).replace(/\s+/g, ' '), 200)}`
}

/** What the narrator is told about the turn. */
function brief (answer: string) {
  const did = actions.length > 0 ? actions.map(action => `- ${action}`).join('\n') : '(no tools: Claude only answered)'
  return [
    `The user's request:\n<request>\n${cut(request, 2000) || '(none: Claude went on by itself)'}\n</request>`,
    `What Claude did, in order:\n${did}`,
    `Claude's final message to the user:\n<message>\n${cut(answer, 6000)}\n</message>`
  ].join('\n\n')
}

/** The system the session runs on, asked once. */
function platformOf ($: EngineInterface) {
  platform ??= (async (): Promise<Platform> => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
    const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    return name === 'Darwin' ? 'macos' : name === 'Linux' ? 'linux' : 'other'
  })()
  return platform
}

/** Whether the session runs under WSL: Linux, on a Windows desktop whose voices are better. */
function wslOf ($: EngineInterface) {
  wsl ??= (async () => (await platformOf($)) === 'linux' && (await $.env.get('WSL_DISTRO_NAME')) !== undefined)()
  return wsl
}

/** The language codes listed in a synthesizer's voice table, by their main part (`es` for es-419). */
function languagesIn (table: string) {
  const languages = new Set<string>()
  for (const line of table.split('\n').slice(1)) {
    const code = line.trim().split(/\s+/).slice(1).find(word => LANGUAGE_CODE.test(word))
    if (code) languages.add(code.split(/[-_]/)[0]!.toLowerCase())
  }
  return languages
}

/** The voice names in `spd-say -L`'s table, lowercased: what comes before each row's language. */
function namesIn (table: string) {
  const names = new Set<string>()
  for (const line of table.split('\n').slice(1)) {
    const words = line.trim().split(/\s+/)
    const at = words.findIndex((word, i) => i > 0 && LANGUAGE_CODE.test(word))
    if (at > 0) names.add(words.slice(0, at).join(' ').toLowerCase())
  }
  return names
}

/** Which synthesizer Linux has, speech-dispatcher first, and its languages, asked once. */
function linuxSpeechOf ($: EngineInterface) {
  linuxSpeech ??= (async (): Promise<LinuxSpeech> => {
    const found = (await $.process.run(['sh', '-c', 'command -v spd-say espeak-ng espeak']).catch(() => undefined))?.stdout ?? ''
    const paths = found.split('\n').map(path => path.trim())
    const tool = (['spd-say', 'espeak-ng', 'espeak'] as const).find(name => paths.some(path => path.endsWith(`/${name}`)))
    if (!tool) return { languages: new Set(), names: new Set() }
    const listed = await $.process.run(tool === 'spd-say' ? ['spd-say', '-L'] : [tool, '--voices'], { timeoutMs: 5000 }).catch(() => undefined)
    const table = listed?.stdout ?? ''
    return { tool, languages: languagesIn(table), names: tool === 'spd-say' ? namesIn(table) : new Set() }
  })()
  return linuxSpeech
}

/** A speaker that first waits its turn in the line every window shares (PowerShell waits in its own). */
const inLine = (command: Command): Command => ({ ...command, argv: ['sh', '-c', QUEUE, 'narrator-line', ...command.argv] })

/** The programs that can say `text` here, best first; `ticket`, when it was ready, is its place in the line. */
async function speakersFor ($: EngineInterface, text: string, language: string, voice: string, ticket: string): Promise<Command[]> {
  const env = { NARRATOR_TEXT: text, NARRATOR_LANG: language, NARRATOR_VOICE: voice, NARRATOR_SPEED: String(settings.speed), NARRATOR_TICKET: ticket }
  const system = await platformOf($)
  if (system === 'macos') return [inLine({ argv: ['osascript', '-l', 'JavaScript', '-e', MACOS], env, program: 'osascript' })]
  if (system === 'windows') return [{ argv: powershell(WINDOWS), env, program: 'powershell' }]
  if (system !== 'linux') return []

  const speakers: Command[] = []
  if (await wslOf($)) {
    const inherited = await $.env.get('WSLENV')
    const crossing = [inherited, 'NARRATOR_TEXT/u', 'NARRATOR_LANG/u', 'NARRATOR_VOICE/u', 'NARRATOR_SPEED/u', 'NARRATOR_TICKET/u'].filter(Boolean).join(':')
    speakers.push({ argv: powershell(WINDOWS, 'powershell.exe'), env: { ...env, WSLENV: crossing }, program: 'powershell.exe' })
  }
  const { tool, languages, names } = await linuxSpeechOf($)
  // A language the synthesizer has no voice for is read by its English voice.
  const lang = language && (languages.size === 0 || languages.has(language) ? language : 'en')
  // At speed 1 no rate is given: the synthesizer keeps the one it is set up with.
  const isPaced = settings.speed !== 1
  if (tool === 'spd-say') {
    const options = [...(lang ? ['-l', lang] : []), ...(voice ? ['-y', voice] : []), ...(isPaced ? ['-r', String(dispatcherRate(settings.speed))] : [])]
    // speech-dispatcher speaks a voice it does not have with its default one, and says nothing.
    const isFallback = voice !== '' && names.size > 0 && !names.has(voice.toLowerCase())
    speakers.push(inLine({ argv: ['sh', '-c', LINUX, 'narrator', 'spd-say', '-w', ...options, '--', text], env: { ...env, NARRATOR_STOP: 'spd-say -S' }, program: 'spd-say', isFallback }))
  } else if (tool) {
    const selectedVoice = voice || lang
    const options = [...(selectedVoice ? ['-v', selectedVoice] : []), ...(isPaced ? ['-s', String(espeakWords(settings.speed))] : [])]
    speakers.push(inLine({ argv: ['sh', '-c', LINUX, 'narrator', tool, ...options, '--', text], env, program: tool }))
  }
  return speakers
}

async function commandOutput ($: EngineInterface, argv: string[]) {
  const result = await $.process.run(argv, { timeoutMs: 10_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`)
  return result.stdout.trim()
}

/** `name<TAB>language` rows as one line per language: `es-ES: Eddy, Mónica`. A voice installed in two qualities is listed once: its name picks the best. */
function formatNamedVoices (output: string) {
  const byLanguage = new Map<string, Set<string>>()
  for (const line of output.split(/\r?\n/).map(row => row.trim()).filter(Boolean)) {
    const [name = '', language = '?'] = line.split('\t')
    byLanguage.set(language, (byLanguage.get(language) ?? new Set()).add(name))
  }
  return [...byLanguage].sort(([a], [b]) => a.localeCompare(b)).map(([language, names]) => `${language}: ${[...names].join(', ')}`)
}

/** Lists voices exposed by this system's speech synthesizers. */
async function listVoices ($: EngineInterface) {
  const system = await platformOf($)
  if (system === 'macos') {
    const output = await commandOutput($, ['osascript', '-l', 'JavaScript', '-e', MACOS_VOICES])
    const voices = formatNamedVoices(output)
    return voices.length ? `Installed voices:\n${voices.join('\n')}` : 'Narrator: no installed voices found.'
  }
  if (system === 'windows') {
    const output = await commandOutput($, powershell(WINDOWS_VOICES))
    const voices = formatNamedVoices(output)
    return voices.length ? `Installed voices:\n${voices.join('\n')}` : 'Narrator: no installed voices found.'
  }
  if (system !== 'linux') return 'Narrator: voice discovery is not supported on this system.'

  const sections: string[] = []
  const failures: string[] = []
  if (await wslOf($)) {
    try {
      const output = await commandOutput($, powershell(WINDOWS_VOICES, 'powershell.exe'))
      const voices = formatNamedVoices(output)
      if (voices.length) sections.push(`Windows voices:\n${voices.join('\n')}`)
    } catch (error) {
      failures.push(`Windows: ${message(error)}`)
    }
  }
  const found = await commandOutput($, ['sh', '-c', 'for tool in spd-say espeak-ng espeak; do command -v "$tool" || true; done'])
  const paths = found.split('\n').map(path => path.trim())
  const has = (name: string) => paths.some(path => path.endsWith(`/${name}`))
  if (has('spd-say')) {
    try {
      const output = await commandOutput($, ['spd-say', '-L'])
      if (output) sections.push(`Speech Dispatcher voices (its output module's; pass a NAME to /narrator test):\n${output}`)
    } catch (error) {
      failures.push(`Speech Dispatcher: ${message(error)}`)
    }
  }
  const espeak = has('espeak-ng') ? 'espeak-ng' : has('espeak') ? 'espeak' : undefined
  if (espeak) {
    try {
      const output = await commandOutput($, [espeak, '--voices'])
      if (output) sections.push(`${espeak} voices:\n${output}`)
    } catch (error) {
      failures.push(`${espeak}: ${message(error)}`)
    }
  }
  if (!sections.length && failures.length) return `Narrator: could not list voices. ${failures.join('; ')}`
  if (!sections.length) return 'Narrator: no installed voices found.'
  if (failures.length) sections.push(`Some voices could not be listed: ${failures.join('; ')}`)
  return sections.join('\n\n')
}

/** Shows on the switch whether this session's narration is speaking, and how many wait behind it; while it does, sweeps it. */
async function showSpeech ($: EngineInterface) {
  const speaking = current?.isSpeaking ? { waiting: current.waiting ?? 0 } : null
  await update($, speech, () => speaking)
  if (speaking && !sweep) sweep = $.clock.every(SWEEP_MS, () => void update($, sweepStep, step => step + 1))
  if (!speaking && sweep) {
    sweep.cancel()
    sweep = undefined
    await update($, sweepStep, () => 0)
  }
}

/** Follows what a speaker says of itself: `voice` once it speaks, `waiting <n>` while others wait their turn. */
async function follow ($: EngineInterface, narration: Narration, said: string) {
  const isSpeaking = narration.isSpeaking === true || /^voice /m.test(said)
  const told = [...said.matchAll(/^waiting (\d+)\r?$/gm)].at(-1)?.[1]
  const waiting = told === undefined ? narration.waiting ?? 0 : Number(told)
  if (isSpeaking === (narration.isSpeaking === true) && waiting === (narration.waiting ?? 0)) return
  narration.isSpeaking = isSpeaking
  narration.waiting = waiting
  await showSpeech($)
}

/** Runs one speaker till it ends or the narration is silenced; how it spoke, if it did. */
async function play ($: EngineInterface, narration: Narration, command: Command): Promise<Spoke | undefined> {
  let said = ''
  let failure = ''
  try {
    for await (const { text } of $.process.spawn(command)) {
      said = (said + text.replace(/^\.\r?$/gm, '')).slice(-4000)
      if (!narration.isActive) break
      await follow($, narration, said)
    }
  } catch (error) {
    failure = message(error)
  } finally {
    if (narration.isSpeaking) {
      narration.isSpeaking = false
      await showSpeech($)
    }
  }
  const voice = /^voice (.+?)\r?$/m.exec(said)?.[1]
  // Behind others for too long: the line dropped it, and nothing else should say it now.
  if (/^skipped\r?$/m.test(said)) {
    $.ui.log('narrator: not said, the line of narrations from other sessions was too long', { to: 'debug' })
    return { voice: '', isFallback: false, isSkipped: true }
  }
  failure ||= /^error.*$/m.exec(said)?.[0] ?? (voice ? '' : `${command.program} said nothing`)
  // Under WSL the Windows side outlives its end of the pipe: end it by its id.
  const pid = /^pid (\d+)/m.exec(said)?.[1]
  if (!narration.isActive && pid && command.program === 'powershell.exe') {
    await $.process.run(['taskkill.exe', '/PID', pid, '/T', '/F']).catch(() => undefined)
  }
  if (!narration.isActive) return undefined
  $.ui.log(failure ? `narrator: ${command.program}: ${failure}` : `narrator: spoke with ${voice}`, { to: 'debug' })
  return failure === '' ? { voice: voice!, isFallback: command.isFallback === true || /^no voice /m.test(said) } : undefined
}

/** Says `text` with the best speaker that works here, the engine's own synthesizer last; how, if it did. */
async function speak ($: EngineInterface, narration: Narration, text: string, language: string, voice = settings.voice): Promise<Spoke | undefined> {
  // Every window shares one line, so two sessions that finish together are said one after the other.
  const ticket = String(await $.clock.now()).padStart(13, '0')
  for (const command of await speakersFor($, text, language, voice, ticket)) {
    const spoke = await play($, narration, command)
    if (spoke || !narration.isActive) return spoke
  }
  try {
    await $.audio.speak(text, voice ? { voice } : undefined)
    return { voice: voice || "Claude Code's own voice", isFallback: false }
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
    if (hasWarned) return undefined
    hasWarned = true
    const system = await platformOf($)
    $.ui.toast(system === 'linux'
      ? 'Narrator: no voice to speak with. Install speech-dispatcher (spd-say) or espeak-ng.'
      : `Narrator: no voice to speak with (${message(error)}).`)
    return undefined
  }
}

/** Says a short sample with `voice` (empty: the one picked for English), and what came of it. */
async function testVoice ($: EngineInterface, voice: string) {
  silence()
  const narration: Narration = { isActive: true, abort: new AbortController() }
  current = narration
  try {
    const spoke = await speak($, narration, PREVIEW, 'en', voice)
    if (!narration.isActive) return 'Narrator: preview stopped.'
    if (!spoke) return 'Narrator: could not play the voice preview.'
    if (spoke.isSkipped) return 'Narrator: not previewed, other sessions are speaking. Try again in a moment.'
    if (voice && spoke.isFallback) return `Narrator: there is no voice "${voice}", so the preview used ${spoke.voice}. /narrator voices lists the installed ones.`
    return `Narrator: previewed ${voice || spoke.voice}.`
  } catch (error) {
    $.ui.log(`narrator: voice preview: ${message(error)}`, { to: 'debug' })
    return `Narrator: could not play the voice preview. ${message(error)}`
  } finally {
    narration.isActive = false
    if (current === narration) current = undefined
  }
}

/** Stops what is being said, and the narration being written. */
function silence () {
  if (!current) return
  current.isActive = false
  current.abort.abort()
  current = undefined
}

/** Tells, out loud, what the turn that ended with `answer` did. */
async function narrate ($: EngineInterface, answer: string) {
  silence()
  const narration: Narration = { isActive: true, abort: new AbortController() }
  current = narration
  try {
    // A short answer already says it: read it out, with no model call to retell it, once its language
    // is known (macOS tells it from the text). With a language set, only when its words or the request
    // tell it is in that language: any other, the model says in it.
    const direct = plain(answer)
    const ownLanguage = guessLanguage(answer) || guessLanguage(`${request}\n${answer}`)
    const directLanguage = ownLanguage || spokenLanguage
    const isReadable = settings.language ? ownLanguage === settings.language : directLanguage !== '' || (await platformOf($)) === 'macos'
    if (direct !== '' && direct.length <= settings.shortAnswer && isReadable) {
      spokenLanguage = directLanguage
      const spoke = await speak($, narration, direct, directLanguage)
      if (!spoke && narration.isActive) $.ui.toast('Narrator: nothing was spoken (see /narrator test)')
      return
    }
    const reply = await $.model.complete(
      // A short summary: no deep thinking, so it is said right after the turn.
      { model: settings.model, system: NARRATOR(settings.language), prompt: brief(answer), maxTokens: 250, effort: 'low', timeoutMs: 30_000 },
      { signal: narration.abort.signal }
    ).catch(() => undefined)
    if (!narration.isActive) return
    const told = reply?.isAnswered ? parseNarration(reply.text) : undefined
    // No narration written: the answer itself, as far as it reads aloud.
    const { text, language } = told?.text ? told : { text: cut(direct, 500), language: directLanguage }
    if (language) spokenLanguage = language
    if (text) {
      const spoke = await speak($, narration, text, language)
      if (!spoke && narration.isActive) $.ui.toast('Narrator: nothing was spoken (see /narrator test)')
    }
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
    $.ui.toast(`Narrator failed: ${message(error)}`)
  } finally {
    if (current === narration) current = undefined
  }
}

/** A click on the switch: while it speaks, on to the next narration in the line or quiet; else on or off. */
function press ($: EngineInterface) {
  if (current?.isSpeaking) return silence()
  void setEnabled($)
}

/** Switches the narrator on or off (no `value`: the other way), and keeps it for the next sessions. */
async function setEnabled ($: EngineInterface, value?: boolean) {
  let isEnabled = false
  await update($, enabled, now => (isEnabled = value ?? !now))
  if (!isEnabled) silence()
  await $.store.set('enabled', isEnabled)
  return isEnabled
}

export const register: Register = (on, options) => {
  const speed = Number(options.speed)
  const shortAnswer = Number(options.shortAnswer ?? SHORT_ANSWER)
  settings = {
    voice: String(options.voice ?? '').trim(),
    model: String(options.model || 'haiku'),
    speed: speed > 0 ? speed : SPEED,
    shortAnswer: shortAnswer >= 0 ? shortAnswer : SHORT_ANSWER,
    language: languageOf(options.language)
  }

  on('session.start', async ($, e, next) => {
    const asked = String(options.language ?? '').trim()
    if (asked && !settings.language) $.ui.log(`narrator: "${cut(asked, 40)}" is not a language code (es, en, pt...): speaking the language you write in`, { to: 'debug' })
    await $.command.register({
      name: 'narrator',
      description: 'Claude tells you out loud what it did after each turn · no argument: switch on or off',
      argumentHint: '[on | off | stop | voices | test [voice]]',
      immediate: true
    })
    const isEnabled = (await $.store.get('enabled')) === true
    await update($, enabled, () => isEnabled)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    silence()
    return next(e)
  })

  on('command.run', { command: 'narrator' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'voices') {
      try {
        return { text: await listVoices($) }
      } catch (error) {
        return { text: `Narrator: could not list voices. ${message(error)}` }
      }
    }
    const test = /^test(?:\s+([\s\S]+))?$/i.exec(e.args.trim())
    if (test) {
      const named = (test[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
      return { text: await testVoice($, named || settings.voice) }
    }
    if (arg === 'stop') {
      silence()
      return { text: 'Narrator: quiet.' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Usage: /narrator [on | off | stop | voices | test [voice]]' }
    const isEnabled = await setEnabled($, arg === '' ? undefined : arg === 'on')
    return { text: isEnabled ? 'Narrator on: Claude will tell you out loud what it did after each turn.' : 'Narrator off.' }
  })

  // A new prompt means the person has moved on: stop talking.
  on('prompt.submit', ($, e, next) => {
    silence()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.text) request = e.text
      actions = []
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && actions.length < MAX_ACTIONS && (await read($, enabled))) {
      actions.push(describe(e) + (result.deny !== undefined ? ' (denied)' : result.isError ? ' (failed)' : ''))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.trim() && (await read($, enabled))) void narrate($, e.answer)
    return result
  })

  // The toggle, in the band above the prompt: just an icon. A click turns the narrator on or off, and
  // while it speaks, skips to the next narration in the line or stops it. Grey and crossed when off,
  // green when on, blue with animated sound arcs while it speaks.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (e.props.hasSurvey) return beneath
    const isEnabled = await read($, enabled)
    const speaking = await read($, speech)
    const step = speaking ? await read($, sweepStep) : 0
    const table = $.ui.resolve(e)
    const state = speaking ? 'speaking' : isEnabled ? 'on' : 'off'
    const { Box, Button, Text } = table

    if (!('Svg' in table)) {
      const glyph = state === 'off' ? '\u23F8\uFE0E narrator off' : state === 'on' ? '\u23F5 narrator on' : '\u23F9\uFE0E narrating'
      return band($, e, beneath, [undefined, (
        <Button key="narrator" plain onPress={() => press($)}>
          <Text color={state === 'off' ? 'inactive' : state === 'on' ? 'success' : 'permission'}>{glyph}</Text>
        </Button>
      ), undefined])
    }

    // The icon is drawn, a Button is only text: an invisible one lies over it to take the click.
    const label = speaking ? 'Stop narrating' : isEnabled ? 'Turn narrator off' : 'Turn narrator on'
    return band($, e, beneath, [undefined, (
      <Box key="narrator-icon" position="relative" width={4} height={1}>
        <table.Svg source={micManSvg(state, step)} alt={label} width={30} height={22} />
        <Box position="absolute" top={0} left={0}>
          <Button key="narrator" plain label={'\u00A0\u00A0\u00A0\u00A0'} onPress={() => press($)} />
        </Box>
      </Box>
    ), undefined])
  })
}

/** The band is one row of three slots (left, center, right) that the mods share: each fills its own and keeps the others'. */
const SLOTS = 'band-slots'
const WIDTHS = ['38%', '24%', '38%'] as const
const JUSTIFY = ['flex-start', 'center', 'flex-end'] as const

function band ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], beneath: RenderNode | undefined, own: [RenderNode?, RenderNode?, RenderNode?]): RenderNode {
  const { Box } = $.ui.resolve(e)
  const isShared = typeof beneath === 'object' && beneath !== null && beneath.type === 'Box' && (beneath.props as { key?: string }).key === SLOTS
  const prior = isShared ? ((beneath as { children?: RenderNode[] }).children ?? []) : []
  const cells = [0, 1, 2].map(i => own[i] !== undefined
    ? <Box width={WIDTHS[i]} flexDirection="row" justifyContent={JUSTIFY[i]} alignItems="center">{own[i]}</Box>
    : prior[i] ?? <Box width={WIDTHS[i]} />)
  return (
    <Box key={SLOTS} flexDirection="row" flexGrow={1} alignItems="center">
      {cells}
      {isShared ? prior[3] ?? null : beneath}
    </Box>
  )
}

/** A sketched speaker, head and shoulders only, an arm raised to a microphone: grey and crossed off, green on, blue with animated sound arcs while speaking. */
function micManSvg (state: string, step: number) {
  const stroke = state === 'off' ? '#8e8e93' : state === 'on' ? '#30d158' : '#0a84ff'
  const arc = (n: number) => (state === 'speaking' ? ((step + n * 3) % 10 < 5 ? 1 : 0.3) : 1)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 22" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    '<circle cx="9" cy="7" r="4"/>' +
    '<path d="M1.5 21v-2.5C1.5 15.5 4.5 13.5 9 13.5s7.5 2 7.5 5V21"/>' +
    '<path d="M14.5 17.5l3-3 2-3"/>' +
    `<rect x="18.4" y="3.5" width="4.4" height="7" rx="2.2" fill="${stroke}" fill-opacity="0.3"/>` +
    (state === 'off'
      ? '<path d="M3 20.5L27 1.5" stroke-width="1.7"/>'
      : `<path d="M25 5.5a4 4 0 010 5" opacity="${arc(0)}"/><path d="M27.8 3.5a7 7 0 010 9" opacity="${arc(1)}"/>`) +
    '</svg>'
}
