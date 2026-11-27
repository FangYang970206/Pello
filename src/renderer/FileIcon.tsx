import { Icon } from './icons'

const artwork = import.meta.glob<string>('./assets/file-icons/*.svg', { eager: true, import: 'default', query: '?url' })
const names = new Map(Object.entries({
  dockerfile: 'docker', containerfile: 'docker', 'docker-compose.yml': 'docker', 'compose.yaml': 'docker',
  'docker-compose.yaml': 'docker', 'compose.yml': 'docker', '.dockerignore': 'docker',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.npmrc': 'npm',
  'package.json': 'nodejs', 'package-lock.json': 'npm', 'tsconfig.json': 'typescript',
  makefile: 'console', license: 'license', 'license.txt': 'license',
  '.prettierrc': 'prettier', '.eslintrc': 'eslint', '.env': 'settings'
}))
const extensions = new Map<string, string>()
for (const [icon, suffixes] of Object.entries({
  javascript: 'js mjs cjs', typescript: 'ts mts cts', react: 'jsx tsx', python: 'py pyi pyw', java: 'java class',
  c: 'c', cpp: 'h hh hpp hxx cpp cc cxx', csharp: 'cs csproj', go: 'go', rust: 'rs', ruby: 'rb gemspec',
  php: 'php phtml', kotlin: 'kt kts', swift: 'swift', lua: 'lua', console: 'sh bash zsh fish bat cmd',
  powershell: 'ps1 psm1 psd1', html: 'html htm', css: 'css', sass: 'sass scss', json: 'json jsonc json5',
  yaml: 'yaml yml', toml: 'toml', markdown: 'md markdown mdown mdx', xml: 'xml xsl xsd',
  image: 'png jpg jpeg gif webp bmp ico svg avif heic tif tiff', pdf: 'pdf', zip: 'zip gz tar bz2 7z rar xz',
  audio: 'mp3 wav flac aac ogg m4a', video: 'mp4 mov webm mkv avi', database: 'db sqlite sqlite3 sql',
  table: 'csv tsv xls xlsx ods', document: 'txt rtf', word: 'doc docx odt', powerpoint: 'ppt pptx odp',
  settings: 'ini cfg conf env properties', vue: 'vue', svelte: 'svelte', log: 'log', lock: 'lock',
  font: 'ttf otf woff woff2'
})) for (const suffix of suffixes.split(' ')) extensions.set(suffix, icon)

export function FileIcon({ path }: { path: string }) {
  const name = path.split('/').at(-1)?.toLowerCase() || ''
  const icon = names.get(name) ||
    (/^dockerfile\./.test(name) ? 'docker' : undefined) ||
    (/^\.env\./.test(name) ? 'settings' : undefined) ||
    (/^(eslint\.config|\.eslintrc)\./.test(name) ? 'eslint' : undefined) ||
    (/^(prettier\.config|\.prettierrc)\./.test(name) ? 'prettier' : undefined) ||
    (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path) ? 'github-actions-workflow' : undefined) ||
    (name.includes('.') ? extensions.get(name.split('.').at(-1)!) : undefined)
  const src = icon && artwork[`./assets/file-icons/${icon}.svg`]
  return src ? <img className="file-type-icon" src={src} alt="" aria-hidden="true" draggable={false} /> : <Icon name="file" className="s" />
}
