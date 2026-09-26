# Exa Search

给 HanaAgent 的 Agent 加一把语义搜索：用 Exa 的神经检索按意思找，而不只是按关键词。

它是一个 **tool-only 的 v2 App**（没有卡片、没有页面），只做一件事：往宿主的工具注册表里放一个 `exa_search`。

## 它和内置搜索的区别

宿主的 `web_search` 走关键词检索（AnySearch / Tavily / Brave / Serper）加浏览器兜底。Exa 走的是另一套：
把查询编码成向量，按语义相似度找。所以「找那种讨论某某思路的文章」这类问题它更擅长，
「今天 X 是多少」这类精确事实它反而不如关键词检索直接。

两个东西是分工，不是替换，也**没有优先级排序**：宿主不会「先试 A、不灵再试 B」，
它只是把两件工具一起摆在模型面前，模型读描述自己挑。所以天平到底怎么斜，
几乎完全由两段工具描述决定——这一段值得写准。现在的分工在描述里是这么说的：

| 用 `web_search` | 用 `exa_search` |
| --- | --- |
| 精确事实、当日动态、某个具体页面 | 说不准该用什么词、想按意思捞相关内容 |

另有一层现实差别：`web_search` 是模型随身可调的工具，`exa_search` 要先被检索发现才调得到。
所以默认路径总是前者，Exa 需要在描述里主动争取出场——这也意味着描述里的措辞
（尤其是「什么时候用它」那一句）比它听起来更重要。

## 装它

```
<HANA_HOME>\apps\exa-search\
```

1. 把整个 `exa-search` 目录复制到上面那个路径（`HANA_HOME` 通常是 `C:\Users\<你>\.hanako`）。
2. 重启 Hana。
3. 在 市场 → 已安装 → App 类目的「待批准」里批准它。

**还有一道开关容易漏：** 批准只是让它装上了。要让模型能主动调用 `exa_search`，
还得去 设置 → 安全 → 应用能力，把 **Exa Search** 的开关打开。
这个开关默认关闭，而且宿主每次调用前都重新查一遍，关掉立即生效。

## 配它

设置 → 应用 → Exa Search：

| 字段 | 渲染在哪 | 干什么 |
| --- | --- | --- |
| `apiKey` | 检索设置 | Exa 的 API Key，在 dashboard.exa.ai 的 API Keys 页创建。**必填** |
| `defaultNumResults` | 检索设置 | 模型没指定条数时用几，默认 5 |
| `defaultSearchType` | 检索设置 | neural 纯语义 / keyword 纯关键词 / auto，默认 auto |
| `includeTextByDefault` | 检索设置 | 是否每次都抓网页正文，默认关（开着更贵也更长） |
| `defaultMaxCharacters` | 检索设置 | 抓正文时每条保留多少字符，默认 2000 |
| `highlightsMaxCharacters` | 检索设置 | 每条结果的高亮字符上限，默认 1000。填 0 表示不设限 |
| `blocklistEnabled` | 屏蔽名单 | 域名屏蔽总闸，默认开 |
| `blockedDomains` | 屏蔽名单 | 手写屏蔽名单，默认空。逗号分隔，详见下节 |

设置页是自定义页面（`contributes.settings.ui`），所以还多了一整块「内容农场屏蔽名单」，见下节。
上面的字段都在同一个页面里渲染，保存按钮在右下角。

### 设置页的两处实现说明

**开关、手写名单、订阅名单在同一节，顺序就是它们的关系。** `blocklistEnabled` 与
`blockedDomains` 虽然都是普通 schema 字段，但渲染时都被排出了「检索设置」那一节，改放到
「内容农场屏蔽名单」，顺序是：

```
启用内容农场屏蔽   ← 总闸
永久屏蔽的域名     ← 它控制的手写名单
订阅链接 + 操作   ← 它控制的订阅名单
当前名单           ← 上面那份的整体状态
```

