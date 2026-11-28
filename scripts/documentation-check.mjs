import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), directory = path.join(root, 'assets/tutorials')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const readmes = ['README.md', 'README.en.md']
const wikiHome = 'https://github.com/FangYang970206/Pello/wiki/Home'
const wikiIndex = fs.readFileSync('wiki/Home.md', 'utf8')
const steps = fs.readFileSync(path.join(directory, 'STEPS.md'), 'utf8')
const ids = new Set()
for (const [index, file] of readmes.entries()) {
  const readme = fs.readFileSync(file, 'utf8')
  assert.ok(readme.includes(`](${readmes[1 - index]})`), `${file}: missing language switch`)
  assert.ok(readme.includes(`](${wikiHome})`), `${file}: missing Wiki guide link`)
  assert.doesNotMatch(readme, /\.gif\b/i, `${file}: GIFs belong in the Wiki guides`)
}
assert.equal(manifest.tutorials.length, 18, 'All 18 features need a guide')
assert.equal(manifest.tutorials.filter((tutorial) => tutorial.steps.length > 0).length, 17, 'Keep all 17 current animations')
for (const tutorial of manifest.tutorials) {
  assert.ok(!ids.has(tutorial.id), `Duplicate lesson: ${tutorial.id}`); ids.add(tutorial.id)
  assert.ok(steps.includes(`<a id="${tutorial.id}"></a>`), `${tutorial.id}: missing static lesson`)
  const guide = path.join(root, 'wiki', `${tutorial.wiki}.md`)
  assert.ok(fs.existsSync(guide), `${tutorial.id}: missing Wiki page`)
  assert.ok(wikiIndex.includes(`](${tutorial.wiki})`), `${tutorial.id}: missing link in the Wiki index`)
  const guideText = fs.readFileSync(guide, 'utf8')
  const gifName = `${tutorial.id}.gif`
  if (tutorial.steps.length === 0) {
    assert.equal(tutorial.id, '13-discovery', 'Only the current Skill recommendations guide uses text alone')
    assert.ok(tutorial.note && steps.includes(tutorial.note), `${tutorial.id}: missing text instructions`)
    assert.ok(!guideText.includes(gifName) && !steps.includes(gifName), `${tutorial.id}: removed workflow is still linked`)
    continue
  }
  assert.ok(tutorial.steps.length >= 3, `${tutorial.id}: needs an action and visible result`)
  const embeddedImages = [...guideText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
  assert.ok(embeddedImages.includes(`https://raw.githubusercontent.com/FangYang970206/Pello/main/assets/tutorials/${gifName}`), `${tutorial.id}: missing embedded Wiki animation`)
  assert.ok(steps.includes(`](${gifName})`), `${tutorial.id}: missing animation link in the static lesson`)
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
const files = [...readmes, 'assets/tutorials/README.md', 'assets/tutorials/STEPS.md', ...fs.readdirSync('wiki').filter((name) => name.endsWith('.md')).map((name) => `wiki/${name}`)]
let links = 0
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes('\ufffd'), `${file}: invalid UTF-8 replacement character`)
  const markdownLinks = text.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)
  const imageSources = text.matchAll(/<(?:img|source)\b[^>]*\bsrc(?:set)?="([^"]+)"/g)
  for (const match of [...markdownLinks, ...imageSources]) {
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
