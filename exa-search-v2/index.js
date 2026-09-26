import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "exa-search";

/** Exa 的检索接口。清单里 network.allowedHosts 只放行这一个主机。 */
const SEARCH_ENDPOINT = "https://api.exa.ai/search";
const SEARCH_TYPES = ["auto", "neural", "keyword"];

const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_MAX_CHARACTERS = 2000;
/**
 * 每条结果返回的高亮字符上限。
 *
 * Exa 早年的 numSentences / highlightsPerUrl 已被弃用，官方现在只认
 * contents.highlights.maxCharacters。不设上限时 Exa 会按相关性自行分配，
 * 实测单条能吐三四千字，五条结果就能把上下文吃掉一大块。
 * 设为 0 表示交回 Exa 自己决定。
 */
const DEFAULT_HIGHLIGHTS_MAX_CHARACTERS = 1000;
const MIN_HIGHLIGHTS_CHARACTERS = 100;
const MAX_HIGHLIGHTS_CHARACTERS = 20000;
/**
 * 判断一条高亮是否被上限切掉时，"贴着上限"的阈值。
 *
 * 实测（上限 300 → 290/297/288；1000 → 994/995/995；3000 → 2977/2989/2784），
 * 被切的那几条都吃满了九成以上。
 */
const HIGHLIGHT_NEAR_CAP_RATIO = 0.9;
/**
 * Exa 对 includeDomains / excludeDomains 的数组上限。
 *
 * 实测：1200 条通过，1201 条报 HTTP 400「The total number of excludeDomains must
 * not exceed 1200」。这是硬闸，超过整个请求就废了，所以这里先截断并记警告。
 */
const DOMAIN_LIST_MAX = 1200;
/**
 * Exa 单次能返回的结果条数上限。本地过滤要over-fetch 时以它为界。
 */
const EXA_RESULTS_MAX = 100;
/**
 * 有屏蔽名单时向 Exa 多要几倍结果，留出本地过滤后仍凑得够条数的余量。
 *
 * 只在名单达到 OVERFETCH_MIN_ENTRIES 条时才预热：名单很短时（手写几个域名），
 * 前几条结果里命中屏蔽的概率极低，多要的那部分纯属浪费——Exa 超过 10 条
 * 就开始按页计费。名单很长时才值得为「被滤掉后仍然够数」付这笔钱。
 */
const OVERFETCH_FACTOR = 3;
const OVERFETCH_MIN_ENTRIES = 50;
/**
 * Exa 不支持 excludeDomains 的两个 category。
 *
 * 文档只说「会返回 400」，实测更麻烦：company 会静默返回 0 条，看起来像「没找到」；
 * people 才真的报 400。两类都得整个跳过过滤，否则一份黑名单就能把 company 搜索清空。
 */
const CATEGORIES_WITHOUT_DOMAIN_FILTER = new Set(["company", "people"]);
const MAX_RESULTS = 25;
const MAX_CHARACTERS_LIMIT = 50000;
const MIN_CHARACTERS = 200;
/** 单次返回给模型的文本上限，防止 includeText + 大 numResults 把上下文撑爆。 */
const OUTPUT_SOFT_LIMIT = 60000;

/** 订阅名单的落盘文件，放在 App 自己的数据目录里。 */
const BLOCKLIST_FILE = "blocklist.json";
/** 订阅文件的体积上限。一份上万个域名的名单约 300KB，这个额度留得很宽。 */
const SUBSCRIPTION_MAX_BYTES = 8 * 1024 * 1024;
/** 抓订阅的超时。 */
const SUBSCRIPTION_TIMEOUT_MS = 30000;
/**
 * 正则规则的护栏。
 *
 * 名单是第三方内容，正则规则会在本机对每条结果 URL 求值。恶意或写得极糟的正则
 * 能拖死一个进程（ReDoS），所以限长、限条数，并且只在 URL 这种短字符串上求值。
 */
const REGEX_MAX_PATTERN_LENGTH = 400;
const REGEX_MAX_COUNT = 20000;

/**
 * 工具描述与参数表。
 *
 * 这段必须与 manifest.json 里 activation.tools[0] 的 description / parameters
 * 逐字一致：App 采用 on-demand 启动，在真正被调用之前，模型看到的是清单里那份
 * 静态声明，而不是这里的运行期注册。改一处就要改两处。
 */
const TOOL_DESCRIPTION =
  "用 Exa 做语义检索：给一句自然语言描述你想找什么，它按意思匹配，而不是按词面匹配。" +
  "适合找讨论某个思路、方法、观点的文章与论文，做探索性调研。" +
  "它与内置的 web_search 是分工而非替代：要精确事实、当日动态、某个具体页面时用 web_search；" +
  "要对一个主题说不准该用什么词、想按意思捞回相关内容时，用它。" +
  "返回标题、链接与相关性高亮（高亮长度可在设置里调，默认每条约 1000 字符，被截断的末尾会标 …）；" +
  "需要大段原文时把 includeText 设为 true。设置里可能有一份永久屏蔽的域名名单，会自动排除那些站点。";

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "想找什么，用一句自然语言描述。Exa 是语义检索，描述意图比堆关键词更有效。",
    },
    numResults: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RESULTS,
      description: "返回条数，默认 5。",
    },
    type: {
      type: "string",
      enum: SEARCH_TYPES,
      description: "检索方式：neural 纯语义、keyword 纯关键词、auto 交给 Exa 判断。默认 auto。",
    },
    category: {
      type: "string",
      description:
        "把检索限定在某一类内容上。常见取值：company、research paper、news、personal site、financial report、people。Exa 调整过这组枚举，传错时它会明确报错。留空则不限。",
    },
    includeDomains: {
      type: "array",
      items: { type: "string" },
      description: '只在列出的域名内检索，例如 ["arxiv.org"]。',
    },
    excludeDomains: {
      type: "array",
      items: { type: "string" },
      description: "排除这些域名。",
    },
    startPublishedDate: {
      type: "string",
      description: "只看该时间之后发布的内容，ISO 8601，例如 2025-01-01 或 2025-01-01T00:00:00.000Z。",
    },
    endPublishedDate: {
      type: "string",
      description: "只看该时间之前发布的内容，格式同上。",
    },
    includeText: {
      type: "boolean",
      description: "是否附带网页正文。默认 false，只给标题、链接与摘要片段；需要读全文时再开。",
    },
    maxCharacters: {
      type: "integer",
      minimum: MIN_CHARACTERS,
      maximum: MAX_CHARACTERS_LIMIT,
      description: "附带正文时每条最多保留多少字符，默认 2000。",
    },
  },
  required: ["query"],
};

