// 「编辑记忆」面板的视图，独立成模块是为了能用官方检查器直接验它（面板里要先用列表选中才能打开）。
// 表单输入用 bind 绑到面板数据上，提交时 App 把数据发回 save-edit，由 index.js 处理。

// 表单提交整体限 4 KiB UTF-8 JSON（App 协议），中文按 3 字节算，正文留 600 字
const BODY_EDIT_LIMIT = 600

/**
 * @param {object} input
 * @param {'new'|'edit'} input.mode
 * @param {{path:string,title:string,description:string,aliases:string[],body:string}} input.entry
 * @param {boolean} input.zh
 */
export const EDIT_BODY_LIMIT = BODY_EDIT_LIMIT

export function buildEditView({ mode, entry, zh }) {
  const bodyTooLong = (entry?.body || '').length > BODY_EDIT_LIMIT
  const children = []

  if (mode === 'new') {
    children.push({
      type: 'textField',
      label: zh ? '路径' : 'Path',
      bind: 'data.path',
      placeholder: '/topics/food.md',
      required: true,
      maxLength: 128,
    })
  } else {
    children.push({
      type: 'keyValue',
      items: [[zh ? '路径' : 'Path', entry?.path || '—']],
    })
  }

  children.push({ type: 'textField', label: zh ? '标题' : 'Title', bind: 'data.title', maxLength: 120 })
  children.push({ type: 'textField', label: zh ? '摘要' : 'Summary', bind: 'data.description', maxLength: 120 })
  children.push({
    type: 'textField',
    label: zh ? '别名' : 'Aliases',
    bind: 'data.aliases',
    placeholder: zh ? '用逗号分隔' : 'Comma separated',
    maxLength: 120,
  })

  if (bodyTooLong) {
    // 正文太长放不进输入框，保存时保留原文，不会被截断
    children.push({
      type: 'callout',
      text: zh
        ? `正文有 ${(entry?.body || '').length} 字，超过编辑框上限，这里只改标题和摘要；正文请在聊天里让助手改。`
        : `The body is too long for this editor; it stays unchanged. Ask the assistant in chat to edit it.`,
      tone: 'info',
    })
  } else {
    children.push({
      type: 'textField',
      label: zh ? '正文' : 'Body',
      bind: 'data.body',
      multiline: true,
      maxLines: 8,
      maxLength: BODY_EDIT_LIMIT,
    })
  }

  return {
    v: 2,
    type: 'stack',
    title: mode === 'new' ? (zh ? '新建记忆' : 'New memory') : zh ? '编辑记忆' : 'Edit memory',
    children: [
      {
        type: 'form',
        children,
        submit: 'save-edit',
        submitLabel: zh ? '保存' : 'Save',
      },
      { type: 'actions', items: [{ label: zh ? '取消' : 'Cancel', action: 'cancel-edit' }] },
    ],
  }
}

/** 面板 data 的初始值：编辑时带出原内容，新建时只有空模板 */
export function editData({ mode, entry }) {
  return {
    path: mode === 'new' ? '' : entry?.path || '',
    title: entry?.title || '',
    description: entry?.description || '',
    aliases: (entry?.aliases || []).join(', '),
    body: entry?.body || '',
  }
}
