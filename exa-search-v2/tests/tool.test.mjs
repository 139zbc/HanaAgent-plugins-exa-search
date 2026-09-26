/**
 * exa-search 的本地行为测试。
 *
 *   node --test tests/
 *
 * 覆盖三件事：清单与运行期注册的声明必须一致（App 是 on-demand 启动的，
 * 同一份工具描述写在两个地方）；请求体怎么拼；结果怎么排版。
 * 不覆盖真实调用 Exa——那条路径由宿主的隔离启动检查与一次真实调用验证。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { __test } from "../index.js";

const {
  TOOL_DESCRIPTION,
  TOOL_PARAMETERS,
  OUTPUT_SOFT_LIMIT,
  HIGHLIGHT_NEAR_CAP_RATIO,
  DOMAIN_LIST_MAX,
  EXA_RESULTS_MAX,
  OVERFETCH_FACTOR,
  OVERFETCH_MIN_ENTRIES,
  CATEGORIES_WITHOUT_DOMAIN_FILTER,
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
  countBlocklistEntries,
  normalizeDate,
  clampInt,
  toDomainList,
  oneLine,
  compactText,
  describeHttpFailure,
} = __test;

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(appRoot, "manifest.json"), "utf8"));

const SETTINGS = {
  apiKey: "test-key",
  defaultNumResults: 5,
  defaultSearchType: "auto",
  includeTextByDefault: false,
  defaultMaxCharacters: 2000,
  highlightsMaxCharacters: 1000,
  blockedDomains: "",
  blocklistEnabled: true,
};

const request = (args, settings = SETTINGS) => buildRequest(args, settings, String(args.query).trim());

/* ------------------------------------------------- 清单与注册表的一致性 */

test("清单里的静态工具声明与运行期注册逐字一致", () => {
  const declared = manifest.activation.tools[0];
  assert.equal(declared.name, "exa_search");
  assert.equal(declared.description, TOOL_DESCRIPTION);
  assert.deepEqual(declared.parameters, TOOL_PARAMETERS);
  assert.deepEqual(declared.sessionPermission, { readOnly: true });
});

test("网络声明只放行两个主机：Exa 与订阅名单来源", () => {
  assert.deepEqual(manifest.network.allowedHosts, ["api.exa.ai", "danny0838.github.io"]);
  // 检索用 POST，拓订阅名单用 GET
  assert.deepEqual([...manifest.network.methods].sort(), ["GET", "POST"]);
});

test("设置页声明了自定义 UI 路由，且文件真实存在", () => {
  assert.equal(manifest.contributes.settings.ui.route, "/settings.html");
  const page = join(appRoot, "ui", "settings.html");
  assert.ok(existsSync(page), "ui/settings.html 必须存在，否则设置页会白屏");
  // 页面依赖的这几个资源也必须在位
  for (const asset of [
    "ui/settings.js",
    "ui/app-ui.css",
    "ui/assets/app-ui.js",
    "ui/assets/hana-ui.js",
    "ui/assets/theme-fallback.css",
    // app-ui.css 里引用了这张纸纹图，缺了校验器会报 MISSING_UI_RESOURCE
    "ui/assets/rice-paper-6AU64DSD.png",
  ]) {
    assert.ok(existsSync(join(appRoot, asset)), `${asset} 缺失`);
  }
});

/* --------------------------------------------- 设置页的分隔线覆盖是否仍成立 */

/**
 * 官方 CSS 对堆叠布局的栏故意不画分隔线，本页把它覆盖回来了。
 *
 * 这两条断言是一对：上游的抑制规则还在，我们才会需要覆盖。如果上游改了
 * （换类名、换做法），第一条会失败，提醒回 settings.html 复查那两条选择器
 * 还需要不需要。
 */
test("上游那条「堆叠栏不画分隔线」的抑制规则还在", () => {
  const css = readFileSync(join(appRoot, "ui", "app-ui.css"), "utf8").replace(/\s+/g, "");
  // 上游写在同一规则里：.e.b+.e:before,.e+.e.b:before{display:none}
  assert.ok(
    /\.e\.b\+\.e:before,\.e\+\.e\.b:before\{[^}]*display:none/.test(css),
    "上游 app-ui.css 里没找到预期的抑制规则——SDK 变了，回 settings.html 复查分隔线覆盖",
  );
});

test("本页有对应的覆盖，且用 !important 不依赖样式表顺序", () => {
  const compact = readFileSync(join(appRoot, "ui", "settings.html"), "utf8").replace(/\s+/g, "");
  assert.ok(compact.includes(".e.b+.e::before"), "少了针对「上一栏是堆叠」的覆盖");
  assert.ok(compact.includes(".e+.e.b::before"), "少了针对「本栏是堆叠」的覆盖");
  assert.ok(
    /\.e\.b\+\.e::before[^}]*!important/.test(compact),
    "覆盖没用 !important，会依赖样式表先后顺序",
  );
});

/* ------------------------------- 屏蔽节该装哪几栏（字段放对位置这件事值得守住） */

