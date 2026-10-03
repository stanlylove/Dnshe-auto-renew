/**
 * DNSHE 免费域名批量续期 (Loon Cron)
 *
 * 功能：
 * - 多账户支持（BoxJs / 持久化配置优先，argument 备选）
 * - 自动获取所有子域名（分页）并逐个续期
 * - 将 "never expire" 的域名归为永久域名，不会判定为失败
 * - 通知以「数量」为主体，保证 iOS 通知横幅/折叠状态下也能直接看到数量
 *
 * BoxJs / 持久化 Key：DNSHE_RENEW_ACCOUNTS
 * 格式：账户一:APIKey:APISecret;账户二:APIKey:APISecret
 * 可选 argument：
 *   RENEW_WINDOW_DAYS=30   只续期剩余天数 <= 30 的域名（0 / 不填 = 全部尝试）
 *   NOTIFY_DETAIL=true     通知里附带具体域名列表（默认关闭，仅推数量）
 *
 * 通知版式（默认）：
 *   title    : DNSHE 域名续期报告
 *   subtitle : 2026/10/3 11:20  ✅3 ♾️1 ⏳5 ❌0
 *   body     : ✅成功续期 3 · ♾️永久 1 · ⏳暂时不用续期 5 · ❌失败 0
 *              【账号A】✅3 ♾️1 ⏳5 ❌0
 *              【账号B】✅2 ♾️0 ⏳4 ❌0
 *
 * ⚠️ 历次修复（对齐 Loon 官方 Script API）：
 * 1. $notification.post(title, subtitle, body) 三个参数都必须传「字符串」。
 *    旧代码把「数组」作为 body 传入，数组被隐式转成字符串时换行全部丢失、
 *    元素之间变成逗号，通知显示异常。
 * 2. 旧版报告以「域名列表」为主体，正文过长且每条只推一行【账号名】，
 *    iOS 通知横幅只显示正文前几行，关键数量被挤出可见区。
 *    现在改为「数量在前、域名为可选详情」，并把数量同步放进 subtitle。
 * 3. 旧代码在配置错误分支调用 $done() 后仍继续执行，会触发第二次 $done()；
 *    官方要求「每次脚本执行只应调用一次 $done()」，现用 shutdown() 统一收口。
 * 4. console.log 改为单参数字符串形式（官方：一次调用只处理一个主参数）。
 */
const API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub";
const PER_PAGE = 200;
const STORE_KEY = "DNSHE_RENEW_ACCOUNTS";

// ===== 通知与行为参数 =====
const NOTIFY_TITLE = "DNSHE 域名续期报告";
const NOTIFY_MAX_LEN = 800;           // 开启详情时单条通知正文上限，超出自动分段
const MAX_PAGES = 50;                 // 分页保护，防止异常 has_more 造成死循环
const DEFAULT_RENEW_WINDOW_DAYS = 0;  // 0 = 不做窗口过滤，全部尝试续期
let NOTIFY_DETAIL = false;            // 默认只推数量；true 时附带域名列表

// 状态图标：✅ 已续期 / ♾️ 永久域名 / ⏳ 暂时不用续期 / ❌ 失败
const ICON_SUCCESS = "✅";
const ICON_PERMANENT = "♾️";
const ICON_SKIPPED = "⏳";
const ICON_FAILED = "❌";
const LABEL_SUCCESS = "成功续期";
const LABEL_PERMANENT = "永久";
const LABEL_SKIPPED = "暂时不用续期";
const LABEL_FAILED = "失败";

// ===== 运行状态 =====
let isDone = false;
let renewWindowDays = DEFAULT_RENEW_WINDOW_DAYS;

// 结束脚本（幂等）：确保 $done() 只被调用一次
function shutdown() {
    if (isDone) return;
    isDone = true;
    $done();
}

// 单参数安全日志（官方文档：console.log 一次只处理一个主参数）
function log(msg) {
    try { console.log(String(msg)); } catch (e) { /* ignore */ }
}

