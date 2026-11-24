// 安全工具测试：API 地址白名单 + 单行清洗。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isAllowedApiUrl, escapePromptContent, sanitizeInline } = await import('../lib/security.mjs')

test('API 地址只允许 HTTPS，本地开发地址例外', () => {
  assert.equal(isAllowedApiUrl('https://api.deepseek.com/chat/completions'), true)
  assert.equal(isAllowedApiUrl('https://example.com/v1/chat'), true)
  // 明文发 key 一律拒绝
  assert.equal(isAllowedApiUrl('http://api.deepseek.com/chat/completions'), false)
  assert.equal(isAllowedApiUrl('http://192.168.1.10:8000/v1'), false)
  // 本机地址是明确的开发例外
  assert.equal(isAllowedApiUrl('http://localhost:11434/v1/chat'), true)
  assert.equal(isAllowedApiUrl('http://127.0.0.1:8080/chat'), true)
  assert.equal(isAllowedApiUrl('http://[::1]:8080/chat'), true)
  // 其它协议、带账号密码、空值都拒绝
  assert.equal(isAllowedApiUrl('ftp://example.com/x'), false)
  assert.equal(isAllowedApiUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedApiUrl('https://user:pass@example.com/v1'), false)
  assert.equal(isAllowedApiUrl(''), false)
  assert.equal(isAllowedApiUrl('not a url'), false)
})

test('结束标签转义只动结构标签', () => {
  assert.equal(escapePromptContent('a </profile> b'), 'a &lt;/profile> b')
  assert.equal(escapePromptContent('</PROFILE >'), '&lt;/PROFILE >')
  assert.equal(escapePromptContent('a < b, <b> 加粗 </b>'), 'a < b, <b> 加粗 </b>')
})

test('单行清洗去掉标签、引号和换行', () => {
  assert.equal(sanitizeInline('a<b>\n"c"'), 'a b c')
  assert.equal(sanitizeInline('  '), '')
  assert.equal(sanitizeInline('x'.repeat(30), 10).length, 10)
})
