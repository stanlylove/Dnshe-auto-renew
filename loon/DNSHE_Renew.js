/**
 * DNSHE 免费域名批量续期 (Loon Cron)
 * 
 * 功能：
 * - 多账户支持（BoxJs 订阅配置优先，argument 备选）
 * - 自动获取所有子域名并续期
 * - 将 "never expire" 的域名归为永久域名，不会判定为失败
 * - 即时推送详细报告，按成功/跳过/永久/失败分组
 * 
 * BoxJs Key：DNSHE_RENEW_ACCOUNTS
 * 格式：账户一:APIKey:APISecret;账户二:APIKey:APISecret
 */
const API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub";
const PER_PAGE = 200;
const STORE_KEY = "DNSHE_RENEW_ACCOUNTS";

console.log("========== DNSHE 续期脚本开始 ==========");
console.log("执行时间: " + new Date().toLocaleString());

// ========== 1. 读取配置（BoxJs 优先） ==========
let accountStr = $persistentStore.read(STORE_KEY);
if (accountStr && accountStr.trim() !== "") {
    console.log("✅ 使用 BoxJs 中的账户配置");
} else {
    console.log("⚠️ BoxJs 无配置，回退到 argument");
    accountStr = $argument;
}

let accounts = [];
try {
    if (typeof accountStr !== "string" || accountStr.trim() === "") {
        throw new Error("未配置账户参数（BoxJs 或 argument 均为空）");
    }
    accounts = accountStr.split(";").filter(s => s.trim()).map(item => {
        const parts = item.split(":");
        if (parts.length !== 3) throw new Error("格式错误: " + item);
        const [name, key, secret] = parts.map(s => s.trim());
        if (!name || !key || !secret) throw new Error("信息不完整");
        return { name, key, secret };
    });
    console.log(`解析到 ${accounts.length} 个账户: ${accounts.map(a => a.name).join(", ")}`);
    if (accounts.length === 0) throw new Error("无有效账户");
} catch (e) {
    console.log("账户解析失败: " + e.message);
    $notification.post("DNSHE续期配置错误", e.message, "");
    $done();
}

// ========== 2. 网络请求封装 ==========
function httpRequest(method, endpoint, action, data, key, secret) {
    const url = `${API_BASE}&endpoint=${endpoint}&action=${action}`;
    const headers = {
        "X-API-Key": key,
        "X-API-Secret": secret,
        "Content-Type": "application/json"
    };
    return new Promise((resolve, reject) => {
        const params = { url, headers, timeout: 15000 };
        if (method === "POST" || method === "PUT") {
            params.body = JSON.stringify(data || {});
            console.log(`  POST ${action} for subdomain_id=${data?.subdomain_id}`);
        } else {
            console.log(`  GET ${action} (endpoint=${endpoint})`);
        }
        $httpClient[method.toLowerCase()](params, (err, resp, body) => {
            if (err) {
                console.log(`  HTTP错误: ${err}`);
                return reject(err);
            }
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                console.log(`  JSON解析失败: ${body}`);
                reject("JSON解析失败");
            }
        });
    });
}

// ========== 3. 获取所有子域名（分页） ==========
async function getAllSubdomains(key, secret) {
    let all = [];
    let page = 1, hasMore = true;
    while (hasMore) {
        const url = `${API_BASE}&endpoint=subdomains&action=list&page=${page}&per_page=${PER_PAGE}`;
        console.log(`  获取子域名列表 第${page}页...`);
        const json = await new Promise((resolve, reject) => {
            $httpClient.get({ url, headers: { "X-API-Key": key, "X-API-Secret": secret }, timeout: 15000 }, (err, resp, body) => {
                if (err) return reject(err);
                try { resolve(JSON.parse(body)); } catch (e) { reject("分页解析失败"); }
            });
        });
        if (!json.success) throw new Error(`获取列表失败: ${json.message}`);
        all = all.concat(json.subdomains || []);
        console.log(`  第${page}页获取到 ${json.subdomains?.length || 0} 个域名`);
        hasMore = json.pagination?.has_more;
        page++;
        await new Promise(r => setTimeout(r, 300));
    }
    console.log(`  总共获取到 ${all.length} 个域名`);
    return all;
}