// 发送通知：先把参数强制为字符串，再调用 Loon 官方接口
function notify(title, subtitle, body) {
    try {
        $notification.post(String(title == null ? "" : title),
            String(subtitle == null ? "" : subtitle),
            String(body == null ? "" : body));
    } catch (e) {
        log("通知发送失败: " + (e && e.message ? e.message : e));
    }
}

log("========== DNSHE 续期脚本开始 ==========");
log("执行时间: " + new Date().toLocaleString());

// ========== 0. 读取可选 argument ==========
function readArgNumber(input, name, dflt) {
    if (!input) return dflt;
    if (typeof input === "object" && input[name] != null) {
        const n = parseInt(input[name], 10);
        return isNaN(n) || n < 0 ? dflt : n;
    }
    const m = String(input).match(new RegExp(name + "\\s*=\\s*\"?(\\d+)\"?"));
    if (!m) return dflt;
    const n = parseInt(m[1], 10);
    return isNaN(n) || n < 0 ? dflt : n;
}

function readArgBool(input, name) {
    if (!input) return false;
    if (typeof input === "object" && input[name] != null) return /^(1|true|yes|on)$/i.test(String(input[name]));
    return new RegExp(name + "\\s*=\\s*\"?(1|true|yes|on)\"?", "i").test(String(input));
}

const rawArgument = typeof $argument === "undefined" ? null : $argument;
renewWindowDays = readArgNumber(rawArgument, "RENEW_WINDOW_DAYS", DEFAULT_RENEW_WINDOW_DAYS);
NOTIFY_DETAIL = readArgBool(rawArgument, "NOTIFY_DETAIL");
if (renewWindowDays > 0) log("已启用续期窗口过滤: 仅续期剩余 <= " + renewWindowDays + " 天的域名");
log("通知详情(域名列表): " + (NOTIFY_DETAIL ? "开启" : "关闭(仅推数量)"));

// ========== 1. 读取配置（持久化 / BoxJs 优先，argument 备选） ==========
let accountStr = $persistentStore.read(STORE_KEY);
if (accountStr && String(accountStr).trim() !== "") {
    log("✅ 使用持久化(BoxJs)中的账户配置");
} else {
    log("⚠️ 持久化无配置，回退到 argument");
    accountStr = rawArgument;
}

// Loon 的 $argument 既可能是字符串，也可能是插件参数对象，统一转换为字符串
function normalizeConfig(input) {
    if (input === null || typeof input === "undefined") return "";
    if (typeof input === "string") return input;
    if (typeof input === "object") {
        if (typeof input[STORE_KEY] === "string") return input[STORE_KEY];
        if (typeof input.accounts === "string") return input.accounts;
        const wanted = [];
        for (const k in input) {
            if (k === "RENEW_WINDOW_DAYS" || k === "NOTIFY_DETAIL") continue;
            const v = input[k];
            if (typeof v === "string" || typeof v === "number") wanted.push(k + ":" + String(v));
        }
        return wanted.join(";");
    }
    return String(input);
}

const configStr = normalizeConfig(accountStr).trim();
let accounts = [];
const parseErrors = [];
if (configStr === "") {
    parseErrors.push("未配置账户参数（持久化与 argument 均为空）");
} else {
    configStr.split(";").forEach(function (item) {
        const line = item.trim();
        if (!line) return;
        const parts = line.split(":");
        if (parts.length !== 3) {
            parseErrors.push("格式错误: " + line);
            return;
        }
        const name = String(parts[0]).trim();
        const key = String(parts[1]).trim();
        const secret = String(parts[2]).trim();
        if (!name || !key || !secret) {
            parseErrors.push("信息不完整: " + line);
            return;
        }
        accounts.push({ name: name, key: key, secret: secret });
    });
}

const configInvalid = accounts.length === 0;
if (configInvalid) {
    const reason = parseErrors.length ? parseErrors.join("\n") : "无有效账户";
    log("账户解析失败: " + reason);
    notify("DNSHE续期配置错误", reason, "请到 BoxJs 填写 " + STORE_KEY + "，或设置脚本 argument。");
    shutdown(); // 统一收口，避免继续走到主流程造成第二次 $done()
} else {
    log("解析到 " + accounts.length + " 个账户: " + accounts.map(function (a) { return a.name; }).join(", "));
}