export default defineApp(async (sdk) => {
  await sdk.logger.info("exa-search loaded");

  await sdk.tools.register({
    name: "exa_search",
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    // 只读的网络检索：声明之后这次调用免于逐次审阅。
    sessionPermission: { readOnly: true },
    execute: (args) => runSearch(sdk, args),
  });

  registerSettingsRoutes(sdk);
});

/* ============================================================ 设置页后端 */

/**
 * 自定义设置页（contributes.settings.ui）走应用自己的已认证路由。
 *
 * 这一层只做三件事：把当前配置与名单状态交出去、把改过的配置存回来、
 * 抓并解析订阅名单。页面本身不认识 Exa，也不解析 uBO 格式。
 */
function registerSettingsRoutes(sdk) {
  sdk.routes.register((app) => {
    app.get("/state", async (c) => {
      const blocklist = await loadSubscription(sdk);
      return c.json({
        schema: await loadOwnSchema(sdk),
        values: await safeConfigAll(sdk),
        blocklist: summarizeSubscription(blocklist),
        limits: { domainListMax: DOMAIN_LIST_MAX, regexMaxCount: REGEX_MAX_COUNT },
      });
    });

    app.post("/save", async (c) => {
      let body = null;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "请求体不是合法 JSON。" }, 400);
      }

      const incoming = body && typeof body.values === "object" && body.values ? body.values : {};
      const applied = [];
      const skipped = [];

      for (const [key, value] of Object.entries(incoming)) {
        // 宿主把 sensitive 字段掩成星号发出来，带着掩码回来的那格当成"没改"。
        if (value === "********") {
          skipped.push(key);
          continue;
        }
        try {
          await sdk.config.set(key, value);
          applied.push(key);
        } catch (error) {
          await sdk.logger.warn(`写入设置 ${key} 失败：${messageOf(error)}`);
          skipped.push(key);
        }
      }

      return c.json({ ok: true, applied, skipped });
    });

    app.post("/blocklist/update", async (c) => {
      let body = null;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "请求体不是合法 JSON。" }, 400);
      }

      const url = String(body?.url ?? "").trim();
      if (!url) return c.json({ ok: false, error: "订阅链接是空的。" }, 400);

      let parsedUrl = null;
      try {
        parsedUrl = new URL(url);
      } catch {
        return c.json({ ok: false, error: "订阅链接不是合法的网址。" }, 400);
      }
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        return c.json({ ok: false, error: "订阅链接只支持 http 或 https。" }, 400);
      }

      let response;
      try {
        response = await sdk.network.fetch(parsedUrl.toString(), {
          method: "GET",
          timeoutMs: SUBSCRIPTION_TIMEOUT_MS,
        });
      } catch (error) {
        return c.json(
          {
            ok: false,
            error:
              `抓取失败：${messageOf(error)}。` +
              `如果这是域名没放行的问题，需要把主机加进清单的 network.allowedHosts 并重新批准本应用。`,
          },
          502,
        );
      }

      if (!response.ok) {
        return c.json({ ok: false, error: `订阅地址返回 HTTP ${response.status}。` }, 502);
      }

      let text = "";
      try {
        text = await response.text();
      } catch (error) {
        return c.json({ ok: false, error: `读取响应失败：${messageOf(error)}` }, 502);
      }

      if (text.length > SUBSCRIPTION_MAX_BYTES) {
        return c.json(
          {
            ok: false,
            error: `名单有 ${Math.round(text.length / 1024)} KB，超过 ${Math.round(SUBSCRIPTION_MAX_BYTES / 1024)} KB 的上限，已拒绝。`,
          },
          413,
        );
      }

      const parsed = parseUboList(text);
      if (!parsed.hosts.length && !parsed.hostPaths.length && !parsed.regexes.length) {
        return c.json(
          {
            ok: false,
            error: "这个地址里没有解析出任何可用的规则。确认它是 uBlock Origin 格式的名单，而不是网页或 JSON。",
          },
          422,
        );
      }

      const entry = {
        sourceUrl: parsedUrl.toString(),
        fetchedAt: new Date().toISOString(),
        bytes: text.length,
        counts: parsed.counts,
        hosts: parsed.hosts,
        ipHosts: parsed.ipHosts,
        hostPaths: parsed.hostPaths,
        regexes: parsed.regexes,
      };

      try {
        writeSubscription(sdk, entry);
      } catch (error) {
        return c.json({ ok: false, error: `写入本地失败：${messageOf(error)}` }, 500);
      }

      subscriptionCache = { path: subscriptionPath(sdk), mtimeMs: readMtime(subscriptionPath(sdk)), entry };

      await sdk.logger.info(
        `订阅名单已更新：${parsed.counts.hosts} 个域名、${parsed.counts.hostPaths} 条路径规则、` +
          `${parsed.counts.regexes} 条正则（来自 ${parsedUrl.host}）`,
      );

      return c.json({ ok: true, blocklist: summarizeSubscription(entry) });
    });

    app.post("/blocklist/clear", async (c) => {
      try {
        clearSubscription(sdk);
      } catch (error) {
        return c.json({ ok: false, error: `删除本地名单失败：${messageOf(error)}` }, 500);
      }
      subscriptionCache = null;
      await sdk.logger.info("订阅名单已清除。");
      return c.json({ ok: true, blocklist: null });
    });
  });
}

