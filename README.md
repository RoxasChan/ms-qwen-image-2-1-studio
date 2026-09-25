# Qwen-Image-2.1 Studio

<p>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-success.svg">
</p>

一个跑在自己电脑上的 Qwen-Image 生图工作台。整个后端只用 Node.js 内置模块写成，**零第三方依赖** —— 不需要 `npm install`，克隆下来就能直接启动。

作者：**Roxas Chan** · 邮箱：[6800400@qq.com](mailto:6800400@qq.com)

在浏览器里完成 **文生图 / 图生图 / 图像编辑** 三类任务。内置「提示词优化器」：把 Qwen 官方提示词规范原文当作 system prompt 交给大模型，你写中文想法，它按官方规范改写成可以直接提交的英文提示词。

---

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [界面与使用](#界面与使用)
- [项目结构](#项目结构)
- [尺寸预设](#尺寸预设)
- [实测得出的 API 约束](#实测得出的-api-约束)
- [提示词优化](#提示词优化)
- [HTTP 接口](#http-接口)
- [数据与安全](#数据与安全)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [许可证](#许可证)
- [贡献](#贡献)

---

## 功能特性

| 能力 | 说明 |
|---|---|
| **文生图 (t2i)** | 输入提示词直接出图，可调尺寸、步数、引导强度、随机种子 |
| **图生图 (i2i)** | 上传参考图 + 提示词，在参考图基础上重新生成 |
| **图像编辑 (edit)** | 用 `<image1>` `<image2>` 标签指名要改的图与要改的属性，只改点名部分 |
| **提示词优化** | 加载官方规范作为 system prompt，多轮对话式改写；自动识别 t2i / edit 场景；超长自动压缩重试 |
| **生图历史** | 每张图落盘保存，完整记录提示词、尺寸、步数、种子等参数；支持下载、复制提示词、删除 |
| **余额查询** | 直接查 ModelScope 魔豆余额，避免提交后才发现额度不足 |
| **零依赖** | 无 `node_modules`，无构建步骤，无锁文件；只用 `http` / `https` / `fs` / `path` / `crypto` |

---

## 环境要求

- **Node.js >= 18**（开发与实测环境为 v22）
- 一个 **ModelScope API Key**（[modelscope.cn](https://modelscope.cn) → 个人中心 → 访问令牌，形如 `ms-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
- 一个现代浏览器

> ⚠️ **这是一个 Node.js 项目，不是 Python 项目。** 请不要执行 `python server.js` —— 那只会得到一个 `SyntaxError: invalid character '—'`，因为文件首行注释里有中文破折号。

---

## 快速开始

### 1. 获取代码

```bash
git clone <your-repo-url> MS_QwenImage2.1
cd MS_QwenImage2.1
```

### 2. 启动

不需要安装任何依赖，选一种方式即可：

**Windows（推荐）** —— 双击 `start.bat`。脚本会自动切到自身目录、检查 Node 与端口、延迟打开浏览器，端口被占用时会提示是否复用已运行实例。

**任意平台：**

```bash
node server.js
# 或
npm start
```

自定义端口：

```bash
# Linux / macOS
PORT=8080 node server.js

# Windows CMD
set PORT=8080 && node server.js

# Windows PowerShell
$env:PORT=8080; node server.js
```

启动后控制台会打印监听地址，默认 **http://127.0.0.1:5178**。

### 3. 打开界面并配置 Key

浏览器访问 <http://127.0.0.1:5178>，进入左侧 **「个人信息」** 页填入 API Key，点「校验」确认可用后保存。

也可以跳过界面，手工配置文件（见下一节）。

停止服务：Windows 双击 `stop.bat`（会按端口反查并结束进程）；其他平台 `Ctrl+C`。

---

## 配置说明

配置存在 `data/config.json`，**该文件已被 `.gitignore` 忽略**（含密钥，切勿提交）。首次运行若不存在会自动创建。

从模板复制一份即可：

```bash
cp data/config.example.json data/config.json
```

结构：

```json
{
  "apiKey": "ms-你的-modelScope-密钥",
  "optimizer": {
    "mode": "local",
    "apiKey": "",
    "baseUrl": "https://api-inference.modelscope.cn/v1",
    "model": "Qwen/Qwen3-8B"
  }
}
```

| 字段 | 说明 |
|---|---|
| `apiKey` | ModelScope 访问令牌。**出图与提示词优化都依赖它**（除非优化器单独配了 Key） |
| `optimizer.mode` | 保留字段，当前后端未读取其取值，界面上作为标签展示 |
| `optimizer.apiKey` | 可选。只给「提示词优化」用的 Key；留空则回退到顶层 `apiKey` |
| `optimizer.baseUrl` | 可选。OpenAI 兼容的 chat completions 端点，默认 ModelScope |
| `optimizer.model` | 可选。用于改写提示词的对话模型，默认 `Qwen/Qwen3-8B` |

`baseUrl` 可以指向任何 OpenAI 兼容服务（本地 Ollama、其他厂商网关等），只要该端点支持 `/chat/completions`。

---

## 界面与使用

左侧四个视图：

### 创作台（Studio）

顶部三个模式页签：**文生图 / 图生图 / 图像编辑**。

- 提示词、负向提示词
- 尺寸预设下拉（10 个实测可用值，见下表）
- 步数、引导强度（guidance）、随机种子、输出格式、水印开关
- 图生图与编辑模式下可拖入 / 多选参考图（最多 10 张）
- 提交后按钮进入轮询状态，出图自动落盘并写入历史

尺寸旁会显示字符计数，超过 4000 字符时高亮告警。

### 提示词优化（Chat）

对话式界面：描述你想要的画面 → 拿到符合官方规范的英文提示词 → 不满意可以继续追加要求迭代。识别到编辑场景时会自动在指令前注明输入图数量，让模型正确使用 `<imageN>` 标签。

> 此功能会调用大模型，**必须先配置 API Key**。

### 生图历史（History）

按时间倒序展示全部产出，每张卡片显示缩略图、提示词与参数标签（尺寸 / 步数 / cfg / seed / 格式），支持下载、复制提示词、删除。

若某条记录对应的图片文件已不在 `outputs/` 中，卡片会显示「图片文件已丢失」占位块并**禁用下载**，但**提示词与参数仍完整保留**（详见[数据与安全](#数据与安全)）。

### 个人信息（Profile）

API Key 的填写、校验、清除与余额查询，以及优化器引擎配置。Key 在界面上始终以掩码形式回显（仅显示前 6 位与后 4 位）。

---

## 项目结构

```
MS_QwenImage2.1/
├── server.js                 # 后端全部逻辑：静态托管 + API 代理 + 文件读写（零依赖）
├── package.json              # 仅用于声明 npm start 与 engines，无依赖
├── start.bat / stop.bat      # Windows 一键启动 / 停止
├── LICENSE                   # Apache-2.0 全文
├── NOTICE                    # 版权与第三方归属声明
├── public/                   # 前端 SPA（无框架、无构建）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/
│   ├── config.example.json   # 配置模板（可提交）
│   ├── config.json           # 真实配置，含密钥（已忽略，勿提交）
│   ├── history.json          # 生图历史元数据（已忽略）
│   ├── history.bak.json      # 历史覆盖写前的自动滚动备份（已忽略）
│   └── rules/                # 官方提示词规范，运行时作为 system prompt
│       ├── official_t2i.md   # 文生图改写规范
│       └── official_edit.md  # 图像编辑指令增强规范
└── outputs/                  # 生成的图片，命名 yyyymmdd####.png（已忽略，启动时自动创建）
```

`data/rules/` **必须随仓库分发** —— 后端运行时直接读取它们；`outputs/` 则不需要，服务启动会自动创建。

---

## 尺寸预设

界面上可选的 10 个尺寸，全部满足「单边 ≤ 2048 且为 16 的倍数」：

| 比例 | 尺寸 | 比例 | 尺寸 |
|---|---|---|---|
| 1:1 | 1024 × 1024 | 2K 1:1 | 2048 × 2048 |
| 2:3 竖版 | 1024 × 1536 | 2K 2:3 竖版 | 1360 × 2048 |
| 3:2 横版 | 1536 × 1024 | 2K 3:2 横版 | 2048 × 1360 |
| 16:9 宽屏 | 1536 × 864 | 2K 16:9 | 2048 × 1152 |
| 9:16 手机 | 864 × 1536 | 2K 9:16 手机 | 1152 × 2048 |

> 常见的 **2048 × 3072 是非法的** —— 单边 3072 已超过 2048 上限，会被接口拒绝。想要更大画幅需在出图后另行超分。

---

## 实测得出的 API 约束

这部分是本项目踩坑后固化的结论，**与官方文档存在出入**，按实测为准：

| 参数 | 官方文档说法 | 实测结论 |
|---|---|---|
| `prompt` 长度 | 2000 字符 | **实际可到 4000 字符**。本项目以 4000 为硬上限，3200 为安全目标（超出会自动追加压缩指令重试一次） |
| 尺寸传参 | `width` / `height` | **只认 `size: "WxH"` 字符串**。传 `width`/`height` 会被**静默忽略**，模型退回默认纵向比例 **760 × 1280**，且不报错 |
| 尺寸范围 | — | 单边 **64 ~ 2048**（是单边上限，**不是总像素上限**），且必须为 **16 的倍数** |
| 参考图数量 | — | 最多 **10** 张（超出会被截断） |
| `guidance_scale` | — | 默认 **1** |
| 任务模式 | — | 两段式异步：`POST /v1/images/generations` 拿 `task_id`，再轮询任务状态取结果 URL |

因为「传错参数不报错、只是悄悄换尺寸」，服务端会在保存图片时**读取 PNG 真实像素**并与请求值比对，不一致就在历史里标记，避免你以为出了 2K 图、实际拿到 760×1280。

---

## 提示词优化

核心思路：**不自己造规则，直接把官方规范原文当 system prompt 喂给模型。**

- `data/rules/official_t2i.md` → 文生图规范
- `data/rules/official_edit.md` → 图像编辑规范

后端 `readRule()` 读取文件内容，作为 `system` 消息发出，不做任何转述或摘要 —— 转述必然引入偏差。规范文件是英文长段描述，包含开篇句 / 方位描述 / 光线句 / 收尾总括句的结构要求。

优化返回结构化 JSON，服务端做**五级解析兜底**：剥离 markdown 围栏 → 直接解析 → 提取最外层 `{...}` → 修复字符串内未转义的换行 → 正则抽取字段。这样即便模型不听话地加了前言后语，也能拿到结果。

编辑模式下会额外告知模型本次输入图片数量，确保它使用正确的 `<imageN>` 标签。

---

## HTTP 接口

后端所有接口都在同一个端口下：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 前端页面（以及 `/app.js`、`/style.css`） |
| `GET` | `/outputs/*` | 已生成的图片 |
| `GET` | `/api/config` | 读取配置（Key 以掩码返回，**不回传明文**） |
| `POST` | `/api/config` | 保存 Key 与优化器配置 |
| `POST` | `/api/verify` | 校验 Key 是否可用 |
| `GET` | `/api/balance` | 查询魔豆余额 |
| `POST` | `/api/generate` | 提交生图任务，返回 `taskId` |
| `GET` | `/api/task?id=` | 轮询任务状态 |
| `POST` | `/api/save` | 下载结果图片落盘并写入历史 |
| `GET` | `/api/history` | 读取历史列表 |
| `DELETE` | `/api/history/:id` | 删除某条记录（可选是否连图片一起删） |
| `POST` | `/api/optimize` | 提示词优化 |
| `GET` | `/api/rules` | 查询两个规范文件是否就位 |

请求体上限 60 MB（参考图以 dataURL 提交，需要较大余量）。静态文件服务做了路径穿越防护。

---

## 数据与安全

- **API Key 只存在本地** —— 存于 `data/config.json`，不会发往除你配置的 API 端点之外的任何地方。接口回传时一律掩码。
- **`data/config.json` 已被 `.gitignore` 忽略**，且有 `config.example.json` 模板。提交前建议再 `git status` 确认一次。
- **历史元数据永不自动删除** —— 历史记录里的提示词、参数、种子是不可再生的，图片丢了还能重出，参数丢了就永远没了。因此 `GET /api/history` 只**标记** `missing: true`，绝不剪枝；删除一律走 `DELETE` 显式操作。
- **覆盖写前自动备份** —— 历史文件每次写盘前会先留一份 `history.bak.json`，任何误写都能回退一步。
- 服务默认只监听本机。**不要直接暴露到公网** —— 它没有鉴权层，任何能访问端口的人都能拿到你的 Key 状态并消耗你的额度。

---

## 常见问题

**运行 `python server.js` 报 `SyntaxError: invalid character '—'`？**
用错解释器了。这是 Node.js 项目，请执行 `node server.js`。

**出图尺寸和请求的不一致？**
参见[实测约束](#实测得出的-api-约束)：`width`/`height` 会被静默忽略。用界面上的预设即可，它们都是合法值。

**提示词优化报「需要调用大模型，请先填写 API Key」？**
优化功能必须走大模型，请配置 Key（或把 `optimizer.baseUrl` 指向本地模型服务）。出图则仅依赖顶层 `apiKey`。

**历史里的图显示「图片文件已丢失」？**
`outputs/` 里对应文件不在了。提示词与参数仍然完整保留，可以按原参数重出 —— 这也是刻意不做自动清理的原因。

**端口被占用？**
`start.bat` 会识别占用进程并让你选择；或改 `PORT` 环境变量启动。

---

## 已知限制

- 一次只能串行提交与轮询一个任务，没有并发队列
- 生图历史全量读入内存后渲染，条目极多时（数千条以上）前端会变慢
- 无多用户与鉴权，设计上就是本机单用户工具
- 不支持 LoRA、ControlNet 等附加能力（接口参数已预留但未接界面）
- 图片无法在界面上直接二次编辑，需下载后处理

---

## 许可证

本项目以 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)。

```
Copyright 2026 Roxas Chan <6800400@qq.com>
```

| | |
|---|---|
| 作者 | Roxas Chan |
| 邮箱 | [6800400@qq.com](mailto:6800400@qq.com) |
| 许可证 | Apache License 2.0 |

### 第三方归属

- **Qwen-Image-2.1** 模型与推理服务 —— 阿里云通义实验室，经 ModelScope 提供，Apache License 2.0
- **data/rules/** 下的两份官方提示词规范 —— 转载自 Qwen 官方提示词指南，版权归原作者所有，此处用于作为提示词优化的 system prompt

详见 [NOTICE](NOTICE)。

服务本身不附带任何第三方 npm 包，因此没有其他依赖许可需要传递。

---

## 贡献

欢迎 Issue 与 PR。提交前请留意：

- 后端请保持**零第三方依赖** —— 这是本项目的核心取舍，不要为小功能引入依赖
- `start.bat` / `stop.bat` 必须满足：内容**纯 ASCII**、行尾 **CRLF**、**无 BOM**。中文注释会在中文 Windows 的 GBK 代码页下乱码
- 不要把 `data/config.json`、`data/history.json` 或 `outputs/` 提交进来
- 若官网更新了提示词规范，请同步替换 `data/rules/` 下的文件，并在 PR 说明中注明来源版本
