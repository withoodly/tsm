const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://123.tsm.cc.cd';
const WXPUSHER_APP_TOKEN = process.env.WXPUSHER_APP_TOKEN;
const WXPUSHER_UIDS = (process.env.WXPUSHER_UIDS || '').split(',').filter(Boolean);
const ACCOUNTS = JSON.parse(process.env.TSM_ACCOUNTS || '[]');

const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function wxpush(title, content) {
  return new Promise((resolve, reject) => {
    if (!WXPUSHER_APP_TOKEN || WXPUSHER_UIDS.length === 0) {
      console.log('[WxPusher] 未配置，跳过推送');
      return resolve();
    }
    const body = JSON.stringify({
      appToken: WXPUSHER_APP_TOKEN,
      content,
      summary: title,
      contentType: 1,
      uids: WXPUSHER_UIDS,
    });
    const req = https.request(
      {
        hostname: 'wxpusher.zjiecode.com',
        path: '/api/send/message',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { console.log('[WxPusher] 推送响应:', data); resolve(data); });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function screenshot(page, label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(SCREENSHOT_DIR, `${label}_${ts}.png`);
  await page.screenshot({ path: filename, fullPage: false });
  console.log(`[截图] ${filename}`);
  return filename;
}

async function processAccount(account, browser) {
  const { username, password } = account;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[账号] 处理: ${username}`);
  console.log(`${'='.repeat(50)}`);

  const result = {
    username,
    loginSuccess: false,
    expireDate: null,
    remainDays: null,
    renewalNeeded: false,
    renewalSuccess: false,
    error: null,
  };

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  try {
    console.log('[步骤1] 打开登录页...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    await screenshot(page, `${username}_01_cover_page`);

    // 【新增】点击封面页"立即进入"按钮，触发 revealLogin() 显示登录表单
    console.log('[步骤1.5] 点击"立即进入"...');
    await page.click('div[onclick="revealLogin()"]');
    // 等待 #loginCard 从 hidden 变为可见
    await page.waitForSelector('#loginCard:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(500);
    await screenshot(page, `${username}_02_login_form`);

    console.log('[步骤2] 填写账号密码...');
    await page.fill('#loginUsername', username);
    await page.fill('#loginPassword', password);
    await screenshot(page, `${username}_03_filled`);

    console.log('[步骤3] 点击登录...');
    await page.click('button[onclick="userLogin()"]');
    await page.waitForTimeout(3000);
    await screenshot(page, `${username}_04_after_login`);

    // 登录后可能出现欢迎页（#welcomePage），需点击"进入面板"才能到 #mainCard
    const welcomeVisible = await page.isVisible('#welcomePage.show');
    if (welcomeVisible) {
      console.log('[步骤3.5] 检测到欢迎页，点击"进入面板"...');
      await page.click('button.wp-btn[onclick="closeWelcome()"]');
      await page.waitForTimeout(1000);
      await screenshot(page, `${username}_04b_after_welcome`);
    }

    await page.waitForSelector('#mainCard', { timeout: 10000 });
    result.loginSuccess = true;
    console.log('[步骤3] 登录成功！');

    await page.waitForSelector('#expireDate', { timeout: 10000 });
    result.expireDate = await page.$eval('#expireDate', (el) => el.textContent.trim());
    result.remainDays = parseInt(await page.$eval('#remainDays', (el) => el.textContent.trim()), 10);
    console.log(`[信息] 到期时间: ${result.expireDate} | 剩余天数: ${result.remainDays}`);

    // renewSection 始终在DOM里，但天数>10时是 display:none，isVisible 会返回 false
    const renewVisible = await page.isVisible('#renewSection');
    console.log(`[续期区域] 可见: ${renewVisible}`);
    result.renewalNeeded = renewVisible;

    await screenshot(page, `${username}_05_before_renewal`);

    if (result.renewalNeeded) {
      console.log('[步骤5] 续期区域可见，点击续期按钮...');
      await page.locator('#renewSection button').click({ timeout: 10000 });
      await page.waitForTimeout(3000);
      await screenshot(page, `${username}_06_after_renewal`);

      const toast = await page.$('#toast');
      if (toast) {
        const toastText = await toast.textContent();
        console.log(`[续期] Toast: ${toastText}`);
        result.renewalSuccess = !toastText.includes('失败') && !toastText.includes('error');
      } else {
        result.renewalSuccess = true;
      }

      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      try {
        result.expireDate = await page.$eval('#expireDate', (el) => el.textContent.trim());
        result.remainDays = parseInt(await page.$eval('#remainDays', (el) => el.textContent.trim()), 10);
        console.log(`[续期后] 到期时间: ${result.expireDate} | 剩余天数: ${result.remainDays}`);
      } catch (_) {}
      await screenshot(page, `${username}_07_final`);
    } else {
      console.log(`[跳过续期] 剩余 ${result.remainDays} 天，续期区域不可见`);
    }
  } catch (err) {
    result.error = err.message;
    console.error(`[错误] ${username}:`, err.message);
    await screenshot(page, `${username}_error`).catch(() => {});
  } finally {
    await context.close();
  }

  return result;
}

async function main() {
  if (ACCOUNTS.length === 0) {
    console.error('[错误] TSM_ACCOUNTS 未配置');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  for (const account of ACCOUNTS) {
    results.push(await processAccount(account, browser));
  }
  await browser.close();

  console.log('\n[汇总]');
  const needPush = results.some((r) => r.error || r.renewalNeeded);

  if (!needPush) {
    console.log('[推送] 所有账号无需续期，跳过推送');
    process.exit(0);
  }

  const pushTitle = '📡 TSM Glass Panel 续期报告';
  const pushLines = [`🕐 执行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`];

  for (const r of results) {
    if (!r.error && !r.renewalNeeded) continue;
    pushLines.push(`👤 账号: ${r.username}`);
    if (r.error) {
      pushLines.push(`❌ 错误: ${r.error}`);
    } else {
      pushLines.push(`📅 到期时间: ${r.expireDate}`);
      pushLines.push(`⏳ 剩余天数: ${r.remainDays} 天`);
      pushLines.push(`🔄 续期状态: ${r.renewalSuccess ? '✅ 续期成功' : '❌ 续期失败'}`);
    }
    pushLines.push('─'.repeat(20));
  }

  const pushContent = pushLines.join('\n');
  console.log(pushContent);
  await wxpush(pushTitle, pushContent);

  const hasError = results.some((r) => r.error || (r.renewalNeeded && !r.renewalSuccess));
  process.exit(hasError ? 1 : 0);
}

main().catch((err) => {
  console.error('[致命错误]', err);
  process.exit(1);
});
