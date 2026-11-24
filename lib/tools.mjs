// 记忆库的读写工具，描述和返回格式照搬 RikkaHub 的 MemoryTools.kt。
// 工具的名字 / 描述 / 参数结构只在这里定义一次（MEMORY_TOOL_SPECS），
// 主对话（chat-memory.mjs）和后台整理（worker.mjs）都从这里取，改参数不会两边漂移。
import {
  getFile,
  writeFile,
  replaceInFile,
  appendToFile,
  deleteFile,
  listFiles,
} from './memory-store.mjs'

export const TOOL_NAMES = {
  READ: 'memory_read',
  WRITE: 'memory_write',
  STR_REPLACE: 'memory_str_replace',
  APPEND: 'memory_append',
  DELETE: 'memory_delete',
  LIST: 'memory_list',
}

/** 会改动记忆库的工具 */
export const WRITE_TOOLS = new Set([TOOL_NAMES.WRITE, TOOL_NAMES.STR_REPLACE, TOOL_NAMES.APPEND, TOOL_NAMES.DELETE])

export const MAX_READ_PATHS = 20
const IF_VERSION_DESCRIPTION = 'The version returned by the most recent read or write of this file'

function stringSchema(description) {
  return { type: 'string', description }
}

/** 六个记忆工具的唯一权威定义：name / description / parameters / required */
export const MEMORY_TOOL_SPECS = [
  {
    name: TOOL_NAMES.READ,
    description: "Read one or more memory files. Returns each file's content and version.",
    parameters: {
      path: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_READ_PATHS,
        description: 'Paths of the files to read, e.g. ["/topics/food.md"]',
      },
    },
    required: ['path'],
  },
  {
    name: TOOL_NAMES.WRITE,
    description:
      'Create a memory file or overwrite it entirely. content is the complete file; lines not included are removed.\n' +
      'if_version: pass "new" for a new file, or the version returned by the most recent read or write of an existing file.',
    parameters: {
      path: stringSchema('Path of the file, e.g. /topics/food.md'),
      content: stringSchema('The complete file content'),
      if_version: stringSchema('"new" for a new file, otherwise the file\'s current version'),
    },
    required: ['path', 'content', 'if_version'],
  },
  {
    name: TOOL_NAMES.STR_REPLACE,
    description:
      'Replace the single occurrence of old_str in a memory file with new_str. An empty new_str deletes it.\n' +
      'Rejected when old_str matches zero or several places.',
    parameters: {
      path: stringSchema('Path of the file'),
      old_str: stringSchema('Text to replace; must match exactly one place'),
      new_str: stringSchema('Replacement text; empty to delete'),
      if_version: stringSchema(IF_VERSION_DESCRIPTION),
    },
    required: ['path', 'old_str', 'new_str', 'if_version'],
  },
  {
    name: TOOL_NAMES.APPEND,
    description: 'Append one line to the end of a memory file.',
    parameters: {
      path: stringSchema('Path of the file'),
      content: stringSchema('The line to append'),
      if_version: stringSchema(IF_VERSION_DESCRIPTION),
    },
    required: ['path', 'content', 'if_version'],
  },
  {
    name: TOOL_NAMES.DELETE,
    description: 'Delete an entire memory file. Only use when the user explicitly asks to forget a whole topic.',
    parameters: {
      path: stringSchema('Path of the file'),
      if_version: stringSchema(IF_VERSION_DESCRIPTION),
    },
    required: ['path', 'if_version'],
  },
  {
    name: TOOL_NAMES.LIST,
    description: 'List memory files (path, size, update time), optionally filtered by path prefix.',
    parameters: {
      path_prefix: stringSchema('Only list files whose path starts with this, e.g. /people/'),
    },
    required: [],
  },
]

function fn(spec) {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: { type: 'object', properties: spec.parameters, required: spec.required },
    },
  }
}

/** 给模型看的一整套记忆工具；fullReview=false 时移除 delete（自动整理只增改） */
export function buildMemoryTools(fullReview) {
  const tools = MEMORY_TOOL_SPECS.map(fn)
  return fullReview ? tools : tools.filter((t) => t.function.name !== TOOL_NAMES.DELETE)
}

function argString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string') throw new Error(`${key} is required`)
  return value
}

function readPaths(args) {
  const value = args?.path
  if (Array.isArray(value)) return value.filter((p) => typeof p === 'string').slice(0, MAX_READ_PATHS)
  if (typeof value === 'string') return [value]
  return []
}

/** 执行一次工具调用，返回给模型的 JSON 字符串 */
export function executeMemoryTool(name, args) {
  const input = typeof args === 'string' ? safeJson(args) : args || {}
  switch (name) {
    case TOOL_NAMES.READ: {
      const paths = readPaths(input)
      if (!paths.length) return JSON.stringify({ error: 'path is required' })
      const files = []
      const notFound = []
      for (const p of paths) {
        const file = getFile(p)
        if (file) files.push({ path: file.path, version: file.version, content: file.content })
        else notFound.push(p)
      }
      const out = { files }
      if (notFound.length) out.not_found = notFound
      return JSON.stringify(out)
    }
    case TOOL_NAMES.WRITE: {
      const result = writeFile(argString(input, 'path'), argString(input, 'content'), argString(input, 'if_version'))
      return JSON.stringify(result)
    }
    case TOOL_NAMES.STR_REPLACE: {
      const result = replaceInFile(
        argString(input, 'path'),
        argString(input, 'old_str'),
        input.new_str == null ? '' : String(input.new_str),
        argString(input, 'if_version')
      )
      return JSON.stringify(result)
    }
    case TOOL_NAMES.APPEND: {
      const result = appendToFile(argString(input, 'path'), argString(input, 'content'), argString(input, 'if_version'))
      return JSON.stringify(result)
    }
    case TOOL_NAMES.DELETE: {
      const result = deleteFile(argString(input, 'path'), argString(input, 'if_version'))
      return JSON.stringify(result)
    }
    case TOOL_NAMES.LIST: {
      const prefix = typeof input.path_prefix === 'string' ? input.path_prefix : ''
      const files = listFiles()
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({
          path: f.path,
          size: Buffer.byteLength(f.content, 'utf8'),
          updated_at: new Date(f.updatedAt).toISOString(),
        }))
      return JSON.stringify({ files })
    }
    default:
      return JSON.stringify({ error: `unknown tool ${name}` })
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 这次工具调用成功改动的记忆文件路径；不是写工具、还没执行或写入被拒绝时返回 null */
export function memoryWritePath(name, resultText) {
  if (!WRITE_TOOLS.has(name)) return null
  const result = safeJson(resultText)
  if (!result || typeof result !== 'object') return null
  if ('error' in result) return null
  return typeof result.path === 'string' ? result.path : null
}