/**
 * 设置页要画哪些字段。
 *
 * 先问宿主要（`ctx.config.getSchema()`），拿不到就自己读安装目录里的
 * manifest.json——两条路都是同一份声明，不存在第三份副本会漂移。
 */
async function loadOwnSchema(sdk) {
  try {
    const declared = await sdk.config.getSchema();
    if (declared && typeof declared === "object" && declared.properties) return declared;
  } catch (error) {
    await sdk.logger.warn(`读取设置 schema 失败，改读清单：${messageOf(error)}`);
  }

  try {
    const manifestPath = join(hanaHomeOf(sdk), "apps", name, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest?.contributes?.settings?.schema ?? null;
  } catch (error) {
    await sdk.logger.warn(`读取清单失败：${messageOf(error)}`);
    return null;
  }
}

/** dataDir 是 <HANA_HOME>/app-data/<id>，上两级就是 <HANA_HOME>。 */
function hanaHomeOf(sdk) {
  return dirname(dirname(String(sdk.dataDir)));
}

async function safeConfigAll(sdk) {
  try {
    return await sdk.config.getAll();
  } catch (error) {
    await sdk.logger.warn(`读取全部设置失败：${messageOf(error)}`);
    return {};
  }
}

/* ================================================== 订阅名单：读写与解析 */

/** 路径 + mtime 的读缓存，避免每次检索都去解析几百 KB 的 JSON。 */
let subscriptionCache = null;

function subscriptionPath(sdk) {
  return join(String(sdk.dataDir), BLOCKLIST_FILE);
}

function readMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function writeSubscription(sdk, entry) {
  const path = subscriptionPath(sdk);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entry), "utf8");
}

function clearSubscription(sdk) {
  const path = subscriptionPath(sdk);
  if (existsSync(path)) writeFileSync(path, "{}", "utf8");
}

/** 读出订阅名单。读不到、坏了都返回 null，不让它影响检索本身。 */
async function loadSubscription(sdk) {
  const path = subscriptionPath(sdk);
  const mtimeMs = readMtime(path);
  if (mtimeMs === null) return null;

  if (subscriptionCache && subscriptionCache.path === path && subscriptionCache.mtimeMs === mtimeMs) {
    return subscriptionCache.entry;
  }

  let entry = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.hosts)) entry = parsed;
  } catch (error) {
    await sdk.logger.warn(`订阅名单读取失败，已当作没有订阅：${messageOf(error)}`);
    entry = null;
  }

  subscriptionCache = { path, mtimeMs, entry };
  return entry;
}

/** 只把状态交给设置页，不把上万条规则塞进响应。 */
function summarizeSubscription(entry) {
  if (!entry || !Array.isArray(entry.hosts)) return null;
  return {
    sourceUrl: entry.sourceUrl ?? "",
    fetchedAt: entry.fetchedAt ?? null,
    bytes: entry.bytes ?? null,
    counts: entry.counts ?? {
      hosts: entry.hosts.length,
      ipHosts: (entry.ipHosts ?? []).length,
      hostPaths: (entry.hostPaths ?? []).length,
      regexes: (entry.regexes ?? []).length,
      unsupported: 0,
    },
  };
}

/**
 * 解析 uBlock Origin 格式的名单。
 *
 * 这份格式不是域名清单，是一套过滤器语法，绝大多数规则在这里用不上。
 * 处理原则是「能忠实表达的才收，其余计数上报」——不猜、不近似，
 * 因为猜错的方向是「以为屏蔽了、实际没有」，而那种失败不会报错。
 *
 * 收下三类：
 *   · 裸域名 / 裸 IP            → hosts / ipHosts（整站屏蔽）
 *   · ||host^  /  ||host/path^  → hosts / hostPaths（后者只屏蔽该路径）
 *   · /正则/$doc                → regexes（在本机对结果 URL 求值）
 *
 * 丢掉三类：
 *   · 含 * 的通配主机（||daliulian.*.com^）——本机按主机名匹配表达不了
 *   · 元素隐藏与脚本注入（## / #@# / #?# / #$#）——与网络检索无关
 *   · 没有后缀的裸词、看不懂的行——多半是笔误
 *
 * 一个解析细节很要命：`#` 在本格式里既是行内注释，也出现在正则的字符类里
 * （`(?=[/?#]|$)`）。整份名单里有 3217 行属于后者，所以只能剥离「空格 + #」
 * 形式的注释，裸 `#` 一律不碰。
 */
