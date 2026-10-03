/**
 * DNSHE 免费域名批量续期 (Loon Cron)
 *
 * 功能：
 * - 多账户支持（BoxJs / 持久化配置优先，argument 备选）
 * - 自动获取所有子域名（分页）并逐个续期
 * - 将 "never expire" 的域名归为永久域名，不会判定为失败
 * - 即时推送详细报告，按成功/跳过/永久/失败分组
 *
 * BoxJs / 持久化 Key：DNSHE_RENEW_ACCOUNTS
 * 格式：账户一:APIKey:APISecret;账户二:APIKey:APISecret
 * 可选 argument：RENEW_WINDOW_DAYS=30（只续期剩余天数 <= 30 的域名，0 = 全部尝试）
 *
 * ⚠️ 本次修复（对齐 Loon 官方 Script API）：
 * 1. $notification.post(title, subtitle, body) 的 title / subtitle / body 必须是字符串。
 *    旧代码把「数组」作为 body 传入，数组被隐式转成字符串时元素分隔符变成逗号、
 *    换行全部丢失，通知里就变成一整坨逗号分隔的文字（即通知显示异常）。
 *    现统一用 formatReport() 生成带 \n 的字符串正文。
 * 2. 报告过长时主动分段推送，避免超长正文被系统截断。
 * 3. 旧代码在配置错误分支调用 $done() 后仍继续往下执行，会触发第二次 $done()；
 *    官方文档要求「每次脚本执行只应调用一次 $done()」，现已用 shutdown() 统一收口。
 * 4. console.log 改为单参数字符串形式（官方：当前接口按一次调用的一个主参数处理）。
 */
const API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub";
const PER_PAGE = 200;
const STORE_KEY = "DNSHE_RENEW_ACCOUNTS";

// ===== 通知与行为参数 =====
const NOTIFY_TITLE = "DNSHE 域名续期报告";
const NOTIFY_MAX_LEN = 800;   // 单条通知正文最大字符数，超出自动分段推送
const MAX_PAGES = 50;         // 分页保护，防止异常 has_more 造成死循环
const DEFAULT_RENEW_WINDOW_DAYS = 0; // 0 = 不做窗口过滤，全部尝试续期

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

// 可选：从 argument 读取续期窗口过滤（RENEW_WINDOW_DAYS=30 表示只续期剩余 <=30 天的域名）
function readRenewWindowDays(input) {
    if (!input) return DEFAULT_RENEW_WINDOW_DAYS;
    if (typeof input === "object" && input.RENEW_WINDOW_DAYS != null) {
        const n = parseInt(input.RENEW_WINDOW_DAYS, 10);
        return isNaN(n) || n < 0 ? DEFAULT_RENEW_WINDOW_DAYS : n;
    }
    const m = String(input).match(/RENEW_WINDOW_DAYS\s*=\s*"?(\d+)"?/);
    if (!m) return DEFAULT_RENEW_WINDOW_DAYS;
    const n = parseInt(m[1], 10);
    return isNaN(n) || n < 0 ? DEFAULT_RENEW_WINDOW_DAYS : n;
}
renewWindowDays = readRenewWindowDays(typeof $argument === "undefined" ? null : $argument);
if (renewWindowDays > 0) log("已启用续期窗口过滤: 仅续期剩余 <= " + renewWindowDays + " 天的域名");

