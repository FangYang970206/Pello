import fs from 'node:fs'
import path from 'node:path'

// The Rust kernel's messages, read as the kernel is written. The scan knows
// the forms the kernel uses and no others, so that a form it does not know is
// an error and not a silent miss.

/** A Rust string literal as written in the sources: `"…"` with `\"` and `\\`, or raw `r#"…"#`. */
const LITERAL = /^"((?:[^"\\]|\\.)*)"$/s
const RAW_LITERAL = /^r(#*)"([\s\S]*?)"\1$/s
const unescape = (text) => text.replace(/\\(["\\])/g, '$1')
const hasCjk = (text) => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(text)

/** Skip a string literal starting at `i`, returning the index after it. */
function afterString(text, i) {
  const raw = /^b?r(#*)"/.exec(text.slice(i))
  if (raw) {
    const end = text.indexOf('"' + raw[1], i + raw[0].length)
    if (end < 0) throw new Error(`A raw string is never closed at offset ${i}`)
    return end + raw[0].length
  }
  let j = i + 1
  while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++ }
  if (j >= text.length) throw new Error(`A string is never closed at offset ${i}`)
  return j + 1
}

/** The arguments of a call whose opening parenthesis is at `open`, split at the top-level commas. */
function argumentsOf(text, open) {
  let depth = 0, end = -1
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { i = afterString(text, i) - 1; continue }
    if (c === '(') depth++
    else if (c === ')') { if (depth === 0) { end = i; break } depth-- }
  }
  if (end < 0) throw new Error(`A call is never closed at offset ${open}`)
  const args = text.slice(open + 1, end)
  const parts = []
  let part = '', level = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === '"') { const stop = afterString(args, i); part += args.slice(i, stop); i = stop - 1; continue }
    if (c === '(' || c === '[') level++
    if (c === ')' || c === ']') level--
    if (c === ',' && level === 0) { parts.push(part.trim()); part = ''; continue }
    part += c
  }
  parts.push(part.trim())
  return parts
}

/** Every string literal of a Rust source, outside line comments. */
export function stringLiterals(text) {
  const found = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue }
    if (text[i] === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2; i = stop; continue }
    if (text[i] === "'") {
      // A character literal: its quote is not the start of a string.
      if (text[i + 1] === '\\') { let j = i + 2; while (j < text.length && text[j] !== "'") { if (text[j] === '\\') j++; j++ } i = j + 1; continue }
      if (text[i + 2] === "'" && text[i + 1] !== "'") { i += 3; continue }
      i++
      continue
    }
    if (text[i] === '"') {
      const stop = afterString(text, i)
      found.push({ text: unescape(text.slice(i + 1, stop - 1)), raw: false, line: text.slice(0, i).split('\n').length })
      i = stop
      continue
    }
    const raw = /^b?r(#*)"/.exec(text.slice(i))
    if (raw && (i === 0 || !/[\w"]/.test(text[i - 1]))) {
      const stop = afterString(text, i)
      found.push({ text: text.slice(i + raw[0].length, stop - raw[1].length - 1), raw: true, line: text.slice(0, i).split('\n').length })
      i = stop
      continue
    }
    i++
  }
  return found
}

const CORE = 'src-tauri/core/src'
const kernelFiles = () => fs.readdirSync(CORE).filter((name) => name.endsWith('.rs'))

/**
 * The kernel's messages: the table's entries, every call that translates a
 * literal, and every Chinese literal of the menu module, whose texts reach
 * the user through small closures and not through `translate` directly.
 */
export function kernelMessages() {
  const table = fs.readFileSync(path.join(CORE, 'i18n.rs'), 'utf8')
  const entries = []
  for (const match of table.matchAll(/^ {4}\("((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\),\r?$/gm)) {
    entries.push({ source: unescape(match[1]), english: unescape(match[2]), line: table.slice(0, match.index).split('\n').length })
  }
  const callers = []
  for (const name of kernelFiles()) {
    if (name === 'i18n.rs') continue
    const text = fs.readFileSync(path.join(CORE, name), 'utf8')
    for (const match of text.matchAll(/(?:^|[^\w])translate\(/g)) {
      const [, source] = argumentsOf(text, match.index + match[0].length - 1)
      const line = text.slice(0, match.index).split('\n').length
      const plain = LITERAL.exec(source)
      const raw = plain ? null : RAW_LITERAL.exec(source)
      // A source that is not a literal is passed on by a forwarding helper:
      // a closure of the menu module, or one of the few helpers of the other
      // modules. Whether that is so is for the check to say, which knows the
      // helper by the function the call is in.
      const head = text.slice(0, match.index)
      callers.push({ file: name, line, source: plain ? unescape(plain[1]) : raw ? raw[2] : null, passed: plain || raw ? null : source, within: [...head.matchAll(/\bfn (\w+)(?:<[^>]*>)?\(/g)].at(-1)?.[1] || '' })
    }
  }
  const menu = []
  for (const { text, line } of stringLiterals(fs.readFileSync(path.join(CORE, 'menu.rs'), 'utf8'))) if (hasCjk(text)) menu.push({ file: 'menu.rs', line, text })
  return { entries, callers, menu }
}
