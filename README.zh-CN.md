<h1 align="center">harness-transfer</h1>

[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  在 <b>WorkBuddy</b>、<b>zcode</b> 和 <b>Codex / DeepSeek</b> 之间迁移 AI 编程助手的会话记录 —— 每次写入都做读回校验。
</p>

<p align="center">
  <a href="#为什么">为什么</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#问题在哪">问题在哪</a> •
  <a href="#工作原理">工作原理</a> •
  <a href="#校验">校验</a> •
  <a href="#命令参考">命令参考</a> •
  <a href="#安全性">安全性</a> •
  <a href="#已知边界">已知边界</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="零依赖">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证">
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-5fa04e" alt="node >=22.5">
</p>

---

## 为什么

你在某个工具里跟 AI 编程助手聊了一段，想换一个工具接着聊下去。没有任何官方方式能做这件事，因为这三个 harness 存储会话记录的方式完全不同。

`harness-transfer` 把任意一种读进来，转成中立的中间表示，写进任意另一种，然后**把结果读回来和源逐项对比** —— 这样你能在第一时间发现内容丢失，而不是三轮之后、在任务正做到一半、上下文已经错了的时候才发现。

```bash
git clone https://github.com/Nanawwa/harness-transfer.git
cd harness-transfer
node bin/harness-transfer.js --help      # 无需安装，无任何依赖
```

---

## 快速开始

```bash
# 有哪些会话？
node bin/harness-transfer.js list workbuddy

# 动之前先看看一个会话的构成
node bin/harness-transfer.js inspect workbuddy 0b65e4c4-db66-4788-99cb-8de225485a14

# 试跑 —— 只打印将要写入的内容，不写盘
node bin/harness-transfer.js convert workbuddy zcode 0b65e4c4-db66-4788-99cb-8de225485a14

# 真正写入，然后校验
node bin/harness-transfer.js convert workbuddy zcode 0b65e4c4-db66-4788-99cb-8de225485a14 --commit

# 全量迁移 —— 六个方向都支持
node bin/harness-transfer.js convert zcode codex --all --commit
```

---

## 问题在哪

这三个工具在存储上毫无共识。以下结构是从真实会话数据逆向得到的：

| | 存在哪 | 载体 | 一个「会话」是什么 |
|---|---|---|---|
| **WorkBuddy** | `~/.workbuddy/projects/<slug>/<uuid>.jsonl` | JSONL，每行一条记录 | 一个 `.jsonl` 文件 |
| **zcode** | `~/.zcode/cli/db/db.sqlite` | **SQLite** —— `message` + `part` 两张表 | `session` 表的一行 |
| **Codex / DeepSeek** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL，事件流 | **是多个共享同一 `session_id` 的文件** |

真正会踩到的几个不兼容点：

- **zcode 根本不是 JSONL。** 一份会话记录是 SQLite 里的若干行：一条 *message* = 一行记录 + 一组有序的 *part*，part 的 `type` 字段是判别式（`text`、`reasoning`、`tool`、`file`、`step-start`、`compaction`……）。
- **Codex 的一个会话横跨多个文件。** 恢复一个会话时会追加到新的 `rollout-*.jsonl`，但 `session_id` 不变。只读一个文件你拿到的是片段，不是整段对话。
- **Codex 把每件事都记两遍。** `response_item` 才是真正喂给模型的内容，`event_msg` 是 UI 层的重复副本。两个都搬过去，每轮对话在回放的上下文里就会出现两次 —— 既浪费 token，又让记录变得混乱。
- **zcode 把工具输出折叠进工具 part 本身。** 它没有独立的结果记录，输出存在工具 part 的 `state.output` 上。
- **只有 zcode 是数据库**，其余都是可以直接扔进目录的追加式文件。

---

## 工作原理

### 中立的中间表示

六种事件，取三种格式都能表达的部分，所以来回转换不丢信息：

```
user · assistant · reasoning · tool_call · tool_result
```

三种格式两两互算是六条通路；走中间层则是三个读 + 三个写，以后加第四个 harness 只需再写一个读、一个写，不必改动其他代码。

```
   workbuddy ─┐                        ┌─ workbuddy
   zcode     ─┼─▶  IR  (src/ir.js)  ─▶ ─┼─ zcode
   codex     ─┘                        └─ codex
```

### 与顺序无关的配对

WorkBuddy 的 JSONL **不保证按时间排序** —— `function_call_result` 可能出现在它对应的 `function_call` 之前。所以写 zcode 时先把所有结果建索引，遇到匹配的调用再回填输出。绝不用 `UPDATE … json_set(…)` 去原地打补丁：早期版本正是这么写的，结果静默损坏了 part 数据。

### 翻译规则

| 情况 | 处理方式 |
|---|---|
| 调用了但没返回的工具调用 | 写入时**不带** `output` 字段 —— 绝不伪造空结果 |
| 找不到对应调用的工具结果 | 保留为带标记的文本，不静默丢弃 |
| `developer` / `system` 消息（Codex） | 丢弃 —— 那是注入的系统提示词，不是对话 |
| `<system-reminder>`（WorkBuddy） | 正文保留，但不参与标题生成 |
| `<environment_context>`（Codex） | 正文保留，但不参与标题生成 |
| `event_msg`（Codex） | 丢弃 —— 和 `response_item` 重复 |
| `step-*`、`timeline`、`compaction` | 丢弃 —— UI 分隔线和运行时标记 |

---

## 校验

这才是关键部分。每次写入之后，工具会**用目标格式自己的读函数**重新解析产物，并和源逐项对比：

- 各类事件的计数（user / assistant / reasoning / tool_call / tool_result）
- 每一个文本块逐条比对
- 文本总量漂移（超过 0.1% 判失败）
- 工具调用与结果的配对 —— 孤儿记录会在**源和目标两边**都报出来，这样源本来就有的缺口不会被误判成迁移丢失
- 图片引用计数

这不是摆设。开发过程中它抓出了四个光靠肉眼看输出绝对发现不了的 bug：

1. **`textOf()` 漏掉了 `reasoning_text`** —— 某个测试会话里 226 条思维链被静默丢弃。
2. **给没返回的调用伪造了空输出** —— 把一个待定调用变成了凭空多出来的已完成调用。
3. **加载失败的附件变成幽灵消息** —— zcode 把读不出来的附件存成 `url: ''` 的 file part，读回来就是一条空的用户消息。
4. **一条消息被拆成两条** —— 同时带文字和图片的消息被写成两个 part，读回来变成两条消息。

---

## 命令参考

```
harness-transfer list <source>                     列出源侧全部会话
harness-transfer inspect <source> <id>            显示单个会话的构成
harness-transfer convert <source> <to> [选择器]   转换
```

| 选择器 | 含义 |
|---|---|
| `<id>` | 按 id 指定单个会话，或直接给 `.jsonl` 路径 |
| `all` | 源侧全部会话 |
| `--last N` | 最近更新的 N 个 |

| 选项 | 作用 |
|---|---|
| `--commit` | 真正写入（默认只预演） |
| `--dir <path>` | 覆盖目标里记录的工作区目录 |
| `--root <path>` | 覆盖目标写入根目录 |
| `--from-root <path>` | 覆盖源读取根目录 |
| `--json` | 机器可读输出（所有进度信息走 stderr） |
| `--strict` | 把警告也当失败 |
| `--no-verify` | 跳过读回校验（不建议） |

---

## 安全性

- **默认 dry-run。** 不加 `--commit`，一个字节都不会写。
- **写 zcode 数据库前自动备份**，整个插入在单个事务里执行，失败自动回滚。
- **文件类目标只增不改** —— 既有会话永远不会被修改。
- **源 id 记录在目标元数据里**（`migratedFrom` / `sourceSessionId`），每个迁移过来的会话都可追溯。
- 迁入 zcode 前请先关掉它：它持有数据库的 WAL 锁。

---

## 测试

```bash
npm test
```

十个用例覆盖：各适配器的无损往返、ULID 合法性、结果先于调用出现、没有结果的调用不被补全、未确认时拒绝写入、校验器能抓出人为截断、空会话、中文/emoji/引号/反斜杠/围栏代码块，以及孤儿工具输出的保留。

真实数据实测 —— 六个方向全通，220 次迁移，零内容丢失：

```
workbuddy → codex    34/34        codex → workbuddy    8/8
workbuddy → zcode    34/34        codex → zcode        8/8
zcode     → workbuddy 68/68       zcode → codex       68/68
```

---

## 扩展

加第四个 harness 只需要写一个读、一个写：

- 一个产出 IR 的读适配器（`src/adapters/workbuddy.js` 是最简单的一个，约 200 行）
- 一个消费 IR 的写适配器

如果你的 harness 和三者中某个格式相同，直接复用现有适配器即可。工具名目前在各 harness 之间**不做翻译**，你可能需要为目标端准备一张重命名映射表。

---

## 已知边界

- **图片是按引用迁移，不是按内容。** WorkBuddy 把图片存在 `~/.workbuddy/blobs/` 下，只有 `blob_id` 会保留下来。不认这个 id 的目标 harness 就显示不出图。要真正搬运图片，得另外做 blob 复制加目标格式的附件上传。
- **不含二进制、不含检查点、不含 todo 状态。** 只迁移对话内容：消息、思维链，以及带输入输出的工具调用。
- **Codex 的 `encrypted_content` 无法解密**成明文。
- **工具名不做翻译。** `Bash` 调用迁移过去还是 `Bash`；目标 harness 若期望 `shell_command`，大部分工具仍能工作，但可能需要一张重命名表。
- 只有一个 harness 才懂的那部分元数据（权限规则、线程设置、world state）不会跨格式携带。

---

## 许可证

MIT © 2026 [Nanawwa](https://github.com/Nanawwa)

---

<p align="center">
  <sub>Read in English: <a href="README.md">English</a></sub>
</p>