理由是三者说的是同一件事。尤其 `blockedDomains`：它是普通字段，很容易被当成普通设置留在
「检索设置」里，但那样读者要跳两节才能弄清「那个开关到底管什么」。

这个开关管的是**两份持久名单**（手写 + 订阅），**不影响**工具参数里 `excludeDomains` 的
临时排除——后者是调用方对单次检索的明确意图，不属于「屏蔽名单」这个开关的语义。

**分隔线靠一条局部覆盖。** 官方控件对「上下堆叠」布局的栏（长文本字段用的是这种）
故意不画分隔线，规则是 `.e.b + .e::before, .e + .e.b::before { display: none }`。
本页希望每栏之间都有线，所以在 `ui/settings.html` 里用同样特异度 + `!important` 把它覆盖了回来。
这里用到的是官方 CSS 的压缩类名（内部选择器），不承诺跳版本稳定，所以
`tests/tool.test.mjs` 里有一对测试守着：上游那条抑制规则还在、本页的覆盖也在。
升级 SDK 时若分隔线又不见了，先看那对测试。

Exa 的 REST API 没有匿名额度，必须自己申请 Key。这个 App 只把 Key 存在宿主自己的设置表里，
除了 `api.exa.ai` 不出门。

## 屏蔽内容农场

设置里的 `blockedDomains` 是**永久名单**，每次调用都自动带上。它和工具参数里的 `excludeDomains`
是两回事：后者只影响那一次调用，留给模型临时收窄范围；前者是你维护的底线。两边会合并去重。

```
theoncetimes.com,farm-example.net
```

逗号、分号、换行都当分隔符（设置框是单行的，所以实用写法是逗号）。`#` 之后当注释丢掉，
方便记下为什么把某个站点列进来。

### 只写域名，其余的会被裁掉

整条网址、`www`、路径、端口、大写，都会被裁成小写裸域名：

| 你写的 | 实际发出去的 |
| --- | --- |
| `https://theoncetimes.com/ai/some-long/article` | `theoncetimes.com` |
| `http://www.Farm-Example.NET:8443/x?q=1` | `farm-example.net` |
| `*.sub.example.com` | `sub.example.com` |
| `example.com` 与 `www.example.com` | 归为同一条 |

**裁掉路径是故意的。** Exa 允许「主机名 + 路径前缀」的写法（`example.com/docs`），
但那只屏蔽该路径，域名本身照旧出现。实测：`excludeDomains` 写 `arxiv.org/html`，
arxiv.org 的 `/abs` 页面照样返回。手写的黑名单要的是整站屏蔽，留下路径就等于
「以为屏蔽了、实际没屏蔽」，而这件事不会报错。需要路径级排除时用调用参数。

裸域名本来就覆盖子域（实测：屏蔽 `vldb.org` 后 `www.vldb.org` 一起消失），
所以 `www` 与 `*.` 都是冗余的，裁掉。

### 两个 category 下会自动跳过

Exa 的 `company` 与 `people` 两个 category **不支持** `excludeDomains`。文档只说会报 400，
实测更麻烦：

| category | 带过滤时的实际反应 |
| --- | --- |
| `company` | HTTP 200，但**静默返回 0 条**，看起来像「没找到」 |
| `people` | HTTP 400 |

所以这两类下会**整个跳过**屏蔽名单，并在结果里附一句说明。不这样做的话，
你往名单里加一个域名，`company` 搜索就静默变成空的了。

### 写错的条目会报出来

不像域名的条目（`localhost`、打错的字、带 `@` 的东西）会被剔除，但不会默默消失：
宿主日志里会记一条警告，工具的 `details.blacklistRejected` 里能看到原始文本。
一个字符写错就让整条屏蔽失效，而这种失败本身不会报错，所以才要把它抬到明面上。

## 订阅 uBlock Origin 格式的名单

设置页的「内容农场屏蔽名单」区可以填一个订阅链接，点「更新名单」抓取并解析。
抓下来的规则存在本机（`<HANA_HOME>/app-data/exa-search/blocklist.json`），以后每次检索自动生效。

