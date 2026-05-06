import os, json, sys, time
import requests
from datetime import datetime, timezone

API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub"


def send_telegram(token, chat_id, text):
    """发送 Telegram 消息 (HTML 格式)"""
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
        r = requests.post(url, json=payload, timeout=15)
        if r.status_code != 200:
            print(f"Telegram 发送失败: {r.text}")
    except Exception as e:
        print(f"Telegram 异常: {e}")


def send_pushplus(token, title, content):
    """发送 PushPlus 消息 (HTML 格式)"""
    try:
        url = "https://www.pushplus.plus/send"
        payload = {
            "token": token,
            "title": title,
            "content": content,
            "template": "html"
        }
        r = requests.post(url, json=payload, timeout=15)
        if r.status_code != 200:
            print(f"PushPlus 发送失败: {r.text}")
    except Exception as e:
        print(f"PushPlus 异常: {e}")


def get_all_subdomains(api_key, api_secret):
    """获取账户下全部子域名 (处理分页)"""
    headers = {
        "X-API-Key": api_key,
        "X-API-Secret": api_secret
    }
    subdomains = []
    page = 1
    per_page = 500
    while True:
        params = {
            "endpoint": "subdomains",
            "action": "list",
            "page": page,
            "per_page": per_page,
            "include_total": "false"
        }
        try:
            r = requests.get(API_BASE, headers=headers, params=params, timeout=30)
            data = r.json()
        except Exception as e:
            print(f"获取域名列表失败 (page={page}): {e}")
            break
        if not data.get("success"):
            print(f"API 错误: {data.get('message', '')}")
            break
        subdomains.extend(data.get("subdomains", []))
        pagination = data.get("pagination", {})
        if not pagination.get("has_more"):
            break
        page += 1
        time.sleep(0.3)
    return subdomains


def process_account(account):
    """处理单个账号，返回结果字典"""
    name = account.get("name", "Unknown")
    api_key = account["api_key"]
    api_secret = account["api_secret"]
    results = {"name": name, "total": 0, "success": [], "skipped": [], "failed": []}

    print(f"\n处理账号: {name}")
    subdomains = get_all_subdomains(api_key, api_secret)
    if not subdomains:
        print("  未获取到任何域名，可能 API 密钥错误")
        return results

    results["total"] = len(subdomains)
    headers = {
        "X-API-Key": api_key,
        "X-API-Secret": api_secret,
        "Content-Type": "application/json"
    }

    for sub in subdomains:
        sub_id = sub["id"]
        full_domain = sub.get("full_domain") or f"{sub['subdomain']}.{sub['rootdomain']}"
        try:
            renew_params = {
                "endpoint": "subdomains",
                "action": "renew"
            }
            resp = requests.post(API_BASE, headers=headers, params=renew_params,
                                 json={"subdomain_id": sub_id}, timeout=30)
            data = resp.json()
        except Exception as e:
            results["failed"].append({
                "domain": full_domain,
                "error": f"请求异常: {str(e)}"
            })
            continue

        if data.get("success"):
            prev = data.get("previous_expires_at", "?")
            new = data.get("new_expires_at", "?")
            results["success"].append({
                "domain": full_domain,
                "prev": prev,
                "new": new
            })
        else:
            error_code = data.get("error_code", "")
            message = data.get("message", "未知错误")
            if error_code == "renewal_not_yet_available":
                # 尝试获取当前过期时间
                prev = data.get("details", {}).get("expires_at", "?")
                results["skipped"].append({
                    "domain": full_domain,
                    "prev": prev,
                    "reason": message
                })
            else:
                results["failed"].append({
                    "domain": full_domain,
                    "error": message
                })
        time.sleep(0.5)

    return results


def build_report(all_results):
    """生成 HTML 格式报告"""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"<b>📅 DNSHE 自动续期报告 - {now_str}</b>\n"]
    for res in all_results:
        total = res["total"]
        succ = len(res["success"])
        skip = len(res["skipped"])
        fail = len(res["failed"])
        lines.append(f"🔹 <b>账号：{res['name']}</b>")
        lines.append(f"   总域名：{total} | ✅续期成功：{succ} | ⏭️跳过：{skip} | ❌失败：{fail}\n")
        for s in res["success"]:
            lines.append(f"   ✅ <code>{s['domain']}</code>")
            lines.append(f"      到期时间：{s['prev']} → {s['new']}")
        for s in res["skipped"]:
            lines.append(f"   ⏭️ <code>{s['domain']}</code>")
            lines.append(f"      尚未到续期窗口（当前到期：{s['prev']}）")
        for f in res["failed"]:
            lines.append(f"   ❌ <code>{f['domain']}</code>")
            lines.append(f"      续期失败：{f['error']}")
        lines.append("")
    return "\n".join(lines)


def parse_accounts(raw):
    """
    解析简化格式的账号配置：
    格式：名称:API_KEY:API_SECRET
    多个账户用英文分号 ; 分隔
    """
    accounts = []
    if not raw:
        return accounts
    for part in raw.strip().split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            name, key, secret = part.split(":", 2)
            accounts.append({
                "name": name.strip(),
                "api_key": key.strip(),
                "api_secret": secret.strip()
            })
        except ValueError:
            print(f"跳过格式不正确的账户配置: {part}")
    return accounts


def main():
    raw = os.environ.get("DNSHE_ACCOUNTS", "")
    if not raw:
        print("未配置 DNSHE_ACCOUNTS，退出")
        sys.exit(1)

    accounts = parse_accounts(raw)
    if not accounts:
        print("没有有效的账户配置，退出")
        sys.exit(1)

    all_results = []
    for acc in accounts:
        try:
            res = process_account(acc)
            all_results.append(res)
        except Exception as e:
            print(f"处理账号 {acc.get('name', 'Unknown')} 出错: {e}")
            all_results.append({
                "name": acc.get("name", "Unknown"),
                "total": 0,
                "success": [],
                "skipped": [],
                "failed": [{"domain": "N/A", "error": str(e)}]
            })

    report = build_report(all_results)
    print("========== 报告 ==========")
    print(report)

    telegram_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    telegram_chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    pushplus_token = os.environ.get("PUSHPLUS_TOKEN", "").strip()

    if telegram_token and telegram_chat:
        print("发送 Telegram 通知...")
        send_telegram(telegram_token, telegram_chat, report)

    if pushplus_token:
        print("发送 PushPlus 通知...")
        title = f"DNSHE 续期报告 {datetime.now().strftime('%Y-%m-%d')}"
        send_pushplus(pushplus_token, title, report)


if __name__ == "__main__":
    main()
