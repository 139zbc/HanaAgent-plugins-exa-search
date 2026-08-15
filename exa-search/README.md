# Exa Search（插件用户文档）

> 📦 v1.0.0 · MIT License
> 适用于 [HanaAgent](https://github.com/liliMozi/openhanako) ≥ 0.170.0

这个文档面向**实际安装使用**这个插件的人。如果你想了解**为什么**需要它、它和内置搜索的对比、架构设计，参见 [根目录 README](../README.md)。

---

## 目录

- [功能](#功能)
- [安装](#安装)
  - [准备：Exa API Key](#准备exa-api-key)
  - [步骤 1：开启 full-access](#步骤-1开启-full-access-开关)
  - [步骤 2：安装插件](#步骤-2安装插件三选一)
  - [步骤 3：启用插件](#步骤-3启用插件)
  - [步骤 4：配置 API Key](#步骤-4配置-api-key两种方式任选)
  - [步骤 5：刷新 / 重启](#步骤-5刷新-或-重启-hanaagent)
  - [验证安装成功](#验证安装成功)
- [工作原理](#工作原理)
- [故障排查](#故障排查)
- [FAQ](#faq)
- [隐私 & 安全](#隐私--安全)
- [License](#license)

---

## 功能

| | |
|---|---|
| **接管搜索** | 把 `web_search` 从 LLM 工具列表移除，注册 `exa_search` 工具代替 |
| **神经/语义搜索** | Exa `neural` 模式找内容相关但**不**匹配关键词的页面 |
| **自动回落** | Exa 失败时自动恢复 `web_search`，让 LLM 改用 Tavily/Brave |
| **三重防御** | context hook + 工具层 + straggler handler，**首次**搜索就用 Exa |

---

## 安装

### 准备：Exa API Key

1. 去 [exa.ai](https://exa.ai) 注册账号
2. 在 dashboard 拿到 API key
3. **免费档**：1000 次 / 月

### 步骤 1：开启 full-access 开关

HanaAgent **设置 → 插件** → 找到 **"允许全权插件"** 开关 → **打开**。

> ⚠️ **这个开关关着时，full-access 插件完全不会加载**（不是部分加载）。本插件是 full-access，必须开。

### 步骤 2：安装插件（三选一）

#### 方式 A：拖拽安装（最简单）

1. 打开 HanaAgent **设置 → 插件** 页面
2. 把 `exa-search/` 文件夹**直接拖进**安装区
3. 或者把整个 `exa-search.zip` 拖入

#### 方式 B：文件选择器

1. 打开 HanaAgent **设置 → 插件** 页面
2. 点击安装区 → 文件选择器
3. 选择 `exa-search/` 文件夹

#### 方式 C：手动放到 plugins 目录

把 `exa-search/` 文件夹复制到 HanaAgent 的 plugins 目录：

| 平台 | 默认路径 |
|---|---|
| Windows | `%USERPROFILE%\.hanako\plugins\exa-search\` |
| macOS | `~/.hanako/plugins/exa-search/` |
| Linux | `~/.hanako/plugins/exa-search/` |

### 步骤 3：启用插件

HanaAgent **设置 → 插件** → 找到 **Exa Search** → 打开它**自己的启用开关**（每个插件独立开关，不是 master 那个 full-access 开关）。

### 步骤 4：配置 API Key（两种方式任选）

#### 方式 A：在 HanaAgent UI 里填（推荐）

**设置 → 插件 → Exa Search → Exa API Key** 字段 → 填入 → 保存。

Key 加密存储（manifest 里 `secret: true`），重启 HanaAgent 后生效。

#### 方式 B：直接写文件

如果 UI 方式没生效（HanaAgent 0.446.6 在某些场景下读取有问题），可以绕过：

**Windows PowerShell**：
```powershell
$key = "你的-exa-api-key"
Set-Content -Path "$env:USERPROFILE\.hanako\plugin-data\exa-search\api-key.txt" -Value $key -Encoding utf8
```

**macOS / Linux**：
```bash
mkdir -p ~/.hanako/plugin-data/exa-search
echo "你的-exa-api-key" > ~/.hanako/plugin-data/exa-search/api-key.txt
```

### 步骤 5：刷新 或 重启 HanaAgent

**设置 → 插件 → 刷新** 按钮（不一定需要重启）。如果插件状态显示 `failed`，才需要完整重启 HanaAgent。

### 验证安装成功

打开 HanaAgent 主窗口，**设置 → 插件**，应该看到：

| 字段 | 期望值 |
|---|---|
| 插件名 | `Exa Search` |
| 状态 | `已加载`（不是 `failed` / `incompatible`） |
| 启用 | ✅ |
| 信任 | `full-access` |

新开一个 chat session，发任意搜索问题（例："搜索一下今天 AI 新闻"），LLM 应该用 `exa_search` 工具（**不**调 `web_search`）。

---

## 工作原理

```
1. context hook（最早触发）:
   - 注入 system note: "web_search 不可用，必须用 exa_search"
   - 调 setActiveTools 移除 web_search
   → LLM 决策时：web_search 已不在工具列表 → 直接用 exa_search

2. exa_search 工具（被 LLM 调用）:
   - 调 Exa API（POST https://api.exa.ai/search）
   - 成功 → 返回格式化结果
   - 失败 → triggerRestoreWebSearch() 加回 web_search + 返回错误信息

3. straggler handler（兜底）:
   - 如果 web_search 还是被调用了（缓存、race condition 等）
   - 拦截 + 调 Exa + 通过 pi.sendMessage steer 结果给 LLM
```

**3 个独立保险机制**，任何一层失效其他层兜底。

---

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 插件显示 `failed` | manifest 语法 / 文件损坏 | 设置 → 插件 → 诊断按钮 |
| 插件显示 `incompatible` | HanaAgent 版本太旧 | 升级到 0.170+ |
| 搜索仍走 Tavily/Brave | Exa key 没读到 | 切换到方式 B 写文件 |
| `Exa API 401` | key 无效 | 重新去 exa.ai 生成 |
| `Exa API 402/429` | 配额耗尽 | 升级 Exa 档位，或等下月重置 |
| LLM 还是调 `web_search` | full-access 开关没开 | 设置 → 插件 → 允许全权插件 |
| 提示 `extension runtime not initialized` | 时序问题（无害） | 忽略，第二次请求会正常 |
| 设置菜单里看不到插件 | 没放到正确路径 | 检查 plugins 目录路径 |

---

## FAQ

**Q: 卸载这个插件后，web_search 会恢复吗？**
会。卸载插件后，HanaAgent 重新加载 web_search 到工具列表。

**Q: 能同时用 web_search 和 exa_search 吗？**
本插件**不**支持。设计就是二选一（Exa 是默认）。如果你想临时回到 web_search，可以禁用本插件。

**Q: Exa 配额用完会怎样？**
插件**自动**恢复 `web_search` 并告诉 LLM 改用，所以你**不会**突然没法搜索。但建议去 exa.ai 升级档位避免再次触发回落。

**Q: `cache_contract_violation` 错误要紧吗？**
不要紧。这是 setActiveTools 改工具列表的正常副作用（Pi SDK 检测到 tool schema 变化），warn 级别，不影响功能。

**Q: 性能影响？**
context hook 每次 LLM 请求都跑（约 1-2ms），注入 system note 也只是追加文本，**不**会导致明显的 prompt cache miss（note 注入在 messages 层面，跟 system promptBytes 是不同维度）。

**Q: 怎么调试？**
查看 `C:\Users\<你>\.hanako\logs\<日期时间>.log`，搜 `exa-search` 看 plugin 加载情况，搜 `web_search`/`exa-search_exa_search` 看工具调用。

---

## 隐私 & 安全

| 数据 | 存储位置 | 加密 | 备注 |
|---|---|---|---|
| Exa API key | `%USERPROFILE%\.hanako\plugin-data\exa-search\config.json`（secret: true） | ✅ HanaAgent 内置加密 | 优先方式 |
| Exa API key（fallback） | `%USERPROFILE%\.hanako\plugin-data\exa-search\api-key.txt` | ❌ 明文（chmod 600 by user） | 当 UI 方式失效时 |
| 搜索查询 | 通过 HTTPS 发到 api.exa.ai | ✅ TLS | 走的是 Exa 的 API，不经过第三方 |

**承诺**：
- 本插件**不**上传、收集、记录任何用户数据
- 搜索查询直接发到 Exa（TLS），**不**经过我们任何服务器
- API key 仅在用户机器本地存储，**不**外传

---

## License

MIT
