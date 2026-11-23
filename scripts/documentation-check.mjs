import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), directory = path.join(root, 'assets/tutorials')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const readme = fs.readFileSync('README.md', 'utf8')
const steps = fs.readFileSync(path.join(directory, 'STEPS.md'), 'utf8')
const ids = new Set()
assert.equal(manifest.tutorials.length, 18, 'All 18 feature lessons need a capture, GIF and guide')
for (const tutorial of manifest.tutorials) {
  assert.ok(!ids.has(tutorial.id), `Duplicate lesson: ${tutorial.id}`); ids.add(tutorial.id)
  assert.ok(tutorial.steps.length >= 3, `${tutorial.id}: needs an action and visible result`)
  assert.ok(readme.includes(`assets/tutorials/${tutorial.id}.gif`), `${tutorial.id}: missing from README`)
  assert.ok(steps.includes(`<a id="${tutorial.id}"></a>`), `${tutorial.id}: missing static lesson`)
  const guide = path.join(root, 'wiki', `${tutorial.wiki}.md`)
  assert.ok(fs.existsSync(guide), `${tutorial.id}: missing Wiki page`)
  assert.ok(fs.readFileSync(guide, 'utf8').includes(`${tutorial.id}.gif`), `${tutorial.id}: missing Wiki animation`)
  const gif = fs.readFileSync(path.join(directory, `${tutorial.id}.gif`))
  assert.equal(gif.subarray(0, 6).toString(), 'GIF89a')
  assert.equal(gif.readUInt16LE(6), 1120); assert.equal(gif.readUInt16LE(8), 792)
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')), `${tutorial.id}: must loop`)
  assert.ok(gif.length < 5_000_000, `${tutorial.id}: keep the clip under 5 MB`)
  for (const step of tutorial.steps) {
    const jpg = fs.readFileSync(path.join(directory, step.file))
    assert.equal(jpg.readUInt16BE(0), 0xffd8, `Missing actual screenshot: ${step.file}`)
    assert.ok(step.caption && step.focus.length === 3 && step.focus[2] >= 1 && step.focus[2] <= 1.85)
  }
}

function anchors(text) {
  const seen = new Map(), result = new Set()
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /g, '-')
    const count = seen.get(base) || 0; seen.set(base, count + 1); result.add(base + (count ? `-${count}` : ''))
  }
  for (const match of text.matchAll(/<a id="([^"]+)"/g)) result.add(match[1])
  return result
}
const files = ['README.md', 'assets/tutorials/README.md', 'assets/tutorials/STEPS.md', ...fs.readdirSync('wiki').filter((name) => name.endsWith('.md')).map((name) => `wiki/${name}`)]
let links = 0
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes('\ufffd'), `${file}: invalid UTF-8 replacement character`)
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    let target = match[1]
    const rawPrefix = 'https://raw.githubusercontent.com/FangYang970206/Pello/main/'
    const repoPrefix = 'https://github.com/FangYang970206/Pello/blob/main/'
    const wikiPrefix = 'https://github.com/FangYang970206/Pello/wiki/'
    if (target.startsWith(rawPrefix)) target = path.join(root, target.slice(rawPrefix.length))
    else if (target.startsWith(repoPrefix)) target = path.join(root, target.slice(repoPrefix.length))
    else if (target.startsWith(wikiPrefix)) target = path.join(root, 'wiki', target.slice(wikiPrefix.length).replace(/\/_history$/, ''))
    else if (/^(https?:|mailto:)/.test(target)) continue
    else target = path.resolve(path.dirname(path.join(root, file)), target)
    const [pathname, fragment] = target.split('#')
    const resolved = fs.existsSync(pathname) ? pathname : pathname + '.md'
    assert.ok(fs.existsSync(resolved), `${file}: broken link ${match[1]}`)
    if (fragment && resolved.endsWith('.md')) assert.ok(anchors(fs.readFileSync(resolved, 'utf8')).has(decodeURIComponent(fragment)), `${file}: missing anchor ${match[1]}`)
    links++
  }
}
console.log(`PASS ${manifest.tutorials.length} feature lessons, ${files.length} Markdown documents, ${links} local/Wiki/media links, captions, focus bounds and GIF headers`)
