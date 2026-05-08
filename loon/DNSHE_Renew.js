/**
 * @name DNSHE 免费域名自动续期
 * @description 自动遍历多账号下的子域名并续期，支持智能跳过和分组通知。
 * * 配置方式 (在 Loon 的 BoxJs 或持久化存储中添加键值):
 * 键名: DNSHE_ACCOUNTS
 * 键值: 账户一:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;账户二:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa
 */

const API_BASE = "https://api005.dnshe.com/index.php";
const PREF_KEY = "DNSHE_ACCOUNTS";
// 默认配置（如果在 Loon 面板未设置，将使用此测试配置）
const defaultAccounts = "账户一:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy"; 

// 封装 Promise 请求
function request(options) {
    return new Promise((resolve, reject) => {
        const method = options.method ? options.method.toUpperCase() : "GET";
        const callback = (error, response, data) => {
            if (error) {
                reject(error);
            } else {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject("解析响应失败: " + data);
                }
            }
        };

        if (method === "POST") {
            $httpClient.post(options, callback);
        } else {
            $httpClient.get(options, callback);
        }
    });
}

// 延时函数，用于速率控制
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 计算剩余天数 (适配 iOS 日期格式)
function getRemainingDays(expiresAtStr) {
    if (!expiresAtStr) return null;
    const expireDate = new Date(expiresAtStr.replace(/-/g, '/'));
    const now = new Date();
    return Math.floor((expireDate - now) / (1000 * 60 * 60 * 24));
}

async function run() {
    const accountStr = $prefs.valueForKey(PREF_KEY) || defaultAccounts;
    const accounts = accountStr.split(";").filter(Boolean);
    
    if (accounts.length === 0 || accounts[0] === defaultAccounts) {
        $notification.post("DNSHE 续期", "⚠️ 未配置有效账号", "请在 Loon 中配置 DNSHE_ACCOUNTS 变量");
        return $done();
    }

    let notifyLogs = [];

    for (let acc of accounts) {
        const [accName, apiKey, apiSecret] = acc.split(":");
        if (!apiKey || !apiSecret) continue;

        let successList = [];
        let skipList = [];
        let failList = [];

        try {
            // 1. 获取子域名列表 (每页拉取最高 500 个以防遗漏)
            const listUrl = `${API_BASE}?m=domain_hub&endpoint=subdomains&action=list&per_page=500`;
            const listRes = await request({
                url: listUrl,
                headers: {
                    "X-API-Key": apiKey,
                    "X-API-Secret": apiSecret
                }
            });

            if (!listRes.success) {
                failList.push(`列表获取失败: ${listRes.message || listRes.error}`);
                continue;
            }

            const domains = listRes.subdomains || [];

            // 2. 遍历域名进行操作
            for (let domain of domains) {
                // 智能跳过：判断距离到期是否大于 180 天
                const remainingDays = getRemainingDays(domain.expires_at);
                if (remainingDays !== null && remainingDays > 180) {
                    skipList.push(`${domain.full_domain} (余${remainingDays}天)`);
                    continue;
                }

                // 3. 执行续期
                const renewUrl = `${API_BASE}?m=domain_hub&endpoint=subdomains&action=renew`;
                const renewRes = await request({
                    url: renewUrl,
                    method: "POST",
                    headers: {
                        "X-API-Key": apiKey,
                        "X-API-Secret": apiSecret,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ subdomain_id: domain.id })
                });

                if (renewRes.success) {
                    successList.push(`${domain.full_domain} (新到期:${renewRes.new_expires_at.split(' ')[0]})`);
                } else {
                    // 处理 API 接口抛出的"未进入续期窗口"状态码
                    if (renewRes.error_code === "renewal_not_yet_available") {
                        skipList.push(`${domain.full_domain} (未进入窗口)`);
                    } else {
                        failList.push(`${domain.full_domain} (${renewRes.message})`);
                    }
                }
                
                // 速率控制: 每次请求间隔 2.5 秒，确保不会超过默认 30请求/分钟的限制
                await sleep(2500); 
            }

            // 整理单账号报告
            let accReport = `👤 ${accName}\n`;
            accReport += `✅ 成功 (${successList.length}): ${successList.join(", ") || "无"}\n`;
            accReport += `⏭️ 跳过 (${skipList.length}): ${skipList.join(", ") || "无"}\n`;
            accReport += `❌ 失败 (${failList.length}): ${failList.join(", ") || "无"}`;
            notifyLogs.push(accReport);

        } catch (e) {
            notifyLogs.push(`👤 ${accName}\n❌ 执行异常: ${e.message || e}`);
        }
    }

    // 聚合发送通知
    $notification.post("DNSHE 域名自动化保活", `本次执行了 ${accounts.length} 个账号`, notifyLogs.join("\n\n"));
    $done();
}

run();