// ========== 1. 读取配置（持久化 / BoxJs 优先，argument 备选） ==========
let accountStr = $persistentStore.read(STORE_KEY);
if (accountStr && String(accountStr).trim() !== "") {
    log("✅ 使用持久化(BoxJs)中的账户配置");
} else {
    log("⚠️ 持久化无配置，回退到 argument");
    accountStr = typeof $argument === "undefined" ? "" : $argument;
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
            if (k === "RENEW_WINDOW_DAYS") continue;
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
                log("    ⏭️ 跳过: " + note);
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
                        log("    ♾️ 永久域名: " + note);
                        result.permanent.push(note);
                        result.summary.permanent++;
                    } else {
                        const note = domain + " → 续期至 " + (res.new_expires_at || "未知");
                        log("    ✅ " + note);
                        result.success.push(note);
                        result.summary.success++;
                    }
                } else if (isNever) {
                    // 防御性处理：失败响应里也可能暗示永久域名
                    const note = domain + " (永久域名)";
                    log("    ♾️ 永久域名: " + note);
                    result.permanent.push(note);
                    result.summary.permanent++;
                } else if (res && res.error_code === "renewal_not_yet_available") {
                    const note = domain + " (未到续期窗口)";
                    log("    ⏭️ 跳过: " + note);
                    result.skipped.push(note);
                    result.summary.skipped++;
                } else {
                    const msg = errorText(res);
                    log("    ❌ 失败: " + domain + " - " + msg);
                    result.failed.push(domain + ": " + msg);
                    result.summary.failed++;
                }
            } catch (e) {
                const msg = e && e.message ? e.message : e;
                log("    ❌ 异常: " + domain + " - " + msg);
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

    log("--- " + acc.name + " 结果: ✅" + result.summary.success + " ♾️" + result.summary.permanent +
        " ⏭️" + result.summary.skipped + " ❌" + result.summary.failed + " ---");
    return result;
}

// ========== 5. 通知格式化（关键修复点） ==========
// 返回 { subtitle, body }，两者都是字符串，body 内部用 \n 换行
function formatReport(results) {
    const lines = [];
    const total = { success: 0, skipped: 0, permanent: 0, failed: 0 };

    results.forEach(function (r) {
        lines.push("【" + r.name + "】");
        if (r.success.length) lines.push("✅ 成功续期 (" + r.summary.success + ")", ...r.success.map(function (s) { return "  " + s; }));
        if (r.permanent.length) lines.push("♾️ 永久域名 (" + r.summary.permanent + ")", ...r.permanent.map(function (s) { return "  " + s; }));
        if (r.skipped.length) lines.push("⏭️ 跳过 (" + r.summary.skipped + ")", ...r.skipped.map(function (s) { return "  " + s; }));
        if (r.failed.length) lines.push("❌ 失败 (" + r.summary.failed + ")", ...r.failed.map(function (s) { return "  " + s; }));
        lines.push("");

        total.success += r.summary.success;
        total.permanent += r.summary.permanent;
        total.skipped += r.summary.skipped;
        total.failed += r.summary.failed;
    });

    const parts = [];
    if (total.success > 0) parts.push("✅" + total.success);
    if (total.permanent > 0) parts.push("♾️" + total.permanent);
    if (total.skipped > 0) parts.push("⏭️" + total.skipped);
    if (total.failed > 0) parts.push("❌" + total.failed);
    if (parts.length === 0) parts.push("无活跃域名");

    // 始终以“字符串”返回；绝不再把数组交给 $notification.post
    return {
        subtitle: parts.join(" "),
        body: lines.join("\n").trim() || "无活跃域名"
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

function reportSummaryText(total) {
    const parts = [];
    if (total.success > 0) parts.push("成功 " + total.success);
    if (total.permanent > 0) parts.push("永久 " + total.permanent);
    if (total.skipped > 0) parts.push("跳过 " + total.skipped);
    if (total.failed > 0) parts.push("失败 " + total.failed);
    return parts.length ? "共 " + parts.join(" / ") : "无活跃域名";
}

// ========== 6. 主流程 ==========
// 配置无效时已调用 shutdown()，这里直接跳过主流程
(async function main() {
    if (configInvalid) return;
    try {
        const results = [];
        for (const acc of accounts) {
            results.push(await processAccount(acc));
        }

        const report = formatReport(results);
        const dateStr = new Date().toLocaleString("zh-CN", { hour12: false });

        log("\n========== 续期报告 ==========\n" + report.body + "\n==============================");

        // scene：title 固定；subtitle 显示时间 + 汇总；body 为带换行的完整报告
        const scene = dateStr + "  " + report.subtitle;
        const chunks = splitBody(report.body, NOTIFY_MAX_LEN);
        for (let i = 0; i < chunks.length; i++) {
            let body = chunks[i];
            if (chunks.length > 1) {
                body = "(" + (i + 1) + "/" + chunks.length + ")\n" + body;
            }
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