export function parseUboList(text) {
  const hosts = [];
  const ipHosts = [];
  const hostPaths = [];
  const regexes = [];
  const seenHost = new Set();
  const seenPath = new Set();
  const seenRegex = new Set();
  let unsupported = 0;

  const addHost = (value) => {
    if (!value || seenHost.has(value)) return;
    seenHost.add(value);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) ipHosts.push(value);
    else hosts.push(value);
  };

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    // 注释与小节标题
    if (line.startsWith("!") || line.startsWith("#") || (line.startsWith("[") && line.endsWith("]"))) continue;
    // 元素隐藏 / 脚本注入：不是网络规则
    if (
      line.includes("##") ||
      line.includes("#@#") ||
      line.includes("#?#") ||
      line.includes("#$#")
    ) {
      unsupported += 1;
      continue;
    }
    // 只剥离「空格 + #」的行内注释
    const hashAt = line.search(/\s#/);
    if (hashAt > 0) line = line.slice(0, hashAt).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const withoutOptions = line.replace(/\$[a-z,~|]+$/i, "");
      const match = /^\/(.+)\/([a-z]*)$/.exec(withoutOptions);
      if (!match) {
        unsupported += 1;
        continue;
      }
      const pattern = match[1];
      if (pattern.length > REGEX_MAX_PATTERN_LENGTH || regexes.length >= REGEX_MAX_COUNT) {
        unsupported += 1;
        continue;
      }
      const key = `/${pattern}/${match[2]}`;
      if (seenRegex.has(key)) continue;
      seenRegex.add(key);
      regexes.push(key);
      continue;
    }

    if (line.startsWith("||")) {
      const body = line
        .slice(2)
        .replace(/\$[a-z,~|]+$/i, "")
        .replace(/\^$/, "");
      // 通配主机在按主机名匹配的模型里表达不了
      if (body.includes("*")) {
        unsupported += 1;
        continue;
      }
      const slash = body.indexOf("/");
      const host = (slash < 0 ? body : body.slice(0, slash)).toLowerCase().replace(/^www\./, "");
      if (!host || !/^[a-z0-9.-]+$/.test(host)) {
        unsupported += 1;
        continue;
      }
      if (slash < 0) {
        addHost(host);
      } else {
        const prefix = `${host}${body.slice(slash)}`.toLowerCase();
        if (!seenPath.has(prefix)) {
          seenPath.add(prefix);
          hostPaths.push(prefix);
        }
      }
      continue;
    }

    const host = normalizeOneDomain(line);
    if (host) {
      addHost(host);
      continue;
    }
    unsupported += 1;
  }

  return {
    hosts,
    ipHosts,
    hostPaths,
    regexes,
    counts: {
      hosts: hosts.length,
      ipHosts: ipHosts.length,
      hostPaths: hostPaths.length,
      regexes: regexes.length,
      unsupported,
    },
  };
}

/* ---------------------------------------------------------- 本地过滤 */

/**
 * 把「手写名单 + 订阅名单」合成一个本机过滤器。
 *
 * 为什么本机还要过一遍：Exa 的 excludeDomains 上限是 1200，而一份内容农场名单
 * 动辄上万个域名，靠 Exa 单侧根本装不下。所以 Exa 那边能塞多少塞多少（提高召回
 * 质量），本机这层负责兜底——凡是 Exa 漏进来的，在这里拦掉。
 *
 * 本机匹配按主机名，裸域名覆盖子域（与 Exa 的语义一致，实测屏蔽 vldb.org 后
 * www.vldb.org 一起消失）。路径规则多一层边界判断，避免 /news 把 /newsletter 也吃掉。
 */
export function buildLocalFilter(rawManual, subscription) {
  const manual = normalizeBlockedDomains(rawManual);
  const hosts = new Set(manual.domains);
  const hostPaths = [];
  const regexes = [];
  let regexSkipped = 0;

  if (subscription && typeof subscription === "object") {
    for (const host of subscription.hosts ?? []) hosts.add(String(host).toLowerCase());
    for (const ip of subscription.ipHosts ?? []) hosts.add(String(ip).toLowerCase());
    for (const prefix of subscription.hostPaths ?? []) hostPaths.push(String(prefix).toLowerCase());
    for (const raw of subscription.regexes ?? []) {
      const source = String(raw ?? "");
      const match = /^\/(.*)\/([a-z]*)$/.exec(source);
      if (!match) {
        regexSkipped += 1;
        continue;
      }
      try {
        regexes.push(new RegExp(match[1], match[2]));
      } catch {
        regexSkipped += 1;
      }
    }
  }

  return {
    hosts,
    hostPaths,
    regexes,
    manualRejected: manual.rejected,
    manualCount: manual.domains.length,
    subscriptionCount: hosts.size - manual.domains.length,
    regexSkipped,
  };
}

/** 过滤器里有没有东西。空过滤器不改变任何行为。 */
export function filterIsActive(filter) {
  return Boolean(filter && (filter.hosts.size || filter.hostPaths.length || filter.regexes.length));
}

/**
 * 手写名单 + 订阅名单加起来有多少条规则。
 *
 * 用来决定要不要向 Exa 预热候选（见 OVERFETCH_MIN_ENTRIES）。与 filterIsActive
 * 问的不是同一件事：那个问「编译好的过滤器里有没有可匹配的规则」。
 */
export function countBlocklistEntries(rawManual, subscription) {
  let total = normalizeBlockedDomains(rawManual).domains.length;
  if (subscription && typeof subscription === "object") {
    total +=
      (subscription.hosts ?? []).length +
      (subscription.ipHosts ?? []).length +
      (subscription.hostPaths ?? []).length +
      (subscription.regexes ?? []).length;
  }
  return total;
}

/** 名单是不是空的。 */
export function hasAnyBlocklist(rawManual, subscription) {
  return countBlocklistEntries(rawManual, subscription) > 0;
}

/**
 * 这条结果 URL 是否命中屏蔽名单。
 *
 * 三条判据依次是：主机名、主机+路径前缀、正则。三者都按「裸域名覆盖子域」
 * 的语义匹配。正则只在 URL 这种短字符串上求值，这是对 ReDoS 的护栏。
 */