默认预填的是 [Content Farm Terminator](https://danny0838.github.io/content-farm-terminator/)
的 uBO 名单。它是**抓取时**才去拉的，不是随包分发。

### 解析哪三类规则

| uBO 写法 | 怎么用 |
| --- | --- |
| `example.com`、`1.2.3.4` | 整站屏蔽（裸域名覆盖子域） |
| `||example.com^` | 同上 |
| `||example.com/path^` | 只屏蔽该路径（带边界，不会把 `/newsletter` 当 `/news`） |
| `/正则/$doc` | 在本机对结果 URL 求值 |

### 丢掉哪三类，以及为什么不用近似

| uBO 写法 | 为什么不用 |
| --- | --- |
| `||wild.*.com^` | 按主机名匹配的表达不了通配 TLD |
| `##` / `#@#` / `#?#` / `#$#` | 元素隐藏与脚本注入，与网络检索无关 |
| `nosuffix` 这种无后缀裸词 | 多半是笔误 |

丢掉的数量会如实显示在设置页和更新后的提示里（那份默认名单里有 126 条），**不静默吞掉**。
方向很重要：把不支持的规则硬估成一个近似域名，得到的是「以为屏蔽了、实际没有」，
而那种失败不会报错。

### 一个很容易踩的解析细节

`#` 在 uBO 格式里既是行内注释，也出现在正则的字符类里（`(?=[/?#]|$)`）。
那份默认名单里有 **3217 行**属于后者——把它们当注释切掉，等于静默丢掉 3217 条规则。
所以解析时只剥离「空格 + #」形式的注释，裸 `#` 一律不碰。

### 另一个很容易踩的匹配细节

路径规则（`||host/path^`）必须按「裸域名覆盖子域」的方式匹配主机，不能拿完整主机名去比。
否则 `ettoday.net/dalemon` 匹配不上 `https://www.ettoday.net/dalemon/123`，而真实 URL 大量带
`www`，路径规则基本全失效。实测就是这麽发现的：当时 `https://ettoday.net/dalemon` 拦住了，
`https://www.ettoday.net/dalemon/123` 却没拦住。

### Exa 的 1200 条硬闸，与本机兜底

Exa 的 `excludeDomains` **最多 1200 条**（实测：1200 通过，1201 直接报
`The total number of excludeDomains must not exceed 1200`）。而一份内容农场名单动辄上万个域名
（那份默认名单解析出 **17185 个域名 + 13 个 IP + 4 条路径规则 + 3220 条正则**）。

所以采用两层：

1. **发给 Exa**：手写名单最优先，其次本次临时参数，最后订阅大名单，满 1200 就停。
   这一层的作用是提高召回质量，被截断不影响正确性。
2. **本机兜底**：拿到结果后，用**全部**规则再滤一遍。域名、子域、路径、正则都在这一层生效。

本机过滤会吃掉一些候选，所以名单够长（≥ 50 条）时会向 Exa 多要几倍结果（默认 3 倍，上限 100 条），
滤完再取前 `numResults` 条。名单很短时不多要——那种情况下命中概率极低，多要的部分纯属浪费
（Exa 超过 10 条开始按页计费）。

### 两个 category 会跳过 Exa 侧过滤

`company` 与 `people` 不支持 `excludeDomains`（实测 `company` 是静默返回 0 条、`people` 报 400），
这两类下会跳过 Exa 侧的屏蔽并在结果里声明，**但本机过滤照常生效**。

名单超过 1200 条会被截断（Exa 的数组上限），同样记警告。

## 工具参数

`exa_search(query, numResults?, type?, category?, includeDomains?, excludeDomains?, startPublishedDate?, endPublishedDate?, includeText?, maxCharacters?)`

只有 `query` 必填。默认返回标题、链接和高亮片段；要读全文就把 `includeText` 打开。
只写日期时（`2025-01-01`）会自动补足时分秒，省得「到某天为止」那一侧整天落空。

### 关于高亮长度

Exa 早年有一个 `numSentences` / `highlightsPerUrl` 的写法，现在已经废弃，官方文档把它放进了
「常见错误」对照表，现行参数只有 `contents.highlights.maxCharacters`。这个 App 用的就是后者，
所以设置里叫 `highlightsMaxCharacters` 而不是那两个名字。

不设上限时 Exa 会按相关性自行分配长度，实测单条能吐三四千字，五条结果就能吃掉不少上下文窗口。
默认的 1000 字符对「判断这条结果要不要读」这个尺度的用途完全够用——Exa 自己的评测里，
500 字符的高亮在准确率上顶得上 8000 字符的全文。要看更多原文时用 `includeText` 单独打开。

如果哪天觉得每次高亮还是太长，Exa 还有一个 Dynamic Highlights 的研究预览（动态分配整个结果集的
总量，强源多给、重复的少给，实测省 95% token）。它需要额外的 `Exa-Beta` 请求头，目前没接。

### 被截断的高亮会标省略号

Exa 按字符切高亮，不按句子切，所以切点常落在句中。贴到上限且断在句中时，
那条高亮末尾会补一个 `…`，输出末尾附一句说明。

判断要两个信号同时成立：总长度到达上限的九成以上，**且**末段结尾不在句读上。
之所以不只靠长度：上限 3000 时实测有一条只到 2784，但它结尾是完整的 `2025).`，
属于自然收尾，不该被标记。

## 结构

```
manifest.json        身份、能力、网络白名单、静态工具声明、设置表
index.js             工具与后端路由：拼请求、调 Exa、解析名单、本机过滤、排版结果
ui/settings.html     自定义设置页（宿主用 contributes.settings.ui 替代通用表单）
ui/settings.js       设置页逻辑：读 schema、存配置、更新名单
ui/assets/           随页面加载的宿主控件与主题兜底
assets/icon.svg      应用图标：白底 + Exa 品牌徽记（#0143D9）
sdk/                 随包携带的 App SDK，离线装载用，不要手改
tests/               本地行为测试
```

图标取自 Exa 官方横排字标（413×129）。整条字标放进方形图标，在侧栏的 14px 上会糊成
一条灰线，所以只取徽记部分，按高度缩到画布 65% 居中。缩放上限由宿主圆角定：徽记的
半对角线要落在 squircle 的安全半径内，放大会被裁到角。

### 一个需要注意的重复

App 用 `activation.mode: "on-demand"` 启动：没被调用之前进程不跑，模型看到的是
`manifest.json` 里 `activation.tools[0]` 那份**静态声明**。所以工具的 `description`
和 `parameters` 在 `manifest.json` 与 `index.js` 各写了一份，改一处要改两处。

`tests/tool.test.mjs` 里有一条测试专门守住这件事，两边不一致就会失败。

## 本地验证

```bash
node tests/tool.test.mjs
```

74 条测试，覆盖：清单与运行期注册的一致性、请求体拼装与边界（含高亮上限与截断判定）、
uBO 名单解析（含 `#` 注释陷阱与不支持项计数）、本机过滤（子域、路径边界与带 www 的真实 URL、IP、正则）、
两层过滤与 1200 上限的配合、屏蔽开关的默认值与关掉后的行为、
屏蔽节的字段归属与栏顺序、设置页分隔线覆盖与上游规则的一对守护、
结果排版与截断、HTTP 错误的中文映射。

设置页也能脱离宿主单跑（用一份桩后端的本地目录），方便调外观：
在浏览器里打开那个目录的 `index.html`，换 `?scenario=fresh|subscribed|fail` 看三种状态。

启动验证走 Hana 官方的隔离检查（在临时 AppHost 里真跑一次，不碰你的真实环境）：

```bash
node <skill>/scripts/validate_app.mjs --dir <这个目录> --smoke --json
```

## 卸载

市场 → 已安装 → Exa Search → 卸载。设置里的 Key 会跟着记录一起清掉。
