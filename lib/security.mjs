// 安全相关的小工具，集中在一处，主对话、后台 worker、面板共用：
//   - isAllowedApiUrl：自定义整理模型地址只允许 HTTPS（本地开发地址例外），
//     防止把 API key 明文发到 http 地址。
//   - escapePromptContent / sanitizeInline：记忆文件和历史对话是用户数据，
//     拼进提示词前要转义，不能让它关闭标签或伪造结构。
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 只有 HTTPS，或者本机的 HTTP 地址才算可信；带账号密码的一律拒绝 */
export function isAllowedApiUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return Boolean(url.hostname)
  if (url.protocol === 'http:') return LOCAL_HOSTS.has(url.hostname.toLowerCase())
  return false
}

// 提示词里用到的标签；用户数据里出现同名结束标签会把结构拆坏，所以要转义
const PROMPT_TAGS = 'profile|preferences|memory_listing|memory_system|memory_format'
const closingTagRegex = new RegExp(`<\\s*/\\s*(${PROMPT_TAGS})\\s*>`, 'gi')

export function escapePromptContent(text) {
  return String(text ?? '').replace(closingTagRegex, (match) => match.replace('<', '&lt;'))
}

/** 清单行、标题、对话 id 这类单行字段：去掉会破坏结构的字符并压成一行 */
export function sanitizeInline(value, maxLength = 200) {
  const text = String(value ?? '')
    .replace(/[<>"\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}