export function isUrlBlocked(rawUrl, filter) {
  if (!filter) return false;
  const candidate = String(rawUrl ?? "").trim();
  if (!candidate) return false;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;

  // 裸域名覆盖子域：从最具体的一级往上找
  let cursor = host;
  while (cursor) {
    if (filter.hosts.has(cursor)) return true;
    const dot = cursor.indexOf(".");
    if (dot < 0) break;
    cursor = cursor.slice(dot + 1);
  }

  /*
   * 路径规则也要覆盖子域。
   *
   * 不能拿「完整主机名 + 路径」去比前缀：那样 `ettoday.net/dalemon` 就匹配不上
   * `https://www.ettoday.net/dalemon/123`，而真实 URL 大量带 www，等于路径规则
   * 基本上全失效——这是拿真实 Exa 返回试出来的。
   *
   * 所以先按裸域名匹配主机（同样逐级往上），再看路径前缀带边界。
   */
  if (filter.hostPaths.length) {
    const pathname = parsed.pathname;
    for (const prefix of filter.hostPaths) {
      const slash = prefix.indexOf("/");
      if (slash <= 0) continue;
      const prefixHost = prefix.slice(0, slash);
      const prefixPath = prefix.slice(slash);

      let candidateHost = host;
      let hostMatches = false;
      while (candidateHost) {
        if (candidateHost === prefixHost) {
          hostMatches = true;
          break;
        }
        const dot = candidateHost.indexOf(".");
        if (dot < 0) break;
        candidateHost = candidateHost.slice(dot + 1);
      }
      if (!hostMatches) continue;

      if (!pathname.startsWith(prefixPath)) continue;
      const next = pathname.charAt(prefixPath.length);
      if (next === "" || next === "/" || next === "?" || next === "#") return true;
    }
  }

  for (const regex of filter.regexes) {
    try {
      if (regex.test(candidate)) return true;
    } catch {
      // 单条正则求值出错不影响其它规则
    }
  }

  return false;
}

/* ------------------------------------------------------------------ 检索 */

async function runSearch(sdk, args) {
  const query = String(args?.query ?? "").trim();
  if (!query) {
    return fail("exa_search 需要一个非空的 query。用一句话描述你想找什么。");
  }

  const settings = await readSettings(sdk);
  if (!settings.apiKey) {
    return fail(
      "还没有配置 Exa API Key。去 设置 → 应用 → Exa Search 填上 apiKey，然后再试一次。" +
        "Key 在 dashboard.exa.ai 的 API Keys 页面创建。",
    );
  }

  const persistentListsOn = settings.blocklistEnabled !== false;
  const blockedText = persistentListsOn ? settings.blockedDomains : "";
  const subscription = persistentListsOn ? await loadSubscription(sdk) : null;
  const filter = buildLocalFilter(blockedText, subscription);
  const request = buildRequest(args, { ...settings, blockedDomains: blockedText }, query, { subscription });

  if (!persistentListsOn) {
    await sdk.logger.info("屏蔽名单已按设置关闭，本次未做域名过滤（工具参数里临时指定的排除仍然生效）。");
  }

  let response;
  try {
    response = await sdk.network.fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify(request.body),
      timeoutMs: 45000,
    });
  } catch (error) {
    return fail(`调用 Exa 失败：${messageOf(error)}。检查网络后重试。`);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return fail(describeHttpFailure(response.status, payload));
  }

  const returned = Array.isArray(payload?.results) ? payload.results : [];
  const kept = [];
  let blockedCount = 0;
  for (const item of returned) {
    if (isUrlBlocked(item?.url, filter)) {
      blockedCount += 1;
      continue;
    }
    if (kept.length < request.meta.numResults) kept.push(item);
  }

  await sdk.logger.info(
    `exa_search "${query}" -> Exa 返回 ${returned.length} 条，本地过滤掉 ${blockedCount} 条，交付 ${kept.length} 条`,
  );

  if (request.meta.blacklistRejected?.length) {
    await sdk.logger.warn(
      `blockedDomains 有 ${request.meta.blacklistRejected.length} 条不像是域名，已忽略：` +
        request.meta.blacklistRejected.join(", "),
    );
  }
  if (request.meta.blockedListTruncated) {
    await sdk.logger.warn(
      `发送给 Exa 的屏蔽名单超过 ${DOMAIN_LIST_MAX} 条上限，超出部分未发送（本机过滤仍覆盖全部）。`,
    );
  }
  if (request.meta.filterSkipped) {
    await sdk.logger.warn(
      `屏蔽名单已跳过：category=${request.meta.filterSkipReason} 不支持 excludeDomains，` +
        `以免搜索结果被静默清空。本机过滤不受影响。`,
    );
  }
  if (filter.regexSkipped) {
    await sdk.logger.warn(`订阅名单里有 ${filter.regexSkipped} 条正则无法编译，已跳过。`);
  }

  const meta = {
    ...request.meta,
    blockedCount,
    candidatesFromExa: returned.length,
    subscriptionHosts: subscription?.hosts?.length ?? 0,
    blocklistEnabled: persistentListsOn,
  };

  return {
    content: [{ type: "text", text: formatResults(query, { ...payload, results: kept }, meta) }],
    details: {
      provider: "exa",
      query,
      resolvedSearchType: payload?.resolvedSearchType ?? null,
      searchTimeMs: payload?.searchTime ?? null,
      resultCount: kept.length,
      candidatesFromExa: returned.length,
      blockedByLocalFilter: blockedCount,
      costDollarsTotal: payload?.costDollars?.total ?? null,
      excludedDomainCount: meta.excludedDomainCount,
      blacklistSize: meta.blacklistSize,
      blacklistSkipped: meta.filterSkipped,
      blacklistRejected: meta.blacklistRejected,
      blacklistEnabled: meta.blocklistEnabled,
      subscriptionHosts: meta.subscriptionHosts,
      results: kept.map((item) => ({
        title: item?.title ?? "",
        url: item?.url ?? "",
        publishedDate: item?.publishedDate ?? null,
        author: item?.author ?? null,
      })),
    },
  };
}

