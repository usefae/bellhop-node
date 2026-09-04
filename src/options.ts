/**
 * Print options, and the part of them a library can refuse on its own
 * (PROTOCOL.md §5.2.3).
 *
 * Four things are knowable without an agent: an option name that does not
 * exist, a value outside its enum or range, a page range that does not parse,
 * and an option that does not apply to the job's format. All four are refused
 * at the call site, where a stack trace points at the developer's own line.
 * Whether a particular queue holds `Letter` or has a second tray is the
 * agent's to answer, and it does so in the `ack`.
 */

import type { PrintFormat, PrintOptions } from './types.js'

const EVERY_FORMAT: PrintFormat[] = ['zpl', 'raw', 'pdf', 'gif']

interface OptionRule {
  /** The formats this option means something for. Anything else fails. */
  formats: PrintFormat[]
  /** How the value is described when it is wrong. Reads after "must be". */
  expects: string
  valid(value: unknown): boolean
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)

const boolean = (value: unknown): boolean => typeof value === 'boolean'

const keyword = (value: unknown): boolean => typeof value === 'string' && value.length > 0

/**
 * `zpl` and `raw` take `copies` and nothing else. The queue does not interpret
 * the bytes, so width, darkness and orientation are already decided by the
 * document.
 */
const OPTIONS: Record<keyof PrintOptions, OptionRule> = {
  copies: {
    formats: EVERY_FORMAT,
    expects: 'a whole number from 1 to 100',
    valid: (value) => whole(value) && value >= 1 && value <= 100,
  },
  duplex: {
    formats: ['pdf'],
    expects: '"one-sided", "long-edge", or "short-edge"',
    valid: (value) => value === 'one-sided' || value === 'long-edge' || value === 'short-edge',
  },
  paper: {
    formats: ['pdf', 'gif'],
    expects: 'a paper keyword the agent reported for that printer, byte for byte',
    valid: keyword,
  },
  bin: {
    formats: ['pdf', 'gif'],
    expects: 'an input tray keyword the agent reported for that printer',
    valid: keyword,
  },
  dpi: {
    formats: ['pdf', 'gif'],
    expects: 'a resolution the agent reported for that printer',
    valid: (value) => whole(value) && value >= 1,
  },
  color: {
    formats: ['pdf', 'gif'],
    expects: 'true or false',
    valid: boolean,
  },
  pages: {
    formats: ['pdf'],
    expects:
      'one-based page numbers and ranges, ascending and non-overlapping, with no spaces: "1-4,7,9-12"',
    valid: (value) => typeof value === 'string' && pagesParse(value),
  },
  rotate: {
    formats: ['pdf', 'gif'],
    expects: '0, 90, 180, or 270, in degrees clockwise',
    valid: (value) => value === 0 || value === 90 || value === 180 || value === 270,
  },
  fit: {
    formats: ['pdf', 'gif'],
    expects: 'true or false',
    valid: boolean,
  },
  collate: {
    formats: ['pdf'],
    expects: 'true or false',
    valid: boolean,
  },
  nup: {
    formats: ['pdf'],
    expects: '1, 2, 4, 6, 9, or 16 pages per sheet',
    valid: (value) =>
      value === 1 || value === 2 || value === 4 || value === 6 || value === 9 || value === 16,
  },
}

const NAMES = Object.keys(OPTIONS)

const PAGES = /^[1-9][0-9]*(-[1-9][0-9]*)?(,[1-9][0-9]*(-[1-9][0-9]*)?)*$/

/** `"1-4,7"` parses; `"7,1-4"`, `"4-1"`, and `"1-4, 7"` do not. */
function pagesParse(value: string): boolean {
  if (!PAGES.test(value)) return false
  let previousLast = 0
  for (const term of value.split(',')) {
    const bounds = term.split('-').map(Number)
    const first = bounds[0]!
    const last = bounds[1] ?? first
    // Ascending and non-overlapping, which the pattern alone cannot say.
    if (first > last || first <= previousLast) return false
    previousLast = last
  }
  return true
}

/**
 * The sentence to refuse this `options` object with, or null if it is fine.
 * An unknown key is refused too. This is the one place the protocol forbids
 * ignoring what you do not recognise: `{ duplx: … }` dropped quietly would be
 * a single-sided document acked as printed.
 */
export function refusePrintOptions(options: PrintOptions, format: PrintFormat): string | null {
  for (const [name, value] of Object.entries(options)) {
    // An explicit undefined is absent, for callers spreading partial objects.
    if (value === undefined) continue

    const rule = OPTIONS[name as keyof PrintOptions] as OptionRule | undefined
    if (!rule) {
      return `\`options.${name}\` is not a print option. Version 1 has: ${NAMES.join(', ')}.`
    }
    if (!rule.formats.includes(format)) {
      return `\`options.${name}\` does not apply to a ${format} job. It applies to: ${rule.formats.join(', ')}.`
    }
    if (!rule.valid(value)) {
      return `\`options.${name}\` must be ${rule.expects}.`
    }
  }
  return null
}

/**
 * Drop undefined keys, and the object itself if nothing is left, so neither
 * the stored job nor the wire carries an empty `options`.
 */
export function compactPrintOptions(options: PrintOptions | undefined): PrintOptions | null {
  if (!options) return null
  const compacted: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined) compacted[name] = value
  }
  return Object.keys(compacted).length > 0 ? compacted : null
}
