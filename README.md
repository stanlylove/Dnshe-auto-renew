# DNSHE 免费域名自动续期

基于 GitHub Actions 的全自动免费域名续期工具，支持多账号、多域名，结果通过 Telegram / PushPlus 通知。

## 📌 功能特色

- **全自动续期**：每月 1 日（UTC）自动运行，亦可手动触发
- **多账号支持**：可配置任意数量的 DNSHE 账户
- **多域名遍历**：自动获取账户下所有子域名并逐一续期
- **智能跳过**：仅对进入续期窗口（到期前180天）的域名执行操作
- **即时通知**：支持 Telegram Bot 和 PushPlus 双通道推送详细报告
- **结果分组**：按账号分组显示成功、跳过、失败的域名详情
- **安全合规**：密钥全部存储在 GitHub Secrets 中，代码零硬编码

## 🚀 快速开始

### 1. Fork 本仓库或直接添加文件
将 `renew.yml` 放入 `.github/workflows/` 目录，`renew.py` 放在仓库根目录。

### 2. 配置 Secrets
在仓库 `Settings > Secrets and variables > Actions` 中添加以下密钥：

| Secret 名称 | 必填 | 说明 |
| :--- | :--- | :--- |
| `DNSHE_ACCOUNTS` | ✅ | 账号列表，格式见下方 |
| `TELEGRAM_BOT_TOKEN` | ❌ | Telegram Bot 令牌 |
| `TELEGRAM_CHAT_ID` | ❌ | Telegram 接收消息的 Chat ID |
| `PUSHPLUS_TOKEN` | ❌ | PushPlus 令牌 (pushplus.plus) |

**`DNSHE_ACCOUNTS` 填写格式（超级简单）：**
账户名称:API_KEY:API_SECRET;账户名称2:API_KEY2:API_SECRET2

- 每个账户格式：`名称:API密钥:API Secret`
- 多个账户用英文分号 `;` 分隔
- 名称可以随意写（仅用于报告），不要包含英文冒号 `:`

**示例：**
个人账户:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;公司账户:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa

将上述字符串直接填入 `DNSHE_ACCOUNTS` Secret 即可。

### 3. 启用 GitHub Actions
推送代码后，Actions 会自动启用。您也可以在 `Actions` 页面手动触发 `DNSHE Auto Renew` 工作流。

## 📅 执行计划
工作流默认每月 1 日 UTC 0:00 自动执行。您可修改 `.github/workflows/renew.yml` 中的 `cron` 表达式：
```yaml
on:
  schedule:
    - cron: '0 0 1 * *'   # 每月 1 日
```
推荐使用 crontab.guru 调试表达式。

## 通知效果预览
以下为 Telegram / PushPlus 推送的消息样式：
## 📅 DNSHE 自动续期报告 - 20XX-XX-XX

### 🔹 账户：账号一
总域名：3 | ✅ 续期成功：2 | ⏭️ 跳过：1 | ❌ 失败：0

✅ myapp.example.com
到期时间：2026-06-01 00:00:00 → 2027-06-01 00:00:00

✅ api.example.com
到期时间：2026-07-15 00:00:00 → 2027-07-15 00:00:00

⏭️ blog.example.com
尚未到续期窗口（当前到期：2026-11-20）


### 🔹 账户：账号二
总域名：1 | ✅ 续期成功：0 | ⏭️ 跳过：0 | ❌ 失败：1

❌ old.domain.com
续期失败：renewal window expired

---

## 常见问题
Q：免费域名真的能一直续期下去吗？
A：只要域名状态正常，且在到期前 180 天内续期，每次都会延长一年，可无限循环。

Q：我只有 1 个账户怎么填？
A：只写一个即可，结尾不需要分号。例如：我的账户:key:secret

Q：通知渠道可以都不配置吗？
A：可以。脚本只会在 Actions 日志中打印报告，不会发送外部通知。

Q：为什么会遇到 rate_limit_exceeded 错误？
A：脚本内置了请求间隔（0.3～0.5 秒），确保不超过 API 限制（30～60 次/分钟）。如果域名数量极大，首次运行可能接近限制，后续运行因跳过已续期域名，请求量会减少。
      
## 🙏 致谢

本项目得以实现，特别感谢以下平台与技术的支持：

* **[DNSHE](https://www.dnshe.com/)**：提供简单、快速、免费的域名注册服务及免费域名 API 服务，支持全类型 DNS 记录解析、DNS 记录管理及自动化续期功能。


* **[Deepseek](https://deepseek.com/)**：提供智能化的代码编写建议、脚本逻辑优化以及文档排版支持。