// ========== 2. 网络请求封装 ==========
function toText(body) {
    if (body === null || typeof body === "undefined") return "";
    return typeof body === "string" ? body : String(body);
}

function trimBody(text) {
    const t = toText(text).replace(/\s+/g, " ").trim();
    return t.length > 120 ? t.slice(0, 120) + "…" : t;
}

function parseJson(body) {
    const text = toText(body);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error("响应不是合法 JSON: " + trimBody(text));
    }
}

// 统一取错误描述：优先 message（V2.0），兼容旧版 error 字段
function errorText(json) {
    if (!json || typeof json !== "object") return "未知错误";
    return String(json.message || json.error || "未知错误");
}

function sendRequest(method, endpoint, action, data, key, secret) {
    const url = API_BASE + "&endpoint=" + endpoint + "&action=" + action;
    const params = {
        url: url,
        headers: {
            "X-API-Key": key,
            "X-API-Secret": secret,
            "Content-Type": "application/json"
        },
        timeout: 15000
    };
    if (method === "POST" || method === "PUT") {
        params.body = JSON.stringify(data || {});
        log("  " + method + " " + action + " (endpoint=" + endpoint + ")");
    } else {
        log("  GET " + action + " (endpoint=" + endpoint + ")");
    }
    return new Promise(function (resolve, reject) {
        $httpClient[method.toLowerCase()](params, function (err, resp, body) {
            if (err) {
                log("  HTTP错误: " + (err && err.message ? err.message : err));
                return reject(new Error(String(err && err.message ? err.message : err)));
            }
            try {
                resolve(parseJson(body));
            } catch (e) {
                log("  " + e.message);
                reject(e);
            }
        });
    });
}

// ========== 3. 获取所有子域名（分页） ==========
async function getAllSubdomains(key, secret) {
    let all = [];
    let page = 1;
    while (page <= MAX_PAGES) {
        const url = API_BASE + "&endpoint=subdomains&action=list&page=" + page + "&per_page=" + PER_PAGE;
        log("  获取子域名列表 第" + page + "页...");
        const json = await new Promise(function (resolve, reject) {
            $httpClient.get({
                url: url,
                headers: { "X-API-Key": key, "X-API-Secret": secret },
                timeout: 15000
            }, function (err, resp, body) {
                if (err) return reject(new Error(String(err && err.message ? err.message : err)));
                try {
                    resolve(parseJson(body));
                } catch (e) {
                    reject(e);
                }
            });
        });

        if (!json || json.success !== true) {
            throw new Error("获取列表失败: " + errorText(json));
        }

        const list = Array.isArray(json.subdomains) ? json.subdomains : [];
        all = all.concat(list);
        log("  第" + page + "页获取到 " + list.length + " 个域名");

        // 优先使用 pagination.has_more，其次兼容 count，避免重复请求同一页
        let hasMore = false;
        if (json.pagination && typeof json.pagination === "object") {
            hasMore = json.pagination.has_more === true;
        } else {
            hasMore = list.length >= PER_PAGE;
        }
        if (!hasMore) break;
        page++;
        await new Promise(function (r) { setTimeout(r, 300); });
    }
    log("  总共获取到 " + all.length + " 个域名");
    return all;
}

// ========== 4. 处理单个账户 ==========
// 是否处于续期窗口内（仅在接口返回过期时间时生效，拿不到时间就照旧尝试）
function withinRenewWindow(sub) {
    if (!renewWindowDays || renewWindowDays <= 0) return true;
    const raw = sub.expires_at;
    if (!raw) return true;
    const ms = Date.parse(String(raw).replace(" ", "T"));
    if (isNaN(ms)) return true;
    return ((ms - Date.now()) / 86400000) <= renewWindowDays;
}

function daysLeftText(sub) {
    const raw = sub.expires_at;
    if (!raw) return "";
    const ms = Date.parse(String(raw).replace(" ", "T"));
    if (isNaN(ms)) return "";
    return " (剩余 " + Math.max(0, Math.floor((ms - Date.now()) / 86400000)) + " 天)";
}

