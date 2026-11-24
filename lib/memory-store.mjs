// 记忆库：一组 Markdown 文件，每个文件是一个「记忆块」。
// 照 RikkaHub 的 MemoryFile / MemoryRepository 实现：
//   - frontmatter 里的 title 是界面上显示的名字（用户用什么语言写就用什么语言）
//   - version 由内容算 SHA-256 前 12 位，写操作用它做乐观锁
//   - 每个文件最大 48KB，只拦会变大的超限写入
//   - 证件号 / 社保号 / 银行卡号写入前兜底拦截
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { WORKSPACE, MEMORY_DIR } from './paths.mjs'

export const ROOT = WORKSPACE
export { MEMORY_DIR }
export const BLOCKS = path.join(MEMORY_DIR, 'blocks')
export const BLOCK_INDEX = path.join(MEMORY_DIR, 'blocks-index.json')
export const MEM_INDEX = path.join(ROOT, 'MEMORY.md')

export const PROFILE_PATH = '/profile.md'
export const PREFERENCES_PATH = '/preferences.md'
export const MAX_BYTES = 48 * 1024
const MAX_PATH_LENGTH = 128
const NEW_FILE_VERSION = 'new'

// 界面上分组的顺序：根目录（你）、话题、事务、人物
export const DIRECTORY_ORDER = ['/', '/topics', '/areas', '/people']
const PINNED_PATH_ORDER = [PROFILE_PATH, PREFERENCES_PATH]

// ---------- frontmatter ----------

/** 只认 `key: value` 和 `aliases: [a, b]` 这种简单字段，够记忆文件用 */
export function parseFrontmatter(content) {
  const values = {}
  if (!String(content).startsWith('---')) return values
  const end = String(content).indexOf('\n---', 3)
  if (end < 0) return values
  const yaml = content.slice(3, end).trim()
  if (!yaml) return values
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) continue
    const value = m[2].trim()
    if (!value) continue
    if (/^\[.*\]$/.test(value)) {
      values[m[1]] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      values[m[1]] = value.replace(/^["']|["']$/g, '')
    }
  }
  return values
}

/** 去掉 frontmatter 后的正文 */
export function extractBody(content) {
  const text = String(content)
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  return text.slice(end + 4).replace(/^[\r\n]+/, '')
}

/** 把字段写成 frontmatter 接在正文前面；留空的不写 */
export function composeFrontmatter(values, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      const list = value.map((v) => String(v).trim()).filter(Boolean)
      if (!list.length) continue
      lines.push(`${key}: [${list.join(', ')}]`)
    } else {
      lines.push(`${key}: ${String(value).replace(/\s+/g, ' ').trim()}`)
    }
  }
  lines.push('---')
  const text = String(body || '').replace(/^[\r\n]+/, '').replace(/\s+$/, '')
  return lines.join('\n') + '\n' + (text ? '\n' + text + '\n' : '')
}

const statedMarkerRegex = /(^|\n)(\s*[-*+]\s+)\[stated\]\s*/gi

/** 给用户看的正文：`[stated]` 是写给模型的标记，界面上不显示 */
export function displayBody(body) {
  return String(body || '').replace(statedMarkerRegex, '$1$2')
}

// ---------- 路径与标题 ----------

/** 规范化模型或用户给出的路径，不合法时返回 null */
export function normalizePath(raw) {
  const text = String(raw ?? '').trim()
  const p = text.startsWith('/') ? text : '/' + text
  if (p.length > MAX_PATH_LENGTH || !p.endsWith('.md')) return null
  if (/[\x00-\x1f\\]/.test(p)) return null
  const segments = p.replace(/^\//, '').split('/')
  if (segments.some((s) => !s.trim() || s !== s.trim() || s.startsWith('.'))) return null
  return p
}

/** 文件名转标题：frontend-tooling → Frontend Tooling */
export function memoryTitleOf(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.replace(/^./, (c) => c.toUpperCase()))
    .join(' ')
}

export function memoryVersionOf(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex').slice(0, 12)
}

// ---------- 敏感内容兜底拦截（照 RikkaHub MemoryContentGuard） ----------

const chineseIdRegex = /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g
const ssnRegex = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/
const paymentCardRegex = /(?<![\d-])\d(?:[ -]?\d){14,18}(?![\d-])/g
const CHINESE_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]

function isValidChineseId(id) {
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * CHINESE_ID_WEIGHTS[i]
  return '10X98765432'[sum % 11] === id[17].toUpperCase()
}

function isLuhnValid(digits) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function findForbiddenMemoryContent(text) {
  const content = String(text || '')
  if ([...content.matchAll(chineseIdRegex)].some((m) => isValidChineseId(m[0]))) return 'an ID number'
  if (ssnRegex.test(content)) return 'a social security number'
  if ([...content.matchAll(paymentCardRegex)].some((m) => isLuhnValid(m[0].replace(/\D/g, '')))) {
    return 'a bank card number'
  }
  return null
}

// ---------- 记忆库读写 ----------