test("开关与手写名单一起归到屏蔽节，不留在检索设置里", () => {
  const src = readFileSync(join(appRoot, "ui", "settings.js"), "utf8");

  const declared = src.match(/const BLOCKLIST_SECTION_KEYS = \[([^\]]*)\]/);
  assert.ok(declared, "没找到 BLOCKLIST_SECTION_KEYS 声明");
  assert.ok(declared[1].includes("blocklistEnabled"), "屏蔽节标的键里少了开关");
  assert.ok(
    declared[1].includes("blockedDomains"),
    "屏蔽节标的键里少了手写名单——它受开关控制，应该跟开关在同一节",
  );

  assert.match(
    src,
    /\.filter\(\(\[key\]\) => !BLOCKLIST_SECTION_KEYS\.includes\(key\)\)/,
    "「检索设置」的字段循环没用那个常量过滤，可能会把屏蔽节的字段又画回去",
  );
});

test("屏蔽节的栏顺序：开关 → 手写名单 → 订阅链接", () => {
  const src = readFileSync(join(appRoot, "ui", "settings.js"), "utf8");
  const iToggle = src.indexOf('key: "bl-enabled"');
  const iManual = src.indexOf('key: "bl-manual"');
  const iUrl = src.indexOf('key: "bl-url"');
  assert.ok(iToggle > 0, "没找到开关那一栏");
  assert.ok(iManual > iToggle, "手写名单应该在开关下面");
  assert.ok(iUrl > iManual, "订阅链接应该在手写名单下面");
  // 手写名单那一栏复用了通用字段渲染（这样 TextArea 与 hint 的行为跟别处一致）
  assert.match(src, /fieldControl\(MANUAL_DOMAINS_KEY/);
});

/* ------------------------------------------------- 屏蔽开关（blocklistEnabled） */

/** 只为测试 readSettings 用的最小 sdk 替身。 */
function fakeSdk(values) {
  const warnings = [];
  return {
    warnings,
    config: { get: async (key) => values[key] },
    logger: {
      debug: async () => {},
      info: async () => {},
      warn: async (message) => {
        warnings.push(message);
      },
      error: async () => {},
    },
  };
}

test("屏蔽开关：schema 里是布尔，默认开", () => {
  const field = manifest.contributes.settings.schema.properties.blocklistEnabled;
  assert.equal(field.type, "boolean");
  assert.equal(field.default, true);
});

test("屏蔽开关：字段缺失时算开启（不能把屏蔽静默停掉）", async () => {
  const settings = await readSettings(fakeSdk({ apiKey: "k" }));
  assert.equal(settings.blocklistEnabled, true);
});

test("屏蔽开关：存了 false 就是关，存了 true 就是开", async () => {
  assert.equal((await readSettings(fakeSdk({ apiKey: "k", blocklistEnabled: false }))).blocklistEnabled, false);
  assert.equal((await readSettings(fakeSdk({ apiKey: "k", blocklistEnabled: true }))).blocklistEnabled, true);
});

test("关掉屏蔽时名单被置空：不发 excludeDomains、不做本机过滤、不预热", () => {
  // runSearch 在关闭时就是这么构造输入的：把持久名单换成空。
  const request = buildRequest({ query: "q", numResults: 5 }, { ...SETTINGS, blockedDomains: "" }, "q", {
    subscription: null,
  });
  assert.equal(request.body.excludeDomains, undefined);
  assert.equal(request.meta.localFilterActive, false);
  assert.equal(request.meta.blocklistEntries, 0);
  assert.equal(request.body.numResults, 5, "没有名单就不该预热");
});

test("关掉屏蔽不影响工具参数里临时指定的排除", () => {
  const request = buildRequest(
    { query: "q", excludeDomains: ["only-this-call.example"] },
    { ...SETTINGS, blockedDomains: "" },
    "q",
    { subscription: null },
  );
  assert.deepEqual(request.body.excludeDomains, ["only-this-call.example"]);
});

test("设置里声明了 apiKey 与高亮上限，且工具暴露能力已声明", () => {
  assert.ok(manifest.contributes.settings.schema.properties.apiKey);
  assert.equal(
    manifest.contributes.settings.schema.properties.highlightsMaxCharacters.default,
    1000,
  );
  assert.ok(manifest.capabilities.includes("app/tools.expose-to-model"));
});

test("设置里声明了永久屏蔽名单，默认空，且不靠新能力", () => {
  const field = manifest.contributes.settings.schema.properties.blockedDomains;
  assert.equal(field.type, "string");
  assert.equal(field.default, "");
  // 加设置项不动 capabilities，所以已批准的授权继续有效，不需要重新批准。
  assert.deepEqual(manifest.capabilities, ["app/tools.expose-to-model"]);
});

/* --------------------------------------------------------- 永久屏蔽名单 */

test("名单解析：逗号、分号、换行都当分隔符", () => {
  assert.deepEqual(normalizeBlockedDomains("a-farm.com,b-farm.net").domains, [
    "a-farm.com",
    "b-farm.net",
  ]);
  assert.deepEqual(normalizeBlockedDomains("a-farm.com;b-farm.net").domains, [
    "a-farm.com",
    "b-farm.net",
  ]);
  assert.deepEqual(normalizeBlockedDomains("a-farm.com\nb-farm.net").domains, [
    "a-farm.com",
    "b-farm.net",
  ]);
});

test("名单解析：整条网址、www、路径、端口、大写都裁成裸域名", () => {
  assert.equal(normalizeOneDomain("https://theoncetimes.com/ai/some/long/article"), "theoncetimes.com");
  assert.equal(normalizeOneDomain("http://www.Farm-Example.NET:8443/x?q=1"), "farm-example.net");
  assert.equal(normalizeOneDomain("  example.com  "), "example.com");
  assert.equal(normalizeOneDomain("*.sub.example.com"), "sub.example.com");
  assert.equal(normalizeOneDomain("example.com#section"), "example.com");
});

test("名单解析：www 与裸域名归为同一条，不重复", () => {
  const parsed = normalizeBlockedDomains("example.com,www.example.com,*.example.com");
  assert.deepEqual(parsed.domains, ["example.com"]);
});

test("裁掉路径是故意的：Exa 的路径写法不会屏蔽整个域名", () => {
  // 实测：excludeDomains 写 arxiv.org/html 时，arxiv.org 的 /abs 页面照样返回。
  // 手写的黑名单要的是整站屏蔽，所以这里必须裁成域名。
  assert.equal(normalizeOneDomain("arxiv.org/html"), "arxiv.org");
});

test("名单解析：行内 # 注释被丢掉，空行与重复项不产生条目", () => {
  const parsed = normalizeBlockedDomains(
    [
      "# 内容农场，日期造假",
      "theoncetimes.com  # 就是它把四月的事写成九月",
      "",
      "theoncetimes.com",
      "  ",
      "example.net",
    ].join("\n"),
  );
  assert.deepEqual(parsed.domains, ["theoncetimes.com", "example.net"]);
  assert.deepEqual(parsed.rejected, []);
});

test("名单解析：写错的条目不静默丢失，而是回传待警告", () => {
  const parsed = normalizeBlockedDomains("example.com, 不是域名, localhost, ,");
  assert.deepEqual(parsed.domains, ["example.com"]);
  assert.deepEqual(parsed.rejected, ["不是域名", "localhost"]);
});

test("名单解析：空输入得到空名单", () => {
  assert.deepEqual(normalizeBlockedDomains("").domains, []);
  assert.deepEqual(normalizeBlockedDomains(undefined).domains, []);
  assert.deepEqual(normalizeBlockedDomains(null).domains, []);
});

test("合并：接受设置里的原始文本，也在内部归一", () => {
  const merged = computeExcludedDomains({
    manual: "https://a-farm.com/x, www.B-Farm.net  # 顺手写的",
    requested: [],
    category: "",
  });
  assert.deepEqual(merged.domains, ["a-farm.com", "b-farm.net"]);
  assert.equal(merged.blacklistSize, 2);
});

test("合并：永久名单与本次临时排除去重后一起发", () => {
  const merged = computeExcludedDomains({
    manual: ["a-farm.com", "shared.com"],
    requested: ["shared.com", "b-farm.net"],
    category: "",
  });
  assert.deepEqual(merged.domains, ["a-farm.com", "shared.com", "b-farm.net"]);
  assert.equal(merged.skipped, false);
  assert.equal(merged.blacklistSize, 2);
});

test("合并：临时那份保留路径写法（Exa 的路径级排除留给调用方）", () => {
  const merged = computeExcludedDomains({
    manual: ["a-farm.com"],
    requested: ["arxiv.org/html"],
    category: "",
  });
  assert.deepEqual(merged.domains, ["a-farm.com", "arxiv.org/html"]);
});

test("合并：company 与 people 下整个跳过，并报告" + "已跳过", () => {
  for (const category of ["company", "people"]) {
    const merged = computeExcludedDomains({
      manual: ["a-farm.com"],
      requested: ["b-farm.net"],
      category,
    });
    assert.deepEqual(merged.domains, [], `${category} 不应发出任何过滤`);
    assert.equal(merged.skipped, true);
    assert.equal(merged.guard, category);
  }
});

test("合并：其他 category 正常过滤", () => {
  for (const category of ["news", "publication", "financial report", "personal site", ""]) {
    const merged = computeExcludedDomains({ manual: ["a-farm.com"], requested: [], category });
    assert.deepEqual(merged.domains, ["a-farm.com"]);
    assert.equal(merged.skipped, false);
  }
  assert.ok(CATEGORIES_WITHOUT_DOMAIN_FILTER.has("company"));
  assert.ok(CATEGORIES_WITHOUT_DOMAIN_FILTER.has("people"));
});

test("合并：没名单也没临时排除时不产生 excludeDomains", () => {
  const merged = computeExcludedDomains({ manual: [], requested: undefined, category: "" });
  assert.deepEqual(merged.domains, []);
  assert.equal(merged.skipped, false);
});

test("合并：超过 Exa 的 1200 上限时截断并标记", () => {
  const many = Array.from({ length: DOMAIN_LIST_MAX + 25 }, (_, i) => `farm-${i}.example`);
  const merged = computeExcludedDomains({ manual: many, requested: [], category: "" });
  assert.equal(merged.domains.length, DOMAIN_LIST_MAX);
  assert.equal(merged.truncated, true);
});

/* ------------------------------------------------------ uBO 名单解析 */

const UBO_SAMPLE = [
  "! Title: Something",
  "! Last modified: 2026-09-20",
  "",
  "# 这行是注释",
  "plain-farm.com",
  "  spaced-farm.net  ",
  "commented-farm.org  #把四月的事写成九月",
  "google-farm.de  #redirects to x.example",
  "www.www-farm.co",
  "35.190.1.7",
  "35.190.1.7",
  "plain-farm.com",
  "||blocked.com^$doc",
  "||path-farm.tw/dalemon^$doc",
  "||wild-farm.*.com^$doc",
  "||x.blogspot.*^$doc",
  "/^https?:\\/\\/(?!www\\.)(?:[\\w-]+\\.)+y2mate\\.com//$doc",
  "/^https?:\\/\\/mypaper\\.pchome\\.com\\.tw\\/(?:qqd)(?=[/?#]|$)/$doc",
  "a.b.c/",
  "nosuffix",
  "",
];

test("uBO 解析：分类正确，计数与输入行数对得上", () => {
  const parsed = parseUboList(UBO_SAMPLE.join("\n"));

  // 裸域名：www. 被裁掉后与裸域名归一；重复项去重
  assert.ok(parsed.hosts.includes("plain-farm.com"));
  assert.ok(parsed.hosts.includes("spaced-farm.net"));
  assert.ok(parsed.hosts.includes("commented-farm.org"));
  assert.ok(parsed.hosts.includes("google-farm.de"));
  assert.ok(parsed.hosts.includes("www-farm.co"));
  assert.ok(parsed.hosts.includes("blocked.com"));
  assert.equal(parsed.hosts.filter((h) => h === "plain-farm.com").length, 1, "重复项应只收一次");

  // 裸 IP 单独放，不进 hosts
  assert.deepEqual(parsed.ipHosts, ["35.190.1.7"]);
  assert.ok(!parsed.hosts.includes("35.190.1.7"));

  // 路径规则单存
  assert.deepEqual(parsed.hostPaths, ["path-farm.tw/dalemon"]);

  // 正则只收完整形态（含 /）
  assert.equal(parsed.regexes.length, 2);
  assert.ok(parsed.regexes[0].startsWith("/^https?:\\/\\/"));

  // 通配主机与无后缀裸词算不支持
  assert.ok(parsed.counts.unsupported >= 3, `unsupported=${parsed.counts.unsupported}`);
});

test("uBO 解析：行内注释只罢「空格 + #」，正则字符类里的 # 不动", () => {
  const parsed = parseUboList(UBO_SAMPLE.join("\n"));
  // (?=[/?#]|$) 里的 # 必须完整保留
  assert.ok(
    parsed.regexes.some((r) => r.includes("[/?#]")),
    "正则里的 [#] 被当注释切掉了——那会把 3217 条规则弄坏",
  );
  // 带注释的域名要留下域名本身
  assert.ok(parsed.hosts.includes("commented-farm.org"));
});

test("uBO 解析：标记为不支持的条目不会被当成规则收进来", () => {
  const parsed = parseUboList("||wild-farm.*.com^$doc\n||x.blogspot.*^$doc\nnosuffix\n");
  assert.equal(parsed.hosts.length, 0);
  assert.equal(parsed.hostPaths.length, 0);
  assert.equal(parsed.regexes.length, 0);
  assert.equal(parsed.counts.unsupported, 3);
});

test("uBO 解析：空输入与全是注释的输入都得到空结果", () => {
  for (const input of ["", "   ", "! only a comment\n", "[Adblock Plus 2.0]\n"]) {
    const parsed = parseUboList(input);
    assert.equal(parsed.hosts.length + parsed.hostPaths.length + parsed.regexes.length, 0);
  }
});

/* -------------------------------------------------------- 本机过滤 */

const SUB_SAMPLE = {
  hosts: ["farm-example.net"],
  ipHosts: ["35.190.1.7"],
  hostPaths: ["path-farm.tw/dalemon"],
  regexes: ["/^https?:\\/\\/(?!www\\.)(?:[\\w-]+\\.)+y2mate\\.com//"],
};

test("本机过滤：裸域名覆盖子域，与 Exa 的语义一致", () => {
  const filter = buildLocalFilter("", SUB_SAMPLE);
  assert.equal(isUrlBlocked("https://farm-example.net/a", filter), true);
  assert.equal(isUrlBlocked("https://www.farm-example.net/a", filter), true);
  assert.equal(isUrlBlocked("https://deep.sub.farm-example.net/a", filter), true);
  assert.equal(isUrlBlocked("https://other-example.net/a", filter), false);
  // 后缀沾边不算命中
  assert.equal(isUrlBlocked("https://notfarm-example.net/a", filter), false);
});

test("本机过滤：路径规则带边界，不会把 /newsletter 当 /news", () => {
  const filter = buildLocalFilter("", { hostPaths: ["site.tw/news"] });
  assert.equal(isUrlBlocked("https://site.tw/news/a", filter), true);
  assert.equal(isUrlBlocked("https://site.tw/news", filter), true);
  assert.equal(isUrlBlocked("https://site.tw/news?x=1", filter), true);
  assert.equal(isUrlBlocked("https://site.tw/newsletter", filter), false, "边界判断失效了");
  assert.equal(isUrlBlocked("https://site.tw/other", filter), false);
});

test("本机过滤：路径规则也要覆盖子域（真实 URL 大量带 www）", () => {
  // 这条是拿真实 Exa 返回试出来的：`ettoday.net/dalemon` 曾经匹配不上
  // `https://www.ettoday.net/dalemon/123`，路径规则形同虚设。
  const filter = buildLocalFilter("", { hostPaths: ["ettoday.net/dalemon"] });
  assert.equal(isUrlBlocked("https://www.ettoday.net/dalemon/123", filter), true, "www 前缀没被覆盖");
  assert.equal(isUrlBlocked("https://ettoday.net/dalemon/123", filter), true);
  assert.equal(isUrlBlocked("https://m.ettoday.net/dalemon", filter), true, "任意子域都要覆盖");
  assert.equal(isUrlBlocked("https://www.ettoday.net/news/123", filter), false, "别的路径不该被牵连");
  assert.equal(isUrlBlocked("https://notettoday.net/dalemon", filter), false, "隷近域名不该命中");
});

test("本机过滤：裸 IP 与正则都能命中", () => {
  const filter = buildLocalFilter("", SUB_SAMPLE);
  assert.equal(isUrlBlocked("http://35.190.1.7/x", filter), true);
  assert.equal(
    isUrlBlocked("https://sub.y2mate.com//", filter),
    true,
    "正则规则没被本机求值",
  );
  assert.equal(isUrlBlocked("https://good.example/page", filter), false);
});

test("本机过滤：手写名单与订阅合并；写错的条目回传待警告", () => {
  const filter = buildLocalFilter("manual-farm.example, 不是域名", SUB_SAMPLE);
  assert.equal(isUrlBlocked("https://manual-farm.example/x", filter), true);
  assert.equal(isUrlBlocked("https://farm-example.net/x", filter), true);
  assert.deepEqual(filter.manualRejected, ["不是域名"]);
  assert.equal(filter.manualCount, 1);
  // 订阅侧进 host 集合的是 1 个域名 + 1 个 IP；路径与正则不使用 host 集合。
  assert.equal(filter.subscriptionCount, 2);
});

test("本机过滤：编译器报错的正则被跳过，不影响其他规则", () => {
  const filter = buildLocalFilter("", { hosts: ["bad.net"], regexes: ["/[/"] });
  assert.equal(filter.regexSkipped, 1);
  assert.equal(isUrlBlocked("https://bad.net/x", filter), true);
});

test("本机过滤：无规则时 filterIsActive 为假", () => {
  assert.equal(filterIsActive(buildLocalFilter("", null)), false);
  assert.equal(filterIsActive(buildLocalFilter("a.com", null)), true);
  assert.equal(countBlocklistEntries("", null), 0);
  assert.equal(countBlocklistEntries("a.com", SUB_SAMPLE), 5, "1 手写 + 1 域名 + 1 IP + 1 路径 + 1 正则");
});

/* ------------------------------------------- 名单如何影响发往 Exa 的请求 */

test("预热：名单很短时不向 Exa 多要，避免白花超过 10 条的那部分钱", () => {
  const short = buildRequest({ query: "q" }, SETTINGS, "q", { subscription: null });
  assert.equal(short.body.numResults, 5);
  assert.equal(short.meta.requestedFromExa, 5);

  const manualOnly = buildRequest({ query: "q" }, { ...SETTINGS, blockedDomains: "one-farm.example" }, "q", {
    subscription: null,
  });
  assert.equal(manualOnly.body.numResults, 5, "只有一条手写域名时不该预热");
  assert.deepEqual(manualOnly.body.excludeDomains, ["one-farm.example"]);
});

test("预热：名单够长时按倍数多要，且不超过 Exa 的 100 条上限", () => {
  const big = Array.from({ length: OVERFETCH_MIN_ENTRIES }, (_, i) => `farm-${i}.example`);
  const request = buildRequest({ query: "q" }, SETTINGS, "q", { subscription: { hosts: big } });
  assert.equal(request.body.numResults, 5 * OVERFETCH_FACTOR);
  assert.equal(request.meta.numResults, 5, "交付条数仍是用户要的 5");
  assert.equal(request.meta.blocklistEntries, OVERFETCH_MIN_ENTRIES);

  const atCeiling = buildRequest({ query: "q", numResults: 25 }, SETTINGS, "q", {
    subscription: { hosts: big },
  });
  assert.ok(atCeiling.body.numResults <= EXA_RESULTS_MAX, "不能超过 Exa 的条数上限");
});

test("发给 Exa 的名单：手写优先排在前，且合并订阅后仍卡在 1200", () => {
  const hosts = Array.from({ length: 3000 }, (_, i) => `farm-${i}.example`);
  const request = buildRequest({ query: "q" }, { ...SETTINGS, blockedDomains: "mine.example" }, "q", {
    subscription: { hosts, hostPaths: ["p.example/x"] },
  });
  assert.equal(request.body.excludeDomains.length, DOMAIN_LIST_MAX);
  assert.equal(request.body.excludeDomains[0], "mine.example");
  assert.equal(request.meta.blockedListTruncated, true);
  assert.ok(request.meta.blacklistSize > DOMAIN_LIST_MAX, "真实规模要如实报出来");
});

test("输出：本机过滤掉条目时会说明条数", () => {
  const text = formatResults(
    "q",
    { results: [{ title: "t", url: "https://ok.example/a", highlights: ["x"] }] },
    { type: "auto", blockedCount: 3, candidatesFromExa: 8 },
  );
  assert.match(text, /有 3 条结果命中内容农场屏蔽名单/);
});

test("输出：全被过滤掉时讲清楚是名单的原因，不是没找到", () => {
  const text = formatResults("q", { results: [] }, {
    type: "auto",
    blockedCount: 5,
    candidatesFromExa: 5,
  });
  assert.match(text, /全部命中屏蔽名单/);
});

test("请求体：黑名单进了 excludeDomains", () => {
  const settings = { ...SETTINGS, blockedDomains: "theoncetimes.com" };
  const { body, meta } = request({ query: "a" }, settings);
  assert.deepEqual(body.excludeDomains, ["theoncetimes.com"]);
  assert.equal(meta.excludedDomainCount, 1);
  assert.equal(meta.filterSkipped, false);
});

test("请求体：设置里写整条网址，也能裁成域名后生效（不静默失效）", () => {
  const settings = {
    ...SETTINGS,
    blockedDomains: "https://theoncetimes.com/ai/some/article",
  };
  const { body } = request({ query: "a" }, settings);
  assert.deepEqual(body.excludeDomains, ["theoncetimes.com"]);
});

test("请求体：写错的条目被剔除并回传待警告", () => {
  const settings = { ...SETTINGS, blockedDomains: "theoncetimes.com, 不是域名" };
  const { body, meta } = request({ query: "a" }, settings);
  assert.deepEqual(body.excludeDomains, ["theoncetimes.com"]);
  assert.deepEqual(meta.blacklistRejected, ["不是域名"]);
});

test("请求体：category=company 时黑名单不发出去，并标记已跳过", () => {
  const settings = { ...SETTINGS, blockedDomains: "theoncetimes.com" };
  const { body, meta } = request({ query: "a", category: "company" }, settings);
  assert.equal(body.excludeDomains, undefined, "company 下发过滤会让结果静默清空");
  assert.equal(meta.filterSkipped, true);
  assert.equal(meta.filterSkipReason, "company");
  assert.equal(meta.blacklistSize, 1);
});

test("输出：跳过 Exa 侧过滤时在正文里说清楚，并声明本机过滤仍在", () => {
  const skipped = formatResults("q", { results: [] }, {
    type: "auto",
    filterSkipped: true,
    filterSkipReason: "company",
  });
  assert.match(skipped, /没有返回结果/);
  assert.match(skipped, /已跳过 Exa 侧的屏蔽/);
  assert.match(skipped, /本机过滤仍在生效/);

  const withHits = formatResults(
    "q",
    { results: [{ title: "t", url: "https://e.test/a", highlights: ["x"] }] },
    { type: "auto", filterSkipped: true, filterSkipReason: "people" },
  );
  assert.match(withHits, /category=people 时 Exa 不支持域名过滤/);

  const normal = formatResults(
    "q",
    { results: [{ title: "t", url: "https://e.test/a", highlights: ["x"] }] },
    { type: "auto", filterSkipped: false },
  );
  assert.doesNotMatch(normal, /已跳过/);
});

/* --------------------------------------------------------------- 请求体 */

test("默认请求：条数、类型、高亮带上限", () => {
  const { body } = request({ query: "向量数据库怎么选" });
  assert.deepEqual(body, {
    query: "向量数据库怎么选",
    numResults: 5,
    type: "auto",
    contents: { highlights: { maxCharacters: 1000 } },
  });
});

test("高亮上限设为 0 时交回 Exa 自行分配", () => {
  const settings = { ...SETTINGS, highlightsMaxCharacters: 0 };
  assert.deepEqual(request({ query: "a" }, settings).body.contents.highlights, true);
  assert.equal(request({ query: "a" }, settings).meta.highlightCap, 0);
});

test("高亮上限低于下限时抬到 100，超过上限时夹回", () => {
  const low = request({ query: "a" }, { ...SETTINGS, highlightsMaxCharacters: 20 });
  assert.deepEqual(low.body.contents.highlights, { maxCharacters: 100 });
  assert.equal(low.meta.highlightCap, 100);

  const high = request({ query: "a" }, { ...SETTINGS, highlightsMaxCharacters: 999999 });
  assert.deepEqual(high.body.contents.highlights, { maxCharacters: 20000 });

  const junk = request({ query: "a" }, { ...SETTINGS, highlightsMaxCharacters: "不是数字" });
  assert.deepEqual(junk.body.contents.highlights, { maxCharacters: 1000 });
});

 test("正文与高亮是两个独立旋钮", () => {
  const on = request({ query: "a", includeText: true, maxCharacters: 5000 });
  assert.deepEqual(on.body.contents.text, { maxCharacters: 5000 });
  assert.deepEqual(on.body.contents.highlights, { maxCharacters: 1000 });
});

test("numResults 会被夹到 1..25，非法值回落到默认", () => {
  assert.equal(request({ query: "a", numResults: 0 }).body.numResults, 1);
  assert.equal(request({ query: "a", numResults: 999 }).body.numResults, 25);
  assert.equal(request({ query: "a", numResults: 7.6 }).body.numResults, 8);
  assert.equal(request({ query: "a", numResults: "不是数字" }).body.numResults, 5);
});

test("非法 type 回落到设置里的默认值", () => {
  assert.equal(request({ query: "a", type: "semantic" }).body.type, "auto");
  assert.equal(request({ query: "a", type: "keyword" }).body.type, "keyword");
  assert.equal(
    request({ query: "a" }, { ...SETTINGS, defaultSearchType: "neural" }).body.type,
    "neural",
  );
});

test("只写日期的起止时间会被补足时分秒", () => {
  const { body } = request({
    query: "a",
    startPublishedDate: "2025-01-01",
    endPublishedDate: "2025-06-30",
  });
  assert.equal(body.startPublishedDate, "2025-01-01T00:00:00.000Z");
  assert.equal(body.endPublishedDate, "2025-06-30T23:59:59.999Z");
});

test("完整 ISO 时间按原值归一，无法解析的原样透传给 Exa", () => {
  assert.equal(normalizeDate("2025-03-02T08:30:00+08:00", false), "2025-03-02T00:30:00.000Z");
  assert.equal(normalizeDate("看不懂的日期", false), "看不懂的日期");
  assert.equal(normalizeDate("", false), null);
  assert.equal(normalizeDate(undefined, true), null);
});

test("域名列表会过滤空值与非数组", () => {
  const { body } = request({
    query: "a",
    includeDomains: ["arxiv.org", " ", null, "openai.com"],
    excludeDomains: "arxiv.org",
  });
  assert.deepEqual(body.includeDomains, ["arxiv.org", "openai.com"]);
  assert.equal(body.excludeDomains, undefined);
  assert.deepEqual(toDomainList(undefined), []);
});

test("category 与过长的空串都不会进请求体", () => {
  assert.equal(request({ query: "a" }).body.category, undefined);
  assert.equal(request({ query: "a", category: "  " }).body.category, undefined);
  assert.equal(request({ query: "a", category: "research paper" }).body.category, "research paper");
});

test("只有开启 includeText 才会带正文，并按 maxCharacters 截断", () => {
  const off = request({ query: "a" });
  assert.equal(off.body.contents.text, undefined);
  assert.equal(off.meta.includeText, false);

  const on = request({ query: "a", includeText: true, maxCharacters: 5000 });
  assert.deepEqual(on.body.contents.text, { maxCharacters: 5000 });

  const fallback = request({ query: "a", includeText: true, maxCharacters: 5 });
  assert.deepEqual(fallback.body.contents.text, { maxCharacters: 200 });
});

test("includeText 显式传 false 时压过设置里的默认开启", () => {
  const settings = { ...SETTINGS, includeTextByDefault: true };
  assert.equal(request({ query: "a", includeText: false }, settings).body.contents.text, undefined);
  assert.ok(request({ query: "a" }, settings).body.contents.text);
});

/* ----------------------------------------------------------------- 排版 */

test("没有结果时给出可行动的提示", () => {
  const text = formatResults("找不到的东西", { results: [] }, { type: "auto" });
  assert.match(text, /没有返回结果/);
  assert.match(text, /web_search/);
});

test("结果包含序号、标题、链接、日期作者与高亮", () => {
  const text = formatResults(
    "语义检索",
    {
      resolvedSearchType: "neural",
      searchTime: 312.4,
      results: [
        {
          title: "A Comprehensive Overview",
          url: "https://arxiv.org/abs/2307.06435",
          publishedDate: "2023-11-16T01:36:32.547Z",
          author: "Humza Naveed",
          score: 0.4600165784358978,
          highlights: ["第一段高亮", "第二段高亮"],
        },
      ],
    },
    { type: "neural" },
  );

  assert.match(text, /Exa 检索 · neural · 312ms/);
  assert.match(text, /1\. A Comprehensive Overview/);
  assert.match(text, /https:\/\/arxiv\.org\/abs\/2307\.06435/);
  assert.match(text, /发布 2023-11-16 · 作者 Humza Naveed · 相关度 0\.460/);
  assert.match(text, /› 第一段高亮/);
});

test("高亮最多取三条，缺失标题时不留空行", () => {
  const text = formatResults(
    "q",
    {
      results: [
        {
          url: "https://example.test/a",
          highlights: ["1", "2", "3", "4", "5"],
        },
      ],
    },
    { type: "auto" },
  );
  assert.match(text, /1\. \(无标题\)/);
  assert.match(text, /› 3/);
  assert.doesNotMatch(text, /› 4/);
});

/* ----------------------------------------------- 被上限切掉的高亮补省略号 */

const cutPayload = (highlights) => ({ results: [{ title: "t", url: "https://e.test/a", highlights }] });

 test("贴到上限且断在句中时，末尾补省略号并附一句说明", () => {
  // 真实形状：上限 1000，实测 995 字符，结尾停在 "current"。
  const body = "x".repeat(994) + "current";
  const text = formatResults("q", cutPayload([body]), { type: "auto", highlightCap: 1000 });
  assert.match(text, /current …/);
  assert.match(text, /末尾带 … 的高亮已贴到长度上限/);
  assert.match(text, /每条结果的高亮上限/);
});

test("贴到上限但结尾在句读上时不补（实测 2784/3000 那条）", () => {
  const body = "y".repeat(2780) + " 2025).";
  const text = formatResults("q", cutPayload([body]), { type: "auto", highlightCap: 3000 });
  assert.doesNotMatch(text, /…\s*$|\.\.\. /);
  assert.match(text, /2025\)\.(\n|$)/);
  assert.doesNotMatch(text, /末尾带 … 的高亮/);
});

