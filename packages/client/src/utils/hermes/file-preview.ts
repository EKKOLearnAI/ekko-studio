export type FilePreviewKind =
  | 'image'
  | 'video'
  | 'markdown'
  | 'text'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'presentation'
  | 'spreadsheet'
  | 'csv'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const MARKDOWN_EXTS = new Set(['.md', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])

// Keep preview eligibility and syntax highlighting in one map so adding a
// language cannot make a file previewable without also assigning a renderer.
const TEXT_EXTENSION_LANGUAGES: Record<string, string> = {
  // Plain text, logs, docs, and patches.
  '.txt': 'plaintext', '.text': 'plaintext', '.log': 'plaintext',
  '.diff': 'diff', '.patch': 'diff', '.lock': 'plaintext', '.sum': 'plaintext',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.rst': 'plaintext', '.adoc': 'asciidoc', '.asciidoc': 'asciidoc',
  '.org': 'plaintext', '.tex': 'latex', '.sty': 'latex', '.cls': 'latex', '.bib': 'latex',

  // JavaScript, TypeScript, and web frameworks.
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.vue': 'xml', '.svelte': 'xml', '.astro': 'xml',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.styl': 'stylus', '.stylus': 'stylus',

  // Structured data and configuration.
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.jsonl': 'json', '.ndjson': 'json', '.geojson': 'json',
  '.webmanifest': 'json', '.har': 'json', '.ipynb': 'json', '.map': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini',
  '.ini': 'ini', '.env': 'ini', '.conf': 'ini', '.cfg': 'ini', '.cnf': 'ini',
  '.properties': 'properties', '.plist': 'xml', '.editorconfig': 'ini',
  '.xml': 'xml', '.xsl': 'xml', '.xslt': 'xml', '.xsd': 'xml', '.dtd': 'xml',
  '.csv': 'plaintext', '.tsv': 'plaintext',
  '.tf': 'hcl', '.tfvars': 'hcl', '.hcl': 'hcl', '.nix': 'nix', '.cue': 'plaintext',
  '.kdl': 'plaintext', '.avsc': 'json',

  // Shells and command scripts.
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'shell',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.bat': 'dos', '.cmd': 'dos',

  // General-purpose languages.
  '.py': 'python', '.pyw': 'python', '.pyi': 'python', '.pyx': 'python',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby',
  '.php': 'php', '.phtml': 'php', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala', '.sc': 'scala', '.groovy': 'groovy', '.gvy': 'groovy', '.gradle': 'gradle',
  '.cs': 'csharp', '.fs': 'fsharp', '.fsi': 'fsharp', '.fsx': 'fsharp', '.vb': 'vbnet',
  '.swift': 'swift', '.dart': 'dart', '.lua': 'lua',
  '.r': 'r', '.rmd': 'r', '.jl': 'julia', '.m': 'objectivec', '.mm': 'objectivec',
  '.pl': 'perl', '.pm': 'perl', '.t': 'perl', '.tcl': 'tcl',
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hrl': 'erlang',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure', '.edn': 'clojure',
  '.hs': 'haskell', '.lhs': 'haskell', '.elm': 'elm', '.ml': 'ocaml', '.mli': 'ocaml',
  '.nim': 'nim', '.zig': 'zig', '.v': 'verilog', '.d': 'd',
  '.sol': 'solidity', '.move': 'plaintext', '.cairo': 'plaintext',
  '.coffee': 'coffeescript', '.litcoffee': 'coffeescript',
  '.adb': 'ada', '.ads': 'ada', '.ada': 'ada', '.pas': 'delphi', '.pp': 'delphi',
  '.cob': 'cobol', '.cbl': 'cobol',
  '.f': 'fortran', '.for': 'fortran', '.f90': 'fortran', '.f95': 'fortran', '.f03': 'fortran',

  // C-family, systems, shaders, and hardware description.
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp',
  '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.inl': 'cpp',
  '.mpp': 'cpp', '.ixx': 'cpp', '.cu': 'cpp', '.cuh': 'cpp',
  '.asm': 'x86asm', '.s': 'x86asm',
  '.metal': 'cpp', '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl',
  '.hlsl': 'cpp', '.wgsl': 'plaintext',
  '.vhd': 'vhdl', '.vhdl': 'vhdl', '.sv': 'verilog', '.svh': 'verilog',

  // Query, API, schema, and infrastructure languages.
  '.sql': 'sql', '.prisma': 'plaintext', '.graphql': 'graphql', '.gql': 'graphql',
  '.proto': 'protobuf', '.thrift': 'plaintext', '.rego': 'plaintext',
  '.bicep': 'plaintext', '.dhall': 'plaintext', '.http': 'http', '.rest': 'http',

  // Templates and view files.
  '.pug': 'pug', '.jade': 'pug', '.hbs': 'handlebars', '.handlebars': 'handlebars',
  '.mustache': 'handlebars', '.ejs': 'html', '.njk': 'django', '.nunjucks': 'django',
  '.liquid': 'django', '.twig': 'twig', '.erb': 'erb', '.haml': 'haml', '.slim': 'ruby',
  '.blade': 'php', '.razor': 'cshtml-razor', '.cshtml': 'cshtml-razor', '.vbhtml': 'xml',

  // Build systems, project files, and platform configuration.
  '.dockerfile': 'dockerfile', '.cmake': 'cmake', '.mk': 'makefile',
  '.sln': 'plaintext', '.csproj': 'xml', '.fsproj': 'xml', '.vbproj': 'xml',
  '.vcxproj': 'xml', '.props': 'xml', '.targets': 'xml', '.pbxproj': 'plaintext',
  '.desktop': 'ini', '.service': 'ini', '.timer': 'ini', '.socket': 'ini', '.mount': 'ini',
}