// ========== 4. 处理单个账户 ==========
async function processAccount(acc) {
    console.log(`\n--- 开始处理账户: ${acc.name} ---`);
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
        const active = subs.filter(d => d.status === "active");
        console.log(`  活跃域名: ${active.length}`);
        for (const sub of active) {
            const domain = sub.full_domain || `${sub.subdomain}.${sub.rootdomain}`;
            console.log(`  续期: ${domain} (id=${sub.id})`);
            try {
                const res = await httpRequest("POST", "subdomains", "renew", { subdomain_id: sub.id }, acc.key, acc.secret);
                if (res.success) {
                    // 检查是否为永久域名
                    if (res.never_expires === 1 || (res.message && res.message.toLowerCase().includes("never expire"))) {
                        const msg = `${domain} (永久域名)`;
                        console.log(`    ♾️ 永久域名: ${msg}`);
                        result.permanent.push(msg);
                        result.summary.permanent++;
                    } else {
                        const newExpiry = res.new_expires_at || "未知";
                        const msg = `${domain} → 续期至 ${newExpiry}`;
                        console.log(`    ✅ ${msg}`);
                        result.success.push(msg);
                        result.summary.success++;
                    }
                } else {
                    const code = res.error_code || "";
                    const msg = res.message || JSON.stringify(res);
                    // 对于续期失败的响应也检查一下是否暗示永久域名（防御性处理）
                    if (res.never_expires === 1 || (res.message && res.message.toLowerCase().includes("never expire"))) {
                        const note = `${domain} (永久域名)`;
                        console.log(`    ♾️ 永久域名: ${note}`);
                        result.permanent.push(note);
                        result.summary.permanent++;
                    } else if (code === "renewal_not_yet_available") {
                        console.log(`    ⏭️ 跳过: ${domain} (未到窗口)`);
                        result.skipped.push(`${domain} (未到续期窗口)`);
                        result.summary.skipped++;
                    } else {
                        console.log(`    ❌ 失败: ${domain} - ${msg}`);
                        result.failed.push(`${domain}: ${msg}`);
                        result.summary.failed++;
                    }
                }
            } catch (e) {
                console.log(`    ❌ 异常: ${domain} - ${e}`);
                result.failed.push(`${domain}: 请求异常 - ${e}`);
                result.summary.failed++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (e) {
        console.log(`  致命错误: ${e}`);
        result.failed.push(`账户级错误: ${e}`);
        result.summary.failed++;
    }
    console.log(`--- ${acc.name} 结果: ✅${result.summary.success} ♾️${result.summary.permanent} ⏭️${result.summary.skipped} ❌${result.summary.failed} ---`);
    return result;
}

// ========== 5. 通知格式化 ==========
function formatReport(results) {
    const lines = [], total = { success: 0, skipped: 0, permanent: 0, failed: 0 };
    for (const r of results) {
        lines.push(`【${r.name}】`);
        if (r.success.length) lines.push(`✅ 成功续期 (${r.summary.success}):`, ...r.success.map(s => `  ${s}`));
        if (r.permanent.length) lines.push(`♾️ 永久域名 (${r.summary.permanent}):`, ...r.permanent.map(s => `  ${s}`));
        if (r.skipped.length) lines.push(`⏭️ 跳过 (${r.summary.skipped}):`, ...r.skipped.map(s => `  ${s}`));
        if (r.failed.length) lines.push(`❌ 失败 (${r.summary.failed}):`, ...r.failed.map(s => `  ${s}`));
        lines.push("");
        total.success += r.summary.success;
        total.permanent += r.summary.permanent;
        total.skipped += r.summary.skipped;
        total.failed += r.summary.failed;
    }
    const parts = [];
    if (total.success > 0) parts.push(`✅${total.success}`);
    if (total.permanent > 0) parts.push(`♾️${total.permanent}`);
    if (total.skipped > 0) parts.push(`⏭️${total.skipped}`);
    if (total.failed > 0) parts.push(`❌${total.failed}`);
    const summary = `总计: ${parts.join(" ")}`;
    return { content: lines.join("\n"), summary };
}

// ========== 6. 主流程 ==========
(async () => {
    const results = [];
    for (const acc of accounts) results.push(await processAccount(acc));
    const { content, summary } = formatReport(results);
    const dateStr = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log("\n========== 续期报告 ==========\n" + content + "\n==============================");
    $notification.post("DNSHE域名续期报告", `${dateStr}  ${summary}`, content);
    $done();
})();
