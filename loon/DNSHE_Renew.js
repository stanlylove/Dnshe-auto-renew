// DNSHE 多账号自动续期脚本 for Loon  
// 参数格式: tg_bot=<Token>;tg_chatid=<ID>;pushplus=<Token>;账户名:APIKey:APISecret;...  
// 示例: tg_bot=123456:AAF...;tg_chatid=123456789;账户一:cfsd_xxx:yyy;账户二:cfsd_zzz:aaa  
  
const API_BASE = 'https://api005.dnshe.com/index.php?m=domain_hub&endpoint=subdomains';  
const RENEW_WINDOW_DAYS = 180;  
const REQUEST_DELAY = 1500; // 毫秒，防速率限制  
  
function sleep(ms) {  
    return new Promise(resolve => setTimeout(resolve, ms));  
}  
  
// 封装 $httpClient 为 Promise  
function httpRequest(method, url, headers, body = null) {  
    return new Promise((resolve, reject) => {  
        const params = { url, headers, timeout: 15000 };  
        if (body) {  
            params.body = JSON.stringify(body);  
        }  
        $httpClient[method.toLowerCase()](params, (err, resp, data) => {  
            if (err) reject(`HTTP request failed: ${err}`);  
            else {  
                try {  
                    resolve({ status: resp.status, body: JSON.parse(data) });  
                } catch (e) {  
                    reject(`Invalid JSON response: ${data}`);  
                }  
            }  
        });  
    });  
}  
  
// 解析 argument 配置  
function parseConfig(arg) {  
    const accounts = [];  
    let tgBot = null, tgChatid = null, pushplusToken = null;  
    if (!arg) return { accounts, tgBot, tgChatid, pushplusToken };  
    arg.split(';').map(s => s.trim()).filter(Boolean).forEach(item => {  
        if (item.includes('=')) {  
            const [k, v] = item.split('=').map(s => s.trim());  
            if (k === 'tg_bot') tgBot = v;  
            else if (k === 'tg_chatid') tgChatid = v;  
            else if (k === 'pushplus') pushplusToken = v;  
        } else if (item.includes(':')) {  
            const parts = item.split(':');  
            if (parts.length === 3) {  
                accounts.push({ name: parts[0].trim(), apiKey: parts[1].trim(), apiSecret: parts[2].trim() });  
            } else if (parts.length === 2) {  
                accounts.push({ name: `账户${accounts.length + 1}`, apiKey: parts[0].trim(), apiSecret: parts[1].trim() });  
            }  
        }  
    });  
    return { accounts, tgBot, tgChatid, pushplusToken };  
}  
  
// 分页获取全部子域名  
async function fetchAllSubdomains(apiKey, apiSecret) {  
    let all = [];  
    let page = 1;  
    const perPage = 500;  
    const fields = 'id,full_domain,status,expires_at';  
    while (true) {  
        const url = `${API_BASE}&action=list&page=${page}&per_page=${perPage}&fields=${fields}`;  
        const { status, body } = await httpRequest('GET', url, { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret });  
        if (status !== 200 || !body.success) throw new Error(`List error: ${JSON.stringify(body)}`);  
        all = all.concat(body.subdomains || []);  
        if (body.pagination?.has_more) { page++; await sleep(1000); }  
        else break;  
    }  
    return all;  
}  
  
// 续期单个域名  
async function renewSubdomain(apiKey, apiSecret, subdomainId) {  
    const url = `${API_BASE}&action=renew`;  
    const headers = { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret, 'Content-Type': 'application/json' };  
    const { status, body } = await httpRequest('POST', url, headers, { subdomain_id: subdomainId });  
    return { success: status === 200 && body.success, data: body };  
}  
  
// 判断是否进入续期窗口（到期前180天，包含已过期30天内）  
function isInRenewWindow(expiresStr) {  
    if (!expiresStr) return false;  
    const d = new Date(expiresStr.replace(' ', 'T') + '+08:00'); // 假设北京时间  
    if (isNaN(d.getTime())) return false;  
    const diffDays = (d.getTime() - Date.now()) / 86400000;  
    return diffDays <= RENEW_WINDOW_DAYS && diffDays >= -30;  
}  
  
