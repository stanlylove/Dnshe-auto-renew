/**
 * @name DNSHE 免费域名自动续期 (Loon 修复版)
 * @description 自动遍历多账号下的子域名并续期，支持智能跳过和分组通知。
 * * 配置方式 (在 Loon 的 [Argument] 或持久化存储中添加):
 * 键名: DNSHE_ACCOUNTS
 * 键值: 账户一:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;账户二:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa
 */

const API_BASE = "https://api005.dnshe.com/index.php";
const PREF_KEY = "DNSHE_ACCOUNTS";
// 默认配置（如果在 Loon 未设置，将使用此配置，建议直接在这里填入您的密钥进行测试）
const defaultAccounts = "账户一:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy"; 

// 封装 Promise 请求 (适配 Loon)
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

// 计算剩余天数 
function getRemainingDays(expiresAtStr) {
    if (!expiresAtStr) return null;
    const expireDate = new Date(expiresAtStr.replace(/-/g, '/'));
    const now = new Date();
    return Math.floor((expireDate - now) / (1000 * 60 * 60 * 24));
}

async function run() {
    // 【关键修复】使用 Loon 的 $persistentStore.read() 读取配置
    let accountStr = defaultAccounts;
    try {
        if (typeof $persistentStore !== "undefined") {
            const readValue = $persistentStore.read(PREF_KEY);
            if (readValue) {
                accountStr = readValue;
            }
        }
    } catch (e) {
        console.log("读取环境变量失败，将使用默认配置: " + e);
    }

    const accounts = accountStr.split(";").filter(Boolean);
    
    if (accounts.length === 0 || accounts[0] === defaultAccounts) {
        $notification.post("DNSHE 续期⚠️", "未配置有效账号", `请在 Loon 中配置 ${PREF_KEY} 变量，或直接在代码顶部修改 defaultAccounts`);
        return $done();
    }

    let notifyLogs = [];

    for (let acc of accounts) {
        const parts = acc.split(":");
        if (parts.length < 3) continue;
        const accName = parts[0];
        const apiKey = parts[1];
        const apiSecret = parts[2];

        let successList = [];
        let skipList = [];
        let failList = [];

        try {
            // 1. 获取子域名列表
            const listUrl = `${API_BASE}?m=domain_hub&endpoint=subdomains&action=list&per_page=500`;
            const listRes = await request({
                url: listUrl,
                headers: {
                    "X-API-Key": apiKey,
                    "X-API-Secret": apiSecret
                }
            });

            if (!listRes.success) {
                failList.push(`列表获取失败: ${listRes.message || listRes.error || JSON.stringify(listRes)}`);
                notifyLogs.push(`👤 ${accName}\n❌ 失败: ${failList.join(", ")}`);
                continue;
            }

            const domains = listRes.subdomains || [];
            if (domains.length === 0) {
                notifyLogs.push(`👤 ${accName}\n⚠️ 账号下无域名`);
                continue;
            }

            // 2. 遍历域名进行操作
            for (let domain of domains) {
                const remainingDays = getRemainingDays(domain.expires_at);
                // 大于 180 天跳过
                if (remainingDays !== null && remainingDays > 180) {
                    skipList.push(`${domain.full_domain || domain.subdomain}(余${remainingDays}天)`);
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
                    const newExp = renewRes.new_expires_at ? renewRes.new_expires_at.split(' ')[0] : '成功';
                    successList.push(`${domain.full_domain || domain.subdomain} (${newExp})`);
                } else {
                    if (renewRes.error_code === "renewal_not_yet_available") {
                        skipList.push(`${domain.full_domain || domain.subdomain} (未进窗口)`);
                    } else {
                        failList.push(`${domain.full_domain || domain.subdomain} (${renewRes.message || "未知错误"})`);
                    }
                }
                
                // 速率控制: 每次请求间隔 2.5 秒
                await sleep(2500); 
            }

            // 整理单账号报告
            let accReport = `👤 ${accName}\n`;
            accReport += `✅ 成功 (${successList.length}): ${successList.join(", ") || "无"}\n`;
            accReport += `⏭️ 跳过 (${skipList.length}): ${skipList.join(", ") || "无"}\n`;
            accReport += `❌ 失败 (${failList.length}): ${failList.join(", ") || "无"}`;
            notifyLogs.push(accReport);

        } catch (e) {
            notifyLogs.push(`👤 ${accName}\n❌ 执行异常: ${e}`);
        }
    }

    $notification.post("DNSHE 域名自动化保活", `本次执行了 ${accounts.length} 个账号`, notifyLogs.join("\n\n"));
    $done();
}

// 捕获最外层的崩溃
run().catch(e => {
    $notification.post("DNSHE 脚本运行崩溃", "出现未捕获异常", String(e));
    $done();
});