const TEXT_BASENAME_LANGUAGES: Record<string, string> = {
  Dockerfile: 'dockerfile', Containerfile: 'dockerfile',
  Makefile: 'makefile', makefile: 'makefile', GNUmakefile: 'makefile',
  'CMakeLists.txt': 'cmake', 'meson.build': 'python', 'meson_options.txt': 'python',
  BUILD: 'python', 'BUILD.bazel': 'python', WORKSPACE: 'python', 'WORKSPACE.bazel': 'python',
  BUCK: 'python', Tiltfile: 'python', Earthfile: 'dockerfile', Justfile: 'makefile',
  Jenkinsfile: 'groovy', Procfile: 'yaml', Vagrantfile: 'ruby', Brewfile: 'ruby',
  Gemfile: 'ruby', Rakefile: 'ruby', Guardfile: 'ruby', Podfile: 'ruby', Cartfile: 'plaintext',
  Fastfile: 'ruby', Appfile: 'ruby', Deliverfile: 'ruby', Cakefile: 'csharp', Pipfile: 'toml',
  'Cargo.lock': 'toml',
  '.gitignore': 'gitignore', '.dockerignore': 'gitignore', '.gitattributes': 'plaintext',
  '.gitmodules': 'ini', '.gitconfig': 'ini', '.mailmap': 'plaintext',
  '.npmrc': 'ini', '.yarnrc': 'yaml', '.babelrc': 'json', '.eslintrc': 'json',
  '.prettierrc': 'json', '.stylelintrc': 'json', '.swcrc': 'json',
  '.browserslistrc': 'plaintext', '.editorconfig': 'ini',
  '.nvmrc': 'plaintext', '.node-version': 'plaintext', '.python-version': 'plaintext',
  '.ruby-version': 'plaintext', '.tool-versions': 'plaintext', '.terraformrc': 'hcl',
  '.curlrc': 'plaintext', '.wgetrc': 'plaintext', '.inputrc': 'plaintext',
  '.flake8': 'ini', '.coveragerc': 'ini', '.pylintrc': 'ini', '.sqlfluff': 'ini',
}

const TEXT_BASENAME_PREFIXES = [
  'README', 'LICENSE', 'NOTICE', 'CHANGELOG', 'CONTRIBUTING', 'AUTHORS', 'CODEOWNERS',
]

export function getFileExtension(name: string): string {
  const basename = name.split(/[\\/]/).pop() || ''
  const index = basename.lastIndexOf('.')
  return index >= 0 ? basename.slice(index).toLowerCase() : ''
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(getFileExtension(name))
}

export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTS.has(getFileExtension(name))
}

export function isTextFile(name: string): boolean {
  const basename = name.split(/[\\/]/).pop() || ''
  return getTextPreviewLanguage(basename) !== null
}

export function getTextPreviewLanguage(name: string): string | null {
  const basename = name.split(/[\\/]/).pop() || ''
  const specialLanguage = TEXT_BASENAME_LANGUAGES[basename]
  if (specialLanguage) return specialLanguage
  if (/^(?:Dockerfile|Containerfile|Jenkinsfile)(?:\..+)?$/.test(basename)) {
    if (basename.startsWith('Jenkinsfile')) return 'groovy'
    return 'dockerfile'
  }
  if (basename === '.env' || basename.startsWith('.env.')) return 'ini'
  const extensionLanguage = TEXT_EXTENSION_LANGUAGES[getFileExtension(basename)]
  if (extensionLanguage) return extensionLanguage
  if (TEXT_BASENAME_PREFIXES.some(prefix => basename === prefix || basename.startsWith(`${prefix}.`) || basename.startsWith(`${prefix}-`))) {
    return 'plaintext'
  }
  return null
}

export function getFilePreviewKind(name: string): FilePreviewKind | null {
  const extension = getFileExtension(name)
  if (IMAGE_EXTS.has(extension)) return 'image'
  if (VIDEO_EXTS.has(extension)) return 'video'
  if (MARKDOWN_EXTS.has(extension)) return 'markdown'
  if (HTML_EXTS.has(extension)) return 'html'
  if (extension === '.pdf') return 'pdf'
  if (extension === '.docx') return 'docx'
  if (extension === '.pptx') return 'presentation'
  if (extension === '.xlsx') return 'spreadsheet'
  if (extension === '.csv') return 'csv'
  return isTextFile(name) ? 'text' : null
}

export function isPreviewableFile(name: string): boolean {
  return getFilePreviewKind(name) !== null
}

export function previewMimeMatches(kind: FilePreviewKind, mime: string): boolean {
  const normalized = mime.split(';')[0].trim().toLowerCase()
  if (kind === 'image') return normalized.startsWith('image/')
  if (kind === 'video') return normalized.startsWith('video/')
  if (kind === 'html') return normalized === 'text/html'
  if (kind === 'pdf') return normalized === 'application/pdf'
  if (kind === 'docx') return normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (kind === 'presentation') return normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  if (kind === 'spreadsheet') return normalized === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (kind === 'csv') return normalized === 'text/csv'
  return normalized.startsWith('text/') || normalized === 'application/json' || normalized === 'application/xml'
}
