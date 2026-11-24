// 记忆库的单元测试：路径、版本冲突、aliases 语义、敏感内容、符号链接、索引原子写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-dream-store-'))
process.env.DSH_WORKSPACE = root
process.env.DSH_DREAM_DIR = path.join(root, 'memory')

const store = await import('../lib/memory-store.mjs')
const { BLOCKS } = store

function frontmatterFile(title, aliases, body) {
  const aliasLine = aliases === undefined ? '' : `aliases: [${aliases.join(', ')}]\n`
  return `---\nname: test\ntitle: ${title}\n${aliasLine}---\n${body}\n`
}

test('normalizePath 拒绝越界和非法路径', () => {
  assert.equal(store.normalizePath('../etc/passwd.md'), null)
  assert.equal(store.normalizePath('/topics/../../x.md'), null)
  assert.equal(store.normalizePath('/topics/.hidden/x.md'), null)
  assert.equal(store.normalizePath('/topics/x.txt'), null)
  assert.equal(store.normalizePath('/topics/food.md'), '/topics/food.md')
  assert.equal(store.normalizePath('topics/food.md'), '/topics/food.md')
})

test('创建、读取、版本冲突', () => {
  const created = store.writeFile('/topics/food.md', frontmatterFile('饮食', ['吃'], '- [stated] 喜欢辣'), 'new')
  assert.equal(created.error, undefined)
  assert.match(created.version, /^[0-9a-f]{12}$/)

  const file = store.getFile('/topics/food.md')
  assert.equal(file.path, '/topics/food.md')
  assert.equal(file.title, '饮食')
  assert.equal(file.version, created.version)

  // 同一个版本号不能重复用于新建
  assert.match(store.writeFile('/topics/food.md', 'x', 'new').error, /Version conflict|already exists/)
  // 旧版本号写入被拒绝，并带回最新内容
  const stale = store.writeFile('/topics/food.md', 'y', 'deadbeef0000')
  assert.match(stale.error, /Version conflict/)
  assert.equal(stale.current_version, created.version)
  assert.ok(stale.current_content.includes('喜欢辣'))

  const replaced = store.replaceInFile('/topics/food.md', '喜欢辣', '喜欢清淡', created.version)
  assert.equal(replaced.error, undefined)
  assert.ok(store.getFile('/topics/food.md').content.includes('喜欢清淡'))
})

test('删除需要正确版本号', () => {
  store.writeFile('/topics/gone.md', frontmatterFile('临时', [], '- 一行'), 'new')
  const file = store.getFile('/topics/gone.md')
  assert.match(store.deleteFile('/topics/gone.md', 'deadbeef0000').error, /Version conflict/)
  assert.equal(store.deleteFile('/topics/gone.md', file.version).deleted, true)
  assert.equal(store.getFile('/topics/gone.md'), null)
})

test('aliases：不传保留、传空清空、传值覆盖', () => {
  store.writeFile('/topics/alias.md', frontmatterFile('别名测试', ['甲', '乙'], '- 一行'), 'new')
  let file = store.getFile('/topics/alias.md')

  // 只改标题，别名字段不传 → 原样保留
  let saved = store.saveEditedFile({ path: '/topics/alias.md', title: '改名后', ifVersion: file.version })
  assert.equal(saved.error, undefined)
  file = store.getFile('/topics/alias.md')
  assert.deepEqual(file.aliases, ['甲', '乙'])
  assert.equal(file.title, '改名后')

  // 显式提交空 aliases → 真正清空
  saved = store.saveEditedFile({ path: '/topics/alias.md', aliases: '', ifVersion: file.version })
  assert.equal(saved.error, undefined)
  file = store.getFile('/topics/alias.md')
  assert.deepEqual(file.aliases, [])

  // 逗号分隔字符串也能写回去
  saved = store.saveEditedFile({ path: '/topics/alias.md', aliases: '丙, 丁', ifVersion: file.version })
  assert.equal(saved.error, undefined)
  assert.deepEqual(store.getFile('/topics/alias.md').aliases, ['丙', '丁'])
})

test('编辑保存使用打开时的版本：期间被改过就返回冲突', () => {
  store.writeFile('/topics/race.md', frontmatterFile('并发', [], '- 原内容'), 'new')
  const opened = store.getFile('/topics/race.md')
  // 模拟后台整理在用户编辑期间写了一次
  const background = store.appendToFile('/topics/race.md', '- 后台新增', opened.version)
  assert.equal(background.error, undefined)

  const saved = store.saveEditedFile({ path: '/topics/race.md', title: '新的', ifVersion: opened.version })
  assert.match(saved.error, /Version conflict/)
  assert.equal(saved.current_version, background.version)
  assert.ok(saved.current_content.includes('后台新增'))
})

test('敏感内容写入被拦截（主对话与后台共用同一入口）', () => {
  const idCard = '11010519491231002X'
  const idResult = store.writeFile('/people/id.md', `- 身份证 ${idCard}`, 'new')
  assert.match(idResult.error, /ID number/)
  assert.equal(store.getFile('/people/id.md'), null)

  const cardResult = store.writeFile('/people/card.md', '- 卡号 4111111111111111', 'new')
  assert.match(cardResult.error, /bank card number/)
  assert.equal(store.getFile('/people/card.md'), null)

  const ok = store.writeFile('/people/ok.md', '- 电话号码不是记忆内容，测试用普通文字', 'new')
  assert.equal(ok.error, undefined)
})

test('符号链接不能把写入带出记忆库', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-dream-outside-'))
  fs.mkdirSync(BLOCKS, { recursive: true })
  fs.symlinkSync(outside, path.join(BLOCKS, 'link'), 'dir')

  const result = store.writeFile('/link/pwn.md', 'escaped', 'new')
  assert.ok(result.error)
  assert.equal(fs.existsSync(path.join(outside, 'pwn.md')), false)
  assert.equal(store.getFile('/link/pwn.md'), null)
  // 列目录时跳过软链接
  assert.equal(store.listFiles().some((f) => f.path.startsWith('/link/')), false)
})

test('索引重建是原子写，不留临时文件', () => {
  store.writeFile('/areas/project.md', frontmatterFile('项目', [], '- 一行'), 'new')
  store.rebuildIndexes()
  const index = JSON.parse(fs.readFileSync(store.BLOCK_INDEX, 'utf8'))
  assert.ok(index.some((f) => f.path === '/areas/project.md'))
  assert.ok(fs.readFileSync(store.MEM_INDEX, 'utf8').includes('/areas/project.md'))
  const leftovers = fs
    .readdirSync(path.join(root, 'memory'))
    .filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})
