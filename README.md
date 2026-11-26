# 记忆（local-dream）

给 **DSH Go** 用的长期记忆插件：把聊天里值得留下的内容整理成一组 Markdown 记忆块，之后的对话会自动带上它们；聊完的对话由后台整理（RikkaHub 把这个过程叫「做梦」，这里只借用这个名字，不生成梦境文本）。

移植自 [RikkaHub](https://github.com/rikkahub/rikkahub) 的记忆库设计（AGPL-3.0）。

## 功能

- **对话侧记忆**：每轮 system prompt 自动注入 `<memory_system>`——`profile.md`、`preferences.md` 全文，其余记忆块的清单，以及「何时读、怎么用、何时能写」的规则。
- **六个记忆工具**：`memory_read` / `memory_write` / `memory_str_replace` / `memory_append` / `memory_delete` / `memory_list`。默认不写，用户明确说「记住 / 忘掉」时才当场写。
- **后台整理（RikkaHub 的「做梦」）**：聊天空闲 2 分钟、攒够 6 轮，或点「立即整理」时，后台用带记忆工具的 agent 把对话里的新事实提炼进记忆库；纯后台进程，不打开对话。失败后不自动重试，等下一轮对话或手动触发。
- **面板**：记忆状态、累计 runs / tokens、按目录分组（你 / 话题 / 事务 / 人物）的记忆块；记忆可查看、编辑、新建、删除。

## 安装

```sh
# 把包放到主机上的插件目录
npm install -g local-dream            # 或用 npm pack 得到 tarball 后解压
cp -r "$(npm root -g)/local-dream" "$DSH_HOME/dsh-go/plugins/"
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-dream"
```

装完在 App 的「引擎」页重启引擎。改源码后同样要重启才生效（HMR 不监听源码）。

## 数据放在哪

| 内容 | 路径 |
|---|---|
| 记忆块 | `$DSH_DREAM_DIR/blocks/`（默认 `<工作区>/memory/blocks/`） |
| 索引 | `<工作区>/MEMORY.md`、`memory/blocks-index.json` |
| 整理进度 | `memory/.consolidation.json` |
| 状态（含累计用量） | `memory/.dream-state.json` |
| 日志 | `memory/dream.log` |
| 模型配置 | `memory/.dream-config.json` |

环境变量：`DSH_DREAM_DIR` 换记忆库位置；`DSH_DREAM_SYNC_TARGET` 配了才用 `rclone` 同步（默认关）。

## 配置整理模型

`memory/.dream-config.json`（可选）：

```json
{
  "model": "deepseek-reasoner",
  "models": ["deepseek-reasoner", "deepseek-chat"],
  "api_url": "https://api.deepseek.com/chat/completions",
  "reasoning_effort": "high"
}
```

`models` 是回退链，前一个模型报错（模型不存在 / 参数不支持）就换下一个。API key 从 `$DSH_HOME/.credentials.yaml` 或 `DEEPSEEK_API_KEY` 读取。

`api_url` 只接受 HTTPS；本机地址（`localhost` / `127.0.0.1` / `[::1]`）可以用 HTTP 做本地开发。填了别的地址会回退到默认地址，避免把 key 明文发出去。模型调用遇到 429 / 5xx / 断网会做有限次数退避重试（429 遵守服务端的 `Retry-After`），key 错误直接失败，不会无限重试。

## 兼容性

- `engines.dsh`: `>=0.2.1-rc.2 <0.3.0-0`（引擎服务的接口范围）
- 需要 DSH 宿主提供 `tools` 与 `systemPrompt` 服务；缺任一项时只保留面板与后台整理。

## 测试

```sh
npm test          # 等价于 node --test test/*.test.mjs
```

测试在临时目录里跑，不碰真实记忆库；覆盖路径越界、符号链接逃逸、版本冲突、aliases 语义、敏感内容拦截、提示词转义和 API 地址白名单。

## 隐私

记忆只存在本机，除调用你自己配置的模型 API 外不外发。插件不会记录身份证号、银行卡号等敏感信息（写入前会拦截）。记忆内容拼进提示词前会被当作「数据」转义，里面出现伪造标签或「忽略以上指令」也不会改变规则。整理模型的调用 token 累计在插件状态里，不进入其他账本。

## 已知限制

- App 没提供前台服务接口：App 被杀时后台整理会中断，切后台也不会立刻整理。
- 记忆库只有一份（工作区级），不像 RikkaHub 那样每个助手一份。
- 详情页按 1980 字分段渲染全文（App 单段文字上限 2000 字，总视图上限 32 KiB）；正文编辑框上限 900 字（App 表单提交整包限 4 KiB）；更长的正文请在聊天里让助手改。

## 1.1.1 的改动

- **移除「每晚一篇梦」**：RikkaHub 的做梦只是后台记忆整理，不产出梦境文本；插件不再写 `memory/dreams/`，面板里也没有梦境列表和删除入口，后台每天 23:30 的定时也不再触发。旧目录里的文件会原样留着，但不会再生成或同步。
- 界面文案「做梦」统一改成「整理」，避免和文学意义上的梦混淆。

## 1.1.0 的改动

- **编辑不再静默覆盖**：编辑页保存时带上打开时的版本号，期间被后台整理或别处改过就拒绝保存并打开最新内容。
- **符号链接防护**：记忆读写除了字符串规范化，还对真实路径做检查；`blocks/` 内指向库外的软链接会被拒绝。
- **写入原子化**：记忆块、索引、状态文件都改成临时文件 + rename，进程被杀不会留下半截内容。
- **提示词注入防护**：记忆正文、对话标题和 id 里的结构字符会被转义，只能作为记录内容出现。
- **aliases 语义明确**：不传 = 保留，传空 = 清空，传值 = 覆盖（之前缺字段会误清空）。
- **后台更稳**：模型调用加 429 / 5xx / 网络重试与退避；锁增加心跳续期，活着的进程不会被误判过期。
- **代码去重**：六个记忆工具的定义只在 `tools.mjs` 里写一次，主对话和后台共用；新增 `lib/security.mjs` 收拢地址校验与转义；第一次加自动化测试。

## English

A long-term memory plugin for **DSH Go**. It injects a `<memory_system>` block (full `profile.md` / `preferences.md`, a listing of other blocks, and read/write rules) into every system prompt, exposes six `memory_*` tools to the chat, and consolidates finished conversations into Markdown memory blocks in the background — the "dreaming" step, RikkaHub's name for memory consolidation.

Install: copy the package into `$DSH_HOME/dsh-go/plugins/`, run `dsh plugin --profile web add <dir>`, then restart the engine from the App. Memory lives in `<workspace>/memory/` by default; set `DSH_DREAM_DIR` to move it. Optional `memory/.dream-config.json` selects the consolidation model and fallback chain. "Dreaming" is only RikkaHub's name for background memory consolidation: the plugin never writes dream text. Licensed AGPL-3.0 because the prompts and tools are ported from RikkaHub. All memory stays on-device; only the configured model API is called.