test("没贴到上限的短高亮不会被标记", () => {
  const text = formatResults("q", cutPayload(["短到不会被切"]), {
    type: "auto",
    highlightCap: 1000,
  });
  assert.doesNotMatch(text, /…/);
  assert.doesNotMatch(text, /末尾带 … 的高亮/);
});

test("上限为 0（不设限）时永不补省略号", () => {
  const body = "z".repeat(8000) + "cut";
  const text = formatResults("q", cutPayload([body]), { type: "auto", highlightCap: 0 });
  assert.doesNotMatch(text, /末尾带 … 的高亮/);
  assert.match(text, /cut$/m);
});

test("多条高亮合计不足时不算贴上限，不标记", () => {
  const text = formatResults(
    "q",
    { results: [{ url: "https://e.test/a", highlights: ["a", "b", "c", "尾部被切"] }] },
    { type: "auto", highlightCap: 1000 },
  );
  assert.doesNotMatch(text, /…/);
});

test("highlightWasCut 的判据", () => {
  assert.equal(highlightWasCut([], 1000), false);
  assert.equal(highlightWasCut(["x".repeat(1000)], 0), false);
  assert.equal(highlightWasCut(["x".repeat(950)], 1000), true);
  assert.equal(highlightWasCut(["x".repeat(950) + "."], 1000), false);
  assert.equal(highlightWasCut(["x".repeat(899)], 1000), false);
  assert.equal(highlightWasCut(["a".repeat(500), "b".repeat(490) + "tail"], 1000), true);
  assert.ok(HIGHLIGHT_NEAR_CAP_RATIO > 0 && HIGHLIGHT_NEAR_CAP_RATIO < 1);
});