function blockFile(relPath) {
  return path.join(BLOCKS, relPath.replace(/^\//, ''))
}

function fromDisk(relPath) {
  const full = blockFile(relPath)
  const content = fs.readFileSync(full, 'utf8')
  const st = fs.statSync(full)
  const frontmatter = parseFrontmatter(content)
  const name = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const directory = relPath.slice(0, relPath.lastIndexOf('/')) || '/'
  const body = extractBody(content)
  const title = (frontmatter.title || '').trim() || memoryTitleOf(name)
  const aliasValue = frontmatter.aliases
  const aliases = Array.isArray(aliasValue) ? aliasValue : []
  return {
    path: relPath,
    content,
    updatedAt: st.mtimeMs,
    version: memoryVersionOf(content),
    name,
    directory,
    title,
    description: (frontmatter.description || '').trim(),
    aliases,
    body,
    displayBody: displayBody(body),
  }
}

/** 列出记忆库里全部文件（按路径排序） */
export function listFiles() {
  const out = []
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full, `${rel}/${name}`)
      else if (name.endsWith('.md')) out.push(fromDisk(`${rel}/${name}`))
    }
  }
  walk(BLOCKS, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function getFile(relPath) {
  const normalized = normalizePath(relPath)
  if (!normalized) return null
  try {
    return fromDisk(normalized)
  } catch {
    return null
  }
}

function invalidPath(relPath) {
  return { error: `Invalid path "${relPath}". Use an absolute path ending in .md, e.g. /topics/food.md.` }
}

function guardContent(content, write) {
  const forbidden = findForbiddenMemoryContent(content)
  if (!forbidden) return write()
  return {
    error:
      `Refused: the content looks like it contains ${forbidden}, which is never stored in memory. ` +
      'Leave it out, and tell the user in one sentence that it cannot be saved.',
  }
}

function update(relPath, ifVersion, { allowCreate = false, edit }) {
  const normalized = normalizePath(relPath)
  if (!normalized) return invalidPath(relPath)
  const current = getFile(normalized)
  const versionMatches =
    ifVersion == null
      ? current != null || allowCreate
      : ifVersion === NEW_FILE_VERSION
        ? current == null && allowCreate
        : current?.version === ifVersion
  if (!versionMatches) {
    return {
      error: current
        ? `Version conflict: ${normalized} already exists or has changed since you read it. ` +
          'Merge your change into current_content and retry with current_version.'
        : `${normalized} does not exist. Create it with memory_write and if_version="new".`,
      current_version: current?.version,
      current_content: current?.content,
    }
  }
  const edited = edit(current ? current.content : '')
  if (edited?.error) return { error: edited.error }
  const content = edited.content
  const size = Buffer.byteLength(content, 'utf8')
  const oldSize = current ? Buffer.byteLength(current.content, 'utf8') : 0
  if (size > MAX_BYTES && size > oldSize) {
    return {
      error:
        `${normalized} would exceed the ${MAX_BYTES / 1024}KB limit. ` +
        'Merge duplicates and drop outdated details instead of adding more.',
    }
  }
  const full = blockFile(normalized)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
  return { path: normalized, version: memoryVersionOf(content) }
}

/** 新建或整体覆盖 */
export function writeFile(relPath, content, ifVersion = null) {
  if (typeof content !== 'string') return { error: 'content is required' }
  return guardContent(content, () =>
    update(relPath, ifVersion, { allowCreate: true, edit: () => ({ content }) })
  )
}

/** 把唯一匹配的 oldStr 换成 newStr，newStr 为空即删除 */
export function replaceInFile(relPath, oldStr, newStr, ifVersion = null) {
  return guardContent(newStr, () =>
    update(relPath, ifVersion, {
      edit: (current) => {
        if (!oldStr) return { error: 'old_str must not be empty.' }
        const index = current.indexOf(oldStr)
        if (index < 0) return { error: `old_str was not found in ${relPath}.` }
        if (current.indexOf(oldStr, index + 1) >= 0) {
          return {
            error: `old_str matches more than one place in ${relPath}; include more surrounding text to make it unique.`,
          }
        }
        return { content: replaceAt(current, index, oldStr.length, newStr) }
      },
    })
  )
}

/** 在文件末尾追加一行 */
export function appendToFile(relPath, line, ifVersion = null) {
  if (!String(line || '').trim()) return { error: 'content must not be blank' }
  return guardContent(line, () =>
    update(relPath, ifVersion, {
      edit: (current) => {
        const separator = current === '' || current.endsWith('\n') ? '' : '\n'
        return { content: current + separator + String(line).replace(/[\r\n]+$/, '') + '\n' }
      },
    })
  )
}

export function deleteFile(relPath, ifVersion = null) {
  const normalized = normalizePath(relPath)
  if (!normalized) return invalidPath(relPath)
  const current = getFile(normalized)
  if (!current || (ifVersion != null && ifVersion !== current.version)) {
    return {
      error: current
        ? `Version conflict: ${normalized} has changed since you read it.`
        : `${normalized} does not exist.`,
      current_version: current?.version,
      current_content: current?.content,
    }
  }
  fs.rmSync(blockFile(normalized))
  return { path: normalized, deleted: true }
}

// 删掉的是完整一行时连换行一起去掉，不留空行
function replaceAt(text, index, length, replacement) {
  let start = index
  let end = index + length
  if (replacement === '') {
    const atLineStart = start === 0 || text[start - 1] === '\n'
    const atLineEnd = end === text.length || text[end] === '\n'
    if (atLineStart && atLineEnd) {
      if (end < text.length) end++
      else if (start > 0) start--
    }
  }
  return text.slice(0, start) + replacement + text.slice(end)
}

// ---------- 清单 ----------

function orderOf(list, item) {
  const i = list.indexOf(item)
  return i < 0 ? list.length : i
}

export function sectionTitle(directory) {
  return (
    {
      '/': '你',
      '/topics': '话题',
      '/areas': '事务',
      '/people': '人物',
    }[directory] || memoryTitleOf(directory.replace(/^\//, ''))
  )
}

/** 按目录分组，用于在界面上展示 */
export function groupByDirectory(files) {
  const sorted = [...files].sort(
    (a, b) => orderOf(PINNED_PATH_ORDER, a.path) - orderOf(PINNED_PATH_ORDER, b.path) || a.path.localeCompare(b.path)
  )
  const groups = new Map()
  for (const file of sorted) {
    if (!groups.has(file.directory)) groups.set(file.directory, [])
    groups.get(file.directory).push(file)
  }
  return [...groups.entries()].sort(
    (a, b) => orderOf(DIRECTORY_ORDER, a[0]) - orderOf(DIRECTORY_ORDER, b[0]) || a[0].localeCompare(b[0])
  )
}

/** 给模型看的清单行：path | description | aliases | updated */
export function listingLines(files) {
  return files
    .filter((f) => f.path !== PROFILE_PATH && f.path !== PREFERENCES_PATH)
    .map((file) => {
      let line = `${file.path} | ${file.description || '(no description)'}`
      if (file.aliases.length) line += ` | aliases: ${file.aliases.join(', ')}`
      line += ` | updated: ${new Date(file.updatedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}`
      return line
    })
}

/** 重建 blocks-index.json 和 MEMORY.md（都显示中文标题） */
/**
 * 面板编辑页保存：标题 / 摘要 / 别名 / 正文一起写回。
 * 只传了的字段才覆盖，没传的（undefined）保留原样；新建时路径必须是新的 .md。
 */
export function saveEditedFile({ path: rawPath, title, description, aliases, body, isNew = false }) {
  const normalized = normalizePath(rawPath)
  if (!normalized) return { error: `Invalid path "${rawPath}". Use a path ending in .md, e.g. /topics/food.md.` }
  const current = getFile(normalized)
  if (isNew && current) return { error: `${normalized} already exists.` }
  if (!isNew && !current) return { error: `${normalized} does not exist.` }

  const original = current ? parseFrontmatter(current.content) : {}
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const values = { name }
  // 编辑页不展示的其他 frontmatter 字段原样保留
  for (const [key, value] of Object.entries(original)) {
    if (!['name', 'title', 'description', 'aliases'].includes(key)) values[key] = value
  }
  if (typeof title === 'string') values.title = title.replace(/\s+/g, ' ').trim() || undefined
  if (typeof description === 'string') values.description = description.replace(/\s+/g, ' ').trim() || undefined
  if (aliases !== undefined) {
    const list = (Array.isArray(aliases) ? aliases : String(aliases).split(','))
      .map((item) => String(item).trim())
      .filter(Boolean)
    if (list.length) values.aliases = list
  }
  const nextBody = typeof body === 'string' ? body : current ? current.body : ''
  const content = composeFrontmatter(values, nextBody)
  const result = writeFile(normalized, content, isNew ? 'new' : current.version)
  if (result.error) return result
  return { ...result, title: (values.title || '').trim() || memoryTitleOf(name) }
}

export function rebuildIndexes(inputFiles = listFiles()) {
  const files = groupByDirectory(inputFiles).flatMap(([, group]) => group)
  const index = files.map((f) => ({
    path: f.path,
    name: f.name,
    title: f.title,
    description: f.description,
    aliases: f.aliases,
    size: Buffer.byteLength(f.content, 'utf8'),
    updatedAt: f.updatedAt,
  }))
  fs.writeFileSync(BLOCK_INDEX, JSON.stringify(index, null, 1), 'utf8')

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const lines = [
    '# 记忆索引',
    '',
    '> 记忆由多个 Markdown 文件组成，每个文件是一块。`/profile.md` 和 `/preferences.md` 每次都要读；其余按需读。',
    `> 最后更新：${today}`,
    '',
    '## 块清单',
    '',
  ]
  for (const file of files) {
    const desc = file.description ? ` — ${file.description}` : ''
    lines.push(`- ${file.title}（\`${file.path}\`）${desc}`)
  }
  fs.writeFileSync(MEM_INDEX, lines.join('\n') + '\n', 'utf8')
}