export function buildRequest(args, settings, query, context = {}) {
  const subscription = context?.subscription ?? null;
  const defaultType = SEARCH_TYPES.includes(settings.defaultSearchType) ? settings.defaultSearchType : "auto";
  const requestedType = String(args?.type ?? "").trim();
  const type = SEARCH_TYPES.includes(requestedType) ? requestedType : defaultType;

  const includeText =
    typeof args?.includeText === "boolean" ? args.includeText : settings.includeTextByDefault === true;

  const highlightCap = clampInt(
    settings.highlightsMaxCharacters,
    0,
    MAX_HIGHLIGHTS_CHARACTERS,
    DEFAULT_HIGHLIGHTS_MAX_CHARACTERS,
  );
  // 低于下限的上限抬到下限；0 保留为「不设限」。
  const effectiveCap = highlightCap > 0 ? Math.max(MIN_HIGHLIGHTS_CHARACTERS, highlightCap) : 0;

  const wanted = clampInt(args?.numResults, 1, MAX_RESULTS, settings.defaultNumResults);
  // 名单够长时才向 Exa 预热候选：见 OVERFETCH_MIN_ENTRIES。
  const listSize = countBlocklistEntries(settings.blockedDomains, subscription);
  const active = listSize > 0;
  const askedOfExa =
    listSize >= OVERFETCH_MIN_ENTRIES
      ? Math.min(EXA_RESULTS_MAX, Math.max(wanted * OVERFETCH_FACTOR, wanted + 5))
      : wanted;

  const body = {
    query,
    numResults: askedOfExa,
    type,
    contents: {
      highlights: effectiveCap > 0 ? { maxCharacters: effectiveCap } : true,
    },
  };

  if (includeText) {
    body.contents.text = {
      maxCharacters: clampInt(
        args?.maxCharacters,
        MIN_CHARACTERS,
        MAX_CHARACTERS_LIMIT,
        settings.defaultMaxCharacters,
      ),
    };
  }

  const category = String(args?.category ?? "").trim();
  if (category) body.category = category;

  const includeDomains = toDomainList(args?.includeDomains);
  if (includeDomains.length) body.includeDomains = includeDomains;

  // 永久名单（手写 + 订阅）和本次临时排除合并；company / people 下整个跳过。
  const exclusion = computeExcludedDomains({
    manual: settings.blockedDomains,
    subscription,
    requested: args?.excludeDomains,
    category,
  });
  if (exclusion.domains.length) body.excludeDomains = exclusion.domains;

  // 只写日期时补足时分秒，否则 Exa 会把 2025-01-01 理解成当天零点，
  // 「到某天为止」这一侧就会整天落空。
  const startPublishedDate = normalizeDate(args?.startPublishedDate, false);
  if (startPublishedDate) body.startPublishedDate = startPublishedDate;

  const endPublishedDate = normalizeDate(args?.endPublishedDate, true);
  if (endPublishedDate) body.endPublishedDate = endPublishedDate;

  return {
    body,
    meta: {
      type,
      includeText,
      numResults: wanted,
      requestedFromExa: askedOfExa,
      highlightCap: effectiveCap,
      excludedDomainCount: exclusion.domains.length,
      blacklistSize: exclusion.blacklistSize,
      blacklistRejected: exclusion.rejected,
      filterSkipped: exclusion.skipped,
      filterSkipReason: exclusion.guard,
      blockedListTruncated: exclusion.truncated,
      localFilterActive: active,
      blocklistEntries: listSize,
    },
  };
}

async function readSettings(sdk) {  const read = async (key, fallback) => {
    try {
      const value = await sdk.config.get(key);
      if (value === undefined || value === null || value === "") return fallback;
      return value;
    } catch (error) {
      await sdk.logger.warn(`读取设置 ${key} 失败：${messageOf(error)}`);
      return fallback;
    }
  };

  const searchType = String(await read("defaultSearchType", "auto")).trim();

  return {
    apiKey: String((await read("apiKey", "")) ?? "").trim(),
    // 原始文本，不在这里解析：归一是 computeExcludedDomains 的职责。
    blockedDomains: String((await read("blockedDomains", "")) ?? ""),
    defaultNumResults: clampInt(await read("defaultNumResults", DEFAULT_NUM_RESULTS), 1, MAX_RESULTS, DEFAULT_NUM_RESULTS),
    defaultSearchType: SEARCH_TYPES.includes(searchType) ? searchType : "auto",
    includeTextByDefault: (await read("includeTextByDefault", false)) === true,
    defaultMaxCharacters: clampInt(
      await read("defaultMaxCharacters", DEFAULT_MAX_CHARACTERS),
      MIN_CHARACTERS,
      MAX_CHARACTERS_LIMIT,
      DEFAULT_MAX_CHARACTERS,
    ),
    highlightsMaxCharacters: clampInt(
      await read("highlightsMaxCharacters", DEFAULT_HIGHLIGHTS_MAX_CHARACTERS),
      0,
      MAX_HIGHLIGHTS_CHARACTERS,
      DEFAULT_HIGHLIGHTS_MAX_CHARACTERS,
    ),
    // 默认开启。只有显式存了 false 才算关，避免这个字段缺失时把屏蔽静默停掉。
    blocklistEnabled: (await read("blocklistEnabled", true)) !== false,
  };
}

