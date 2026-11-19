const fs = require('node:fs')
const path = require('node:path')

const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis')
const [directory] = process.argv.slice(2)
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unsupported electron-builder NSIS template: ' + before)
  return source.replace(before, after)
}
const util = replaceOnce(fs.readFileSync(path.join(templates, 'include', 'installUtil.nsh'), 'utf8'),
  '!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"',
  // Use this build's uninstaller against the registered old installation.
  // The old EXE scans all of INSTDIR and can kill itself and the cached updater.
  // Registry lookup, install mode, keep-data flags and result checks stay native.
  'File "/oname=$PLUGINSDIR\\old-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"\n  StrCpy $uninstallerFileName "$uninstallerFileNameTemp"')
// NSIS !tempfile reserves a unique name. Replace that file with an include
// directory without changing node_modules or the builder's signing lifecycle.
fs.unlinkSync(directory)
fs.mkdirSync(directory)
fs.writeFileSync(path.join(directory, 'installUtil.nsh'), `!cd "${templates}"\n${util}`)
