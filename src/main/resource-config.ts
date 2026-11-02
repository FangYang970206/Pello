import { parseForESLint, type AST } from 'toml-eslint-parser'
import { parse } from 'smol-toml'

/** Edit only the requested value, preserving unrelated TOML and comments. */
export function setTomlValue(text: string, keys: (string | number)[], value: boolean): string {
  const ast = parseForESLint(text).ast
  const same = (a: (string | number)[], b: (string | number)[]) => JSON.stringify(a) === JSON.stringify(b)
  let found: AST.TOMLContentNode | undefined
  let parent: AST.TOMLInlineTable | AST.TOMLTable | undefined
  const walk = (node: AST.TOMLContentNode, prefix: (string | number)[]) => {
    if (same(prefix, keys)) found = node
    if (node.type === 'TOMLInlineTable') {
      if (same(prefix, keys.slice(0, -1))) parent = node
      for (const item of node.body) walk(item.value, [...prefix, ...item.key.keys.map((k) => k.type === 'TOMLBare' ? k.name : k.value)])
    } else if (node.type === 'TOMLArray') node.elements.forEach((child, index) => walk(child, [...prefix, index]))
  }
  for (const item of ast.body[0].body) {
    if (item.type === 'TOMLTable') {
      if (same(item.resolvedKey, keys.slice(0, -1))) parent = item
      for (const field of item.body) walk(field.value, [...item.resolvedKey, ...field.key.keys.map((k) => k.type === 'TOMLBare' ? k.name : k.value)])
    } else walk(item.value, item.key.keys.map((k) => k.type === 'TOMLBare' ? k.name : k.value))
  }
  let next: string
  if (found) next = text.slice(0, found.range[0]) + String(value) + text.slice(found.range[1])
  else if (parent?.type === 'TOMLInlineTable') {
    const position = parent.range[1] - 1
    next = text.slice(0, position) + `${parent.body.length ? ', ' : ''}${JSON.stringify(keys.at(-1))} = ${value}` + text.slice(position)
  } else if (parent) {
    const newline = text.indexOf('\n', parent.key.range[1]), position = newline < 0 ? text.length : newline
    next = text.slice(0, position) + `\n${JSON.stringify(keys.at(-1))} = ${value}` + text.slice(position)
  } else next = `${text}\n[${keys.slice(0, -1).map((key) => JSON.stringify(key)).join('.')} ]\n${JSON.stringify(keys.at(-1))} = ${value}\n`
  parse(next.replace(/^\ufeff/, ''))
  return next
}