async function processAccount(acc) {
    log("--- 开始处理账户: " + acc.name + " ---");
    const result = {
        name: acc.name,
        success: [],
        skipped: [],
        permanent: [],   // 永久域名
        failed: [],
        summary: { success: 0, skipped: 0, permanent: 0, failed: 0 }
    };

    try {
        const subs = await getAllSubdomains(acc.key, acc.secret);
        const active = subs.filter(function (d) { return d && d.status === "active"; });
        log("  活跃域名: " + active.length);

        for (const sub of active) {
            const domain = sub.full_domain || (sub.subdomain + "." + sub.rootdomain);
            log("  续期: " + domain + " (id=" + sub.id + ")");

            if (!withinRenewWindow(sub)) {
                const note = domain + daysLeftText(sub) + " 未到续期窗口";
                log("    " + ICON_SKIPPED + " 暂时不用续期: " + note);
                result.skipped.push(note);
                result.summary.skipped++;
                continue;
            }

            try {
                const res = await sendRequest("POST", "subdomains", "renew", { subdomain_id: sub.id }, acc.key, acc.secret);
                const isNever = res && (res.never_expires === 1 || res.never_expires === true ||
                    /never\s*expire/i.test(String(res.message || "")));

                if (res && res.success === true) {
                    if (isNever) {
                        const note = domain + " (永久域名)";
                        log("    " + ICON_PERMANENT + " 永久域名: " + note);
                        result.permanent.push(note);
                        result.summary.permanent++;
                    } else {
                        const note = domain + " → 续期至 " + (res.new_expires_at || "未知");
                        log("    " + ICON_SUCCESS + " " + note);
                        result.success.push(note);
                        result.summary.success++;
                    }
                } else if (isNever) {
                    // 防御性处理：失败响应里也可能暗示永久域名
                    const note = domain + " (永久域名)";
                    log("    " + ICON_PERMANENT + " 永久域名: " + note);
                    result.permanent.push(note);
                    result.summary.permanent++;
                } else if (res && res.error_code === "renewal_not_yet_available") {
                    const note = domain + " (未到续期窗口)";
                    log("    " + ICON_SKIPPED + " 暂时不用续期: " + note);
                    result.skipped.push(note);
                    result.summary.skipped++;
                } else {
                    const msg = errorText(res);
                    log("    " + ICON_FAILED + " 失败: " + domain + " - " + msg);
                    result.failed.push(domain + ": " + msg);
                    result.summary.failed++;
                }
            } catch (e) {
                const msg = e && e.message ? e.message : e;
                log("    " + ICON_FAILED + " 异常: " + domain + " - " + msg);
                result.failed.push(domain + ": 请求异常 - " + msg);
                result.summary.failed++;
            }
            await new Promise(function (r) { setTimeout(r, 500); });
        }
    } catch (e) {
        const msg = e && e.message ? e.message : e;
        log("  致命错误: " + msg);
        result.failed.push("账户级错误: " + msg);
        result.summary.failed++;
    }

    log("--- " + acc.name + " 结果: " + ICON_SUCCESS + result.summary.success + " " + ICON_PERMANENT + result.summary.permanent +
        " " + ICON_SKIPPED + result.summary.skipped + " " + ICON_FAILED + result.summary.failed + " ---");
    return result;
}

// ========== 5. 通知格式化（关键修复点） ==========
// 汇总一行：✅成功续期 3 · ♾️永久 1 · ⏳暂时不用续期 5 · ❌失败 0
function buildCountLine(s) {
    return ICON_SUCCESS + LABEL_SUCCESS + " " + s.success +
        " · " + ICON_PERMANENT + LABEL_PERMANENT + " " + s.permanent +
        " · " + ICON_SKIPPED + LABEL_SKIPPED + " " + s.skipped +
        " · " + ICON_FAILED + LABEL_FAILED + " " + s.failed;
}

// 紧凑一行（放 subtitle / 每行一个账号）：✅3 ♾️1 ⏳5 ❌0
function buildCompactCounts(s) {
    return ICON_SUCCESS + s.success + " " + ICON_PERMANENT + s.permanent +
        " " + ICON_SKIPPED + s.skipped + " " + ICON_FAILED + s.failed;
}

