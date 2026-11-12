import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const urls = new Map()
/** Load actual TypeScript modules and their relative imports in Node checks. */
export function typescriptModuleUrl(file, transform = (source) => source) {
  const absolute = file instanceof URL ? fileURLToPath(file) : path.resolve(file)
  const key = absolute + transform.toString()
  if (urls.has(key)) return urls.get(key)
  const source = transform(fs.readFileSync(absolute, 'utf8'))
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const ast = ts.createSourceFile(absolute, js, ts.ScriptTarget.Latest, true), edits = []
  for (const statement of ast.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue
    const specifier = statement.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
    const relative = path.resolve(path.dirname(absolute), specifier.text)
    const resolved = [relative, relative + '.ts', relative + '.tsx', relative + '.mjs'].find((name) => fs.existsSync(name) && fs.statSync(name).isFile())
    if (!resolved) throw new Error(`Cannot resolve ${specifier.text} from ${absolute}`)
    edits.push({ start: specifier.getStart(ast), end: specifier.end, value: JSON.stringify(typescriptModuleUrl(resolved)) })
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) js = js.slice(0, edit.start) + edit.value + js.slice(edit.end)
  const url = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  urls.set(key, url)
  return url
}

export function loadTypeScript(file, transform) { return import(typescriptModuleUrl(file, transform)) }
