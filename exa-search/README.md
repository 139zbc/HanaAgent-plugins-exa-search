# Exa Search (插件)

> 📦 v1.0.0 · MIT License
> 适用于 [HanaAgent](https://github.com/liliMozi/openhanako) ≥ 0.170.0

用 Exa 的神经搜索引擎替代 HanaAgent 内置的 `web_search`（Tavily / Brave / Serper / AnySearch）。

## 功能

- **接管搜索**：把 `web_search` 从 LLM 工具列表移除，注册 `exa_search` 工具代替
- **神经/语义搜索**：Exa 的 `neural` 模式支持语义相似搜索（找内容相关但不包含原关键词的页面）
- **自动回落**：Exa 调用失败时，自动恢复 `web_search` 并提示 LLM 改用
- **三重防御**：即使 LLM 仍调用 `web_search`，也会被劫持到 Exa 并投递结果

---

## 安装

### 准备：Exa API Key

先去 [exa.ai](https://exa.ai) 注册一个账号，在 dashboard 拿到 API key（免费档 1000 次/月）。

### 步骤 1：开启 full-access 开关

HanaAgent **设置 → 插件** → 找到 **"允许全权插件"** 开关 → **打开**。

> 这个开关关着时，full-access 插件**完全不会加载**（不是部分加载）。本插件是 full-access，必须开。

### 步骤 2：安装插件（三选一）

#### 方式 A：拖拽安装（最简单）

1. 打开 HanaAgent **设置 → 插件** 页面
2. 把 `exa-search/` 文件夹**直接拖进**安装区
3. 或者打包成 `.zip` 后拖入

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

HanaAgent **设置 → 插件** → 找到 **Exa Search** → 打开它**自己的启用开关**（每个插件独立开关）。

### 步骤 4：配置 API Key（两种方式任选）

#### 方式 A：在 HanaAgent UI 里填（推荐）

设置 → 插件 → Exa Search → **Exa API Key** 字段 → 填入 → 保存。

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

### 步骤 5：重启 HanaAgent

设置 → 插件 → **刷新** 按钮（不一定需要重启）。如果插件状态显示 `failed`，才需要完整重启 HanaAgent。

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
1. context hook（最早）: 注入 system note + 移除 web_search
   → LLM 决策时 web_search 已不在工具列表 → 直接用 exa_search
2. exa_search 工具: 调 Exa → 成功返回 / 失败恢复 web_search
3. straggler handler（兜底）: 万一 web_search 漏网 → 劫持到 Exa
```

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

## License

MIT
