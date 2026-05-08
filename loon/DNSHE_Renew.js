/**
 * DNSHE 免费域名批量续期脚本 (Loon Cron)
 * 
 * 功能：
 * - 多账户支持，通过 argument 配置
 * - 自动获取账户下所有子域名并逐一续期
 * - 推送详细报告，按账户分组显示成功/跳过/失败
 * 
 * 参数格式（argument）：
 * 账户一:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;账户二:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa
 * （名称:APIKey:APISecret，多个账户用英文分号分隔）
 * 
 * 部署类型：cron
 * 推荐表达式：0 8 * * * (每天早上8点执行)
 * 超时时间：建议 600 秒 (timeout=600)
 */

const API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub";
const PER_PAGE = 200; // 每页域名数，最大500

// 解析账户信息
let accounts = [];
try {
    if (typeof $argument !== "string" || $argument.trim() === "") {
        throw new Error("未配置账户参数");
    }
    accounts = $argument.split(";").filter(s => s.trim()).map(item => {
        const parts = item.split(":");
        if (parts.length !== 3) throw new Error("账户格式错误: " + item);
        const [name, key, secret] = parts.map(s => s.trim());
        if (!name || !key || !secret) throw new Error("账户信息不完整");
        return { name, key, secret };
    });
    if (accounts.length === 0) throw new Error("无有效账户");
} catch (e) {
    $notification.post("DNSHE续期配置错误", e.message, "");
    $done();
}

// 封装 HTTP 请求为 Promise
function httpRequest(method, endpoint, action, data = null, key, secret) {
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
        }
        $httpClient[method.toLowerCase()](params, (err, resp, body) => {
            if (err) return reject(err);
            try {
                const json = JSON.parse(body);
                resolve(json);
            } catch (e) {
                reject("JSON解析失败: " + body);
            }
        });
    });
}

// 获取所有子域名 (递归分页)
async function getAllSubdomains(key, secret) {
    let allSubdomains = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
        const url = `${API_BASE}&endpoint=subdomains&action=list&page=${page}&per_page=${PER_PAGE}`;
        const headers = {
            "X-API-Key": key,
            "X-API-Secret": secret
        };
        const respJson = await new Promise((resolve, reject) => {
            $httpClient.get({ url, headers, timeout: 15000 }, (err, resp, body) => {
                if (err) return reject(err);
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject("分页解析失败: " + body);
                }
            });
        });
        if (!respJson.success) {
            throw new Error(`获取子域名列表失败: ${respJson.message || JSON.stringify(respJson)}`);
        }
        if (respJson.subdomains && Array.isArray(respJson.subdomains)) {
            allSubdomains = allSubdomains.concat(respJson.subdomains);
        }
        if (respJson.pagination && respJson.pagination.has_more) {
            page++;
        } else {
            hasMore = false;
        }
        // 简单速率保护
        await new Promise(r => setTimeout(r, 300));
    }
    return allSubdomains;
}

// 续期单个域名
async function renewDomain(subdomainId, key, secret) {
    const data = { subdomain_id: subdomainId };
    return await httpRequest("POST", "subdomains", "renew", data, key, secret);
}

// 处理单个账户
async function processAccount(account) {
    const { name, key, secret } = account;
    const result = {
        name,
        success: [],
        skipped: [],
        failed: [],
        summary: { success: 0, skipped: 0, failed: 0 }
    };
    try {
        const subdomains = await getAllSubdomains(key, secret);
        // 只续期 active 状态的域名 (可选项，也可全部尝试)
        const activeSubs = subdomains.filter(d => d.status === "active");
        for (const sub of activeSubs) {
            const domainName = sub.full_domain || sub.subdomain + "." + sub.rootdomain;
            try {
                const res = await renewDomain(sub.id, key, secret);
                if (res.success) {
                    const newExpiry = res.new_expires_at || "未知";
                    result.success.push(`${domainName} → 续期至 ${newExpiry}`);
                    result.summary.success++;
                } else {
                    const errorCode = res.error_code || "";
                    if (errorCode === "renewal_not_yet_available" || errorCode === "renewal_window_not_open") {
                        result.skipped.push(`${domainName} (尚未进入续期窗口)`);
                        result.summary.skipped++;
                    } else {
                        result.failed.push(`${domainName}: ${res.message || JSON.stringify(res)}`);
                        result.summary.failed++;
                    }
                }
            } catch (e) {
                result.failed.push(`${domainName}: 请求异常 - ${e}`);
                result.summary.failed++;
            }
            // 速率限制保护：每个续期间隔0.5秒
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (e) {
        result.failed.push(`获取域名列表失败: ${e}`);
        result.summary.failed++;
    }
    return result;
}

// 格式化报告
function formatReport(allResults) {
    const lines = [];
    const total = { success: 0, skipped: 0, failed: 0 };
    for (const res of allResults) {
        lines.push(`【${res.name}】`);
        if (res.success.length > 0) {
            lines.push(`✅ 成功 (${res.summary.success}):`);
            res.success.forEach(s => lines.push(`  ${s}`));
        }
        if (res.skipped.length > 0) {
            lines.push(`⏭️ 跳过 (${res.summary.skipped}):`);
            res.skipped.forEach(s => lines.push(`  ${s}`));
        }
        if (res.failed.length > 0) {
            lines.push(`❌ 失败 (${res.summary.failed}):`);
            res.failed.forEach(s => lines.push(`  ${s}`));
        }
        lines.push(""); // 空行分隔
        total.success += res.summary.success;
        total.skipped += res.summary.skipped;
        total.failed += res.summary.failed;
    }
    const summaryLine = `总计: ✅${total.success} ⏭️${total.skipped} ❌${total.failed}`;
    return { content: lines.join("\n"), summary: summaryLine };
}

(async () => {
    const results = [];
    for (const acc of accounts) {
        const res = await processAccount(acc);
        results.push(res);
    }
    const { content, summary } = formatReport(results);
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    $notification.post("DNSHE域名续期报告", `${dateStr}  ${summary}`, content);
    $done();
})();