// 发送 Telegram 通知  
function sendTelegram(botToken, chatId, text) {  
    $httpClient.post({  
        url: `https://api.telegram.org/bot${botToken}/sendMessage`,  
        headers: { 'Content-Type': 'application/json' },  
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })  
    }, (err) => err && $notification.post('DNSHE', 'Telegram发送失败', err));  
}  
  
// 发送 PushPlus 通知  
function sendPushPlus(token, text) {  
    $httpClient.post({  
        url: 'http://www.pushplus.plus/send',  
        headers: { 'Content-Type': 'application/json' },  
        body: JSON.stringify({ token, title: 'DNSHE Renew Report', content: text, template: 'html' })  
    }, (err) => err && $notification.post('DNSHE', 'PushPlus发送失败', err));  
}  
  
// 主流程  
async function main() {  
    const { accounts, tgBot, tgChatid, pushplusToken } = parseConfig(typeof $argument !== 'undefined' ? $argument : '');  
    if (!accounts.length) {  
        $notification.post('DNSHE Renew', '无有效账户', '请在参数中配置账户');  
        return;  
    }  
  
    const report = [];  
    for (const acc of accounts) {  
        let domains;  
        try {  
            domains = await fetchAllSubdomains(acc.apiKey, acc.apiSecret);  
        } catch (e) {  
            report.push({ account: acc.name, error: `获取域名失败: ${e}` });  
            continue;  
        }  
        const success = [], skipped = [], failed = [];  
        for (const d of domains) {  
            const name = d.full_domain || 'unknown';  
            if (d.status !== 'active') { skipped.push(`${name} (状态:${d.status})`); continue; }  
            if (!isInRenewWindow(d.expires_at)) { skipped.push(`${name} (到期:${d.expires_at})`); continue; }  
  
            try {  
                const res = await renewSubdomain(acc.apiKey, acc.apiSecret, d.id);  
                if (res.success) success.push(`${name} → ${res.data.new_expires_at || '已续期'}`);  
                else failed.push(`${name}: ${res.data.message || JSON.stringify(res.data)}`);  
            } catch (e) {  
                failed.push(`${name}: ${e}`);  
            }  
            await sleep(REQUEST_DELAY); // 控制请求频率  
        }  
        report.push({ account: acc.name, success, skipped, failed });  
    }  
  
    // 构造详细报告  
    let detail = '<b>DNSHE 续期报告</b>\n\n';  
    report.forEach(r => {  
        detail += `<b>=== ${r.account} ===</b>\n`;  
        if (r.error) { detail += `❌ ${r.error}\n\n`; return; }  
        detail += `✅ 成功 ${r.success.length}:\n${r.success.map(s => '  • ' + s).join('\n')}\n`;  
        detail += `⏭ 跳过 ${r.skipped.length}:\n${r.skipped.map(s => '  • ' + s).join('\n')}\n`;  
        detail += `❌ 失败 ${r.failed.length}:\n${r.failed.map(s => '  • ' + s).join('\n')}\n\n`;  
    });  
  
    // 本地通知  
    const summary = report.map(r => r.error ? `[${r.account}] 错误` : `[${r.account}] S:${r.success.length} K:${r.skipped.length} F:${r.failed.length}`).join('\n');  
    $notification.post('DNSHE Renew', summary, '');  
  
    // 推送至 Telegram / PushPlus  
    if (tgBot && tgChatid) sendTelegram(tgBot, tgChatid, detail);  
    if (pushplusToken) sendPushPlus(pushplusToken, detail.replace(/<[^>]+>/g, '')); // PushPlus 示例用纯文本  
  
    $done();  
}  
  
main().catch(e => {  
    $notification.post('DNSHE Renew Error', e.message || e, '');  
    $done();  
});  
