# 记忆与梦（local-dream）

给 **DSH Go** 用的长期记忆插件：把聊天里值得留下的内容整理成一组 Markdown 记忆块，之后的对话会自动带上它们；同时在后台「做梦」——把聊完的对话提炼进记忆库，每晚再写一篇当天的梦。

移植自 [RikkaHub](https://github.com/rikkahub/rikkahub) 的记忆库设计（AGPL-3.0）。

## 功能

- **对话侧记忆**：每轮 system prompt 自动注入 `<memory_system>`——`profile.md`、`preferences.md` 全文，其余记忆块的清单，以及「何时读、怎么用、何时能写」的规则。
- **六个记忆工具**：`memory_read` / `memory_write` / `memory_str_replace` / `memory_append` / `memory_delete` / `memory_list`。默认不写，用户明确说「记住 / 忘掉」时才当场写。
- **后台整理（做梦）**：聊天空闲 2 分钟、攒够 6 轮、每晚 23:30，或点「立即做梦」时，后台用带记忆工具的 agent 整理对话；纯后台进程，不打开对话。失败后不自动重试，等下一轮对话或手动触发。
- **面板**：记忆状态、累计 runs / tokens、按目录分组（你 / 话题 / 事务 / 人物）的记忆块、最近的梦；记忆可查看、编辑、新建、删除，梦可单独删除。
- **每晚一篇梦**：把当天最值得留下的东西写成 200 字以内的第一人称叙述，存在 `memory/dreams/`。

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
| 梦境 | `memory/dreams/` |
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

## 兼容性

- `engines.dsh`: `>=0.2.1-rc.2 <0.3.0-0`（引擎服务的接口范围）
- 需要 DSH 宿主提供 `tools` 与 `systemPrompt` 服务；缺任一项时只保留面板与后台整理。

## 隐私

记忆只存在本机，除调用你自己配置的模型 API 外不外发。插件不会记录身份证号、银行卡号等敏感信息（写入前会拦截）。整理模型的调用 token 累计在插件状态里，不进入其他账本。

## 已知限制

- App 没提供前台服务接口：App 被杀时后台整理会中断，切后台也不会立刻整理。
- 记忆库只有一份（工作区级），不像 RikkaHub 那样每个助手一份。
- 正文编辑框上限 600 字（App 表单提交整包限 4 KiB）；更长的正文请在聊天里让助手改。

## English

A long-term memory plugin for **DSH Go**. It injects a `<memory_system>` block (full `profile.md` / `preferences.md`, a listing of other blocks, and read/write rules) into every system prompt, exposes six `memory_*` tools to the chat, and consolidates finished conversations into Markdown memory blocks in the background — the "dreaming" step — plus a short first-person dream entry each night.

Install: copy the package into `$DSH_HOME/dsh-go/plugins/`, run `dsh plugin --profile web add <dir>`, then restart the engine from the App. Memory lives in `<workspace>/memory/` by default; set `DSH_DREAM_DIR` to move it. Optional `memory/.dream-config.json` selects the consolidation model and fallback chain. Licensed AGPL-3.0 because the prompts and tools are ported from RikkaHub. All memory stays on-device; only the configured model API is called.