function formatResults(query, payload, meta) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const engine = String(payload?.resolvedSearchType || meta.type || "auto");
  const elapsed = Number.isFinite(payload?.searchTime) ? ` · ${Math.round(payload.searchTime)}ms` : "";
  const head = `Exa 检索 · ${engine}${elapsed}\n查询：${query}`;

  if (!results.length) {
    const notes = [];
    if (meta?.blockedCount > 0) {
      notes.push(
        `Exa 返回的 ${meta.candidatesFromExa} 条全部命中屏蔽名单。换个说法再试，或去设置里检查名单是不是太宽。`,
      );
    }
    if (meta?.filterSkipped) {
      notes.push(
        `category=${meta.filterSkipReason} 时 Exa 不支持域名过滤，已跳过 Exa 侧的屏蔽（本机过滤仍在生效）。`,
      );
    }
    notes.push("没有返回结果。换个说法、放宽域名或时间限制，或者改用 web_search 试试。");
    return `${head}\n\n${notes.join("\n")}`;
  }

  const blocks = [];
  let used = 0;
  let dropped = 0;
  let cut = 0;

  for (let index = 0; index < results.length; index += 1) {
    const shaped = formatOneResult(results[index], index + 1, meta?.highlightCap);
    if (used + shaped.block.length > OUTPUT_SOFT_LIMIT) {
      dropped = results.length - index;
      break;
    }
    used += shaped.block.length;
    if (shaped.cut) cut += 1;
    blocks.push(shaped.block);
  }

  let text = `${head}\n\n${blocks.join("\n\n")}`;
  if (cut > 0) {
    text += `\n\n（末尾带 … 的高亮已贴到长度上限，不是排版出错。要更长的片段，去 设置 → 应用 → Exa Search 调大「每条结果的高亮上限」。）`;
  }
  if (meta?.blockedCount > 0) {
    text += `\n\n（本次有 ${meta.blockedCount} 条结果命中内容农场屏蔽名单，已剔除。）`;
  }
  if (meta?.filterSkipped) {
    text += `\n\n（category=${meta.filterSkipReason} 时 Exa 不支持域名过滤，Exa 侧的屏蔽已跳过，本机过滤仍在生效。）`;
  }
  if (dropped > 0) {
    text += `\n\n（另有 ${dropped} 条因长度上限未展开，可调小 numResults，或关掉 includeText 再看。）`;
  }
  return text;
}

function formatOneResult(result, position, highlightCap) {
  const item = result && typeof result === "object" ? result : {};
  const lines = [`${position}. ${oneLine(item.title) || "(无标题)"}`];

  const url = oneLine(item.url);
  if (url) lines.push(`   ${url}`);

  const meta = [];
  if (item.publishedDate) meta.push(`发布 ${String(item.publishedDate).slice(0, 10)}`);
  if (item.author) meta.push(`作者 ${oneLine(item.author)}`);
  if (Number.isFinite(item.score)) meta.push(`相关度 ${Number(item.score).toFixed(3)}`);
  if (meta.length) lines.push(`   ${meta.join(" · ")}`);

  const highlights = Array.isArray(item.highlights) ? item.highlights : [];
  const shown = highlights.slice(0, 3);
  const isCut = highlightWasCut(highlights, highlightCap);

  shown.forEach((highlight, index) => {
    let text = oneLine(highlight);
    if (!text) return;
    // 省略号只标在最后一条上：被切的就是它，多出的那几条也只在这里收尾。
    if (isCut && index === shown.length - 1) text = `${text} …`;
    lines.push(`   › ${text}`);
  });

  const body = compactText(item.text);
  if (body) lines.push(`   正文：${body}`);

  return { block: lines.join("\n"), cut: isCut && shown.length > 0 };
}

/**
 * 这条结果的高亮是不是被 highlights.maxCharacters 切掉的。
 *
 * Exa 按字符切，不按句子切，所以切点会落在句中。两个信号同时成立才算：
 * 总长度贴到上限的九成以上，且末段结尾不在句读上。只靠前者会误判：
 * 上限 3000 时实测有一条只到 2784，但它结尾是完整的「2025).」。
 * 上限为 0（不设限）时永不标记，因为切的人不是我们。
 */