test("超长结果会被截断并说明还差几条", () => {
  const results = Array.from({ length: 25 }, (_, index) => ({
    title: `条目 ${index + 1}`,
    url: `https://example.test/${index + 1}`,
    text: "很长的正文。".repeat(600),
  }));
  const text = formatResults("q", { results }, { type: "auto", includeText: true });

  assert.ok(text.length <= OUTPUT_SOFT_LIMIT + 2000);
  assert.match(text, /因长度上限未展开/);
  assert.doesNotMatch(text, /25\. 条目 25/);
});

test("空白被收拾干净", () => {
  assert.equal(oneLine("  多   空\n行  "), "多 空 行");
  assert.equal(compactText("段落一。\n\n\n\n段落二。"), "段落一。\n\n段落二。");
  assert.equal(oneLine(null), "");
});

/* ----------------------------------------------------------------- 报错 */

test("HTTP 失败被翻成能照着做的中文", () => {
  const unauthorized = describeHttpFailure(
    401,
    { error: "Invalid API key.", tag: "INVALID_API_KEY" },
  );
  assert.match(unauthorized, /HTTP 401/);
  assert.match(unauthorized, /apiKey/);
  assert.match(unauthorized, /Invalid API key/);

  assert.match(describeHttpFailure(429, {}), /限流/);
  assert.match(describeHttpFailure(503, { tag: "SERVICE_OVERLOADED" }), /Exa 侧故障/);
  assert.match(describeHttpFailure(418, {}), /HTTP 418/);
});

test("clampInt 的边界", () => {
  assert.equal(clampInt(undefined, 1, 25, 5), 5);
  assert.equal(clampInt(null, 1, 25, 5), 5);
  assert.equal(clampInt(Infinity, 1, 25, 5), 5);
  assert.equal(clampInt(-3, 1, 25, 5), 1);
  assert.equal(clampInt("12", 1, 25, 5), 12);
  assert.equal(clampInt("", 1, 25, 5), 5);
  assert.equal(clampInt(true, 1, 25, 5), 5);
  assert.equal(clampInt(0, 1, 25, 5), 1);
});