function buildDetailLines(r) {
    const lines = [];
    if (r.success.length) lines.push(ICON_SUCCESS + " " + LABEL_SUCCESS + " (" + r.summary.success + ")", ...r.success.map(function (s) { return "  " + s; }));
    if (r.permanent.length) lines.push(ICON_PERMANENT + " " + LABEL_PERMANENT + " (" + r.summary.permanent + ")", ...r.permanent.map(function (s) { return "  " + s; }));
    if (r.skipped.length) lines.push(ICON_SKIPPED + " " + LABEL_SKIPPED + " (" + r.summary.skipped + ")", ...r.skipped.map(function (s) { return "  " + s; }));
    if (r.failed.length) lines.push(ICON_FAILED + " " + LABEL_FAILED + " (" + r.summary.failed + ")", ...r.failed.map(function (s) { return "  " + s; }));
    return lines;
}

function formatReport(results) {
    const total = { success: 0, skipped: 0, permanent: 0, failed: 0 };
    results.forEach(function (r) {
        total.success += r.summary.success;
        total.permanent += r.summary.permanent;
        total.skipped += r.summary.skipped;
        total.failed += r.summary.failed;
    });

    // 正文第一行 = 总数量（保证折叠状态下就能看到数量）
    const lines = [buildCountLine(total)];

    // 每个账号一行紧凑数量。多账号时（本场景）折叠状态即可看全每行数量；
    // 单账号时也保留该行，便于与其他账号的推送格式保持一致
    results.forEach(function (r) {
        lines.push("【" + r.name + "】" + buildCompactCounts(r.summary));
    });

    // 详情：默认关闭；只在用户开启 NOTIFY_DETAIL 或出现失败时附加，避免刷屏
    if (NOTIFY_DETAIL || total.failed > 0) {
        let groups = [];
        results.forEach(function (r) {
            const detail = buildDetailLines(r);
            if (detail.length) {
                if (results.length > 1) groups.push("【" + r.name + "】");
                groups = groups.concat(detail);
            }
        });
        if (groups.length) {
            lines.push("");
            lines.push.apply(lines, groups);
        }
    }

    return {
        subtitle: buildCompactCounts(total),
        body: lines.join("\n")
    };
}

// 超长正文按行分段，避免通知正文被截断
function splitBody(text, max) {
    const lines = String(text).split("\n");
    const chunks = [];
    let cur = "";
    lines.forEach(function (line) {
        const next = cur ? cur + "\n" + line : line;
        if (next.length > max && cur) {
            chunks.push(cur);
            cur = line;
        } else {
            cur = next;
        }
    });
    if (cur) chunks.push(cur);
    return chunks.length ? chunks : [""];
}

// ========== 6. 主流程 ==========
(async function main() {
    if (configInvalid) return; // 配置无效时已 shutdown()

    try {
        const results = [];
        for (const acc of accounts) {
            results.push(await processAccount(acc));
        }

        const report = formatReport(results);
        const dateStr = new Date().toLocaleString("zh-CN", { hour12: false });
        // subtitle = 时间 + 总数量；body 第一行同样是总数量
        const scene = dateStr + "  " + report.subtitle;

        log("\n========== 续期报告 ==========\n" + report.body + "\n==============================");

        const chunks = splitBody(report.body, NOTIFY_MAX_LEN);
        for (let i = 0; i < chunks.length; i++) {
            let body = chunks[i];
            if (chunks.length > 1) body = "(" + (i + 1) + "/" + chunks.length + ")\n" + body;
            notify(NOTIFY_TITLE, scene, body);
            if (i < chunks.length - 1) {
                await new Promise(function (r) { setTimeout(r, 800); });
            }
        }

        shutdown();
    } catch (e) {
        const msg = e && e.message ? e.message : e;
        log("脚本执行异常: " + msg);
        notify(NOTIFY_TITLE, "执行异常", "DNSHE 续期脚本执行异常: " + msg);
        shutdown();
    }
}());