function highlightWasCut(highlights, cap) {
  if (!Number.isFinite(cap) || cap <= 0 || !highlights.length) return false;

  const total = highlights.reduce((sum, entry) => sum + String(entry ?? "").length, 0);
  if (total < cap * HIGHLIGHT_NEAR_CAP_RATIO) return false;

  const last = String(highlights[highlights.length - 1] ?? "").trimEnd();
  if (!last) return false;
  return !/[.!?…"”'’)\]}】》」。！？]$/.test(last);
}

/**
 * 把设置里那一行文本解析成域名列表。
 *
 * 设计目标是「怎么写都不静默失效」：
 *   · 逗号、分号、换行都当分隔符
 *   · # 之后当注释丢掉，方便在名单里标注为什么屏蔽
 *   · 整条网址、带 www、带路径、带端口、大写，统统裁成小写裸域名。
 *     www 与 *. 都裁掉：Exa 的裸域名本来就覆盖子域（实测屏蔽 vldb.org
 *     后 www.vldb.org 一起消失），留着只会让同一条目重复。
 *   · 重复项去重
 *
 * 关键是裁掉路径。Exa 允许「主机名 + 路径前缀」的写法（example.com/docs），
 * 但那只屏蔽该路径，域名本身照旧出现——实测屏蔽 arxiv.org/html 后，
 * arxiv.org 的 /abs 页面照样返回。手写的黑名单要的是整站屏蔽，
 * 留下路径等于「以为屏蔽了、实际没有」。需要路径级排除时用调用参数。
 *
 * 解析不了的条目不被悄悄丢掉，而是回传给调用方记警告：
 * 写错一个字符就让整条屏蔽失效，而这种失败本身不会报错。
 */
export function normalizeBlockedDomains(raw) {
  // 接受设置里的原始文本，也接受已经切好的数组。
  const chunks = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\n,;]+/);
  const domains = [];
  const rejected = [];
  const seen = new Set();

  for (const chunk of chunks) {
    const entry = String(chunk ?? "").split("#")[0].trim();
    if (!entry) continue;

    const domain = normalizeOneDomain(entry);
    if (!domain) {
      rejected.push(entry);
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  return { domains, rejected };
}

/** 单个条目裁成小写裸域名；不像域名就返回空串。 */
export function normalizeOneDomain(entry) {
  let value = String(entry ?? "").trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // 协议
  value = value.replace(/^\/\//, ""); // 协议相对写法
  value = value.replace(/^\*\./, ""); // 通配前缀：裸域名本就覆盖子域
  value = value.replace(/^www\./, ""); // www 同理冗余，裁掉好去重
  value = value.split(/[/?#]/)[0]; // 路径 / 查询 / 片段
  value = value.replace(/:\d+$/, ""); // 端口
  value = value.replace(/^\.+|\.+$/g, ""); // 首尾多余的点
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : "";
}

/**
 * 决定发给 Exa 的 excludeDomains。
 *
 * 三份来源按优先级排：手写名单最优先（它是持久的用户意图，体量又小，绝不能被
 * 截断掉），其次本次调用的临时参数，最后才是订阅大名单。临时参数原样透传——
 * Exa 的路径级排除能力要留给调用方。
 *
 * 满 1200 就停。这不是能力上限而是 Exa 的硬闸（1201 条直接 400），
 * 被截断不影响正确性：本机过滤那一层仍然覆盖全部条目。
 *
 * category 为 company / people 时整个跳过，原因见 CATEGORIES_WITHOUT_DOMAIN_FILTER。
 */
export function computeExcludedDomains({ manual, subscription, requested, category }) {
  const parsedManual = normalizeBlockedDomains(manual);
  const requestedList = toDomainList(requested);

  const subscribedHosts = Array.isArray(subscription?.hosts) ? subscription.hosts : [];
  const subscribedPaths = Array.isArray(subscription?.hostPaths) ? subscription.hostPaths : [];
  const blacklistSize = parsedManual.domains.length + subscribedHosts.length + subscribedPaths.length;

  if (CATEGORIES_WITHOUT_DOMAIN_FILTER.has(category)) {
    return {
      domains: [],
      blacklistSize,
      rejected: parsedManual.rejected,
      skipped: blacklistSize + requestedList.length > 0,
      guard: category,
      truncated: false,
    };
  }

  const seen = new Set();
  const domains = [];
  const wanted = [...parsedManual.domains, ...requestedList, ...subscribedHosts, ...subscribedPaths];

  for (const entry of wanted) {
    const key = String(entry ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    domains.push(entry);
    if (domains.length >= DOMAIN_LIST_MAX) break;
  }

  return {
    domains,
    blacklistSize,
    rejected: parsedManual.rejected,
    skipped: false,
    guard: null,
    truncated: wanted.length > DOMAIN_LIST_MAX,
  };
}

function describeHttpFailure(status, payload) {
  const detail = oneLine(payload?.error || payload?.tag || "");
  const tail = detail ? `（Exa：${detail}）` : "";

  if (status === 401 || status === 403) {
    return `Exa 拒绝了这次请求（HTTP ${status}）：API Key 无效，或没有该接口的权限。去 设置 → 应用 → Exa Search 核对 apiKey。${tail}`;
  }
  if (status === 402) {
    return `Exa 返回 HTTP 402：账户额度或计费状态有问题，去 dashboard.exa.ai 看一眼。${tail}`;
  }
  if (status === 429) {
    return `Exa 返回 HTTP 429：触发限流，等一会儿再试。${tail}`;
  }
  if (status >= 500) {
    return `Exa 侧故障（HTTP ${status}），稍后重试即可。${tail}`;
  }
  return `Exa 返回 HTTP ${status}。${tail}`;
}

/* ------------------------------------------------------------ 小工具函数 */

function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function messageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "未知错误");
}

export function clampInt(value, min, max, fallback) {
  // Number(null) 是 0、Number(true) 是 1，直接转会把「没传」当成「传了极小值」；
  // 只认真正的数字与可解析的字符串。
  const isNumeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  if (!isNumeric) return fallback;

  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function toDomainList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

export function normalizeDate(value, isEndOfDay) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T${isEndOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return raw;
  return new Date(parsed).toISOString();
}

export function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactText(value) {
  return String(value ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 只有 \`tests/tool.test.mjs\` 用得到。宿主装载时只读 default 导出，多几个命名导出
 * 不影响启动；把它们放出来是为了让参数拼装、结果排版、名单解析，以及清单与注册表
 * 的一致性都能被单独验证——App 是 on-demand 启动的，同一份工具描述写在两个地方，
 * 最容易出错。
 */
export const __test = {
  TOOL_DESCRIPTION,
  TOOL_PARAMETERS,
  OUTPUT_SOFT_LIMIT,
  HIGHLIGHT_NEAR_CAP_RATIO,
  DOMAIN_LIST_MAX,
  EXA_RESULTS_MAX,
  OVERFETCH_FACTOR,
  OVERFETCH_MIN_ENTRIES,
  CATEGORIES_WITHOUT_DOMAIN_FILTER,
  BLOCKLIST_FILE,
  buildRequest,
  readSettings,
  formatResults,
  highlightWasCut,
  normalizeBlockedDomains,
  normalizeOneDomain,
  computeExcludedDomains,
  parseUboList,
  buildLocalFilter,
  isUrlBlocked,
  filterIsActive,
  hasAnyBlocklist,
  countBlocklistEntries,
  normalizeDate,
  clampInt,
  toDomainList,
  oneLine,
  compactText,
  describeHttpFailure,
};
