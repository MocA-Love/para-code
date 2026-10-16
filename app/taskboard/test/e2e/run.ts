// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * 画面の通し確認。見本の台帳でサーバーを起動し、手元の Chrome で主な操作を一通り行う。
 *   pnpm test:e2e            結果とスクショを test/e2e/out に出す
 *   CHROME=/path/to/chrome   Chrome の場所を変える
 * 画面を前に出さない（headless）ので、作業中に流しても操作を奪わない。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const PORT = 4890 + Math.floor(Math.random() * 50);
const TOKEN = 'e2e-token';
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results: { name: string; ok: boolean; error?: string }[] = [];
const consoleErrors: string[] = [];

let current: Page | undefined;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		results.push({ name, ok: true });
		console.log(`  ✓ ${name}`);
	} catch (err) {
		await current?.screenshot({ path: path.join(OUT, `failed-${results.length + 1}.png`) as `${string}.png` }).catch(() => undefined);
		results.push({ name, ok: false, error: (err as Error).message });
		console.log(`  ✗ ${name}\n      ${(err as Error).message.split('\n')[0]}`);
	}
}

function assert(cond: unknown, message: string): asserts cond {
	if (!cond) {
		throw new Error(message);
	}
}

async function shot(page: Page, name: string): Promise<void> {
	await new Promise(r => setTimeout(r, 250));
	await page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
}

async function clickText(page: Page, selector: string, text: string): Promise<void> {
	const handle = await page.waitForFunction((sel, t) => [...document.querySelectorAll<HTMLElement>(sel)].find(el => el.innerText.includes(t) && el.offsetParent !== null), { timeout: 8000 }, selector, text);
	const el = handle.asElement() as unknown as { click(): Promise<void>; evaluate(fn: (e: HTMLElement) => void): Promise<void> };
	// 横スクロールの外にある要素（電話の列の切り替えなど）は、DOM の click で押す
	await el.click().catch(() => el.evaluate(e => { e.scrollIntoView({ inline: 'center' }); e.click(); }));
}

async function waitText(page: Page, text: string, timeout = 8000): Promise<void> {
	await page.waitForFunction(t => document.body.innerText.includes(t), { timeout }, text);
}

async function startServer(dataDir: string): Promise<ChildProcess> {
	const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), ['server/main.ts', '--demo', '--port', String(PORT), '--token', TOKEN, '--data', dataDir, '--speed', '1', '--quiet', ...(process.env.E2E_PROD ? ['--prod'] : [])], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stderr?.on('data', d => process.stderr.write(`[server] ${d}`));
	// 負荷が高いと vite の起動に 20 秒以上かかるので、60 秒まで待つ
	for (let i = 0; i < 240; i++) {
		const ok = await fetch(`${BASE}/api/health`, { headers: { 'x-taskboard-token': TOKEN } }).then(r => r.ok, () => false);
		if (ok) {
			return child;
		}
		await new Promise(r => setTimeout(r, 250));
	}
	child.kill();
	throw new Error('server did not start');
}

async function main(): Promise<void> {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'taskboard-e2e-'));
	const server = await startServer(dataDir);
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
	try {
		const page = await browser.newPage();
		current = page;
		page.on('console', m => { if (m.type() === 'error') { consoleErrors.push(m.text()); } });
		page.on('pageerror', e => consoleErrors.push(String(e)));
		await page.setViewport({ width: 1680, height: 1000 });

		console.log('desktop (dark)');
		await step('セキュリティ: データの口はトークン無しで 401、Cookie を使わない、別の Origin は 403', async () => {
			// 画面のコードは鍵なしで配る。データの口（RPC・ヘルス・成果物・画像）は鍵が要る
			const page0 = await fetch(`${BASE}/`);
			assert(page0.status === 200, `app shell: ${page0.status}`);
			const health = await fetch(`${BASE}/api/health`);
			assert(health.status === 401, `health without token: ${health.status}`);
			const rpc0 = await fetch(`${BASE}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"snapshot"}' });
			assert(rpc0.status === 401, `rpc without token: ${rpc0.status}`);
			const art = await fetch(`${BASE}/api/artifacts/x/y?k=wrong`);
			assert(art.status === 401, `artifact with a wrong key: ${art.status}`);
			// 鍵付きの URL を開いても Cookie は配らない（Cookie はポートを区別しない）
			const withToken = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
			assert(withToken.headers.get('set-cookie') === null, 'set-cookie on the token URL');
			const snap = await fetch(`${BASE}/api/rpc`, { method: 'POST', headers: { 'x-taskboard-token': TOKEN, 'content-type': 'application/json' }, body: '{"method":"snapshot"}' }).then(r => r.json()) as { result: { runtime: { assetKey?: string } } };
			const key = snap.result.runtime.assetKey ?? '';
			const artOk = await fetch(`${BASE}/api/artifacts/x/y?k=${encodeURIComponent(key)}`);
			assert(artOk.status !== 401, `artifact with the asset key: ${artOk.status}`);
			const rpcWithAssetKey = await fetch(`${BASE}/api/rpc?k=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"snapshot"}' });
			assert(rpcWithAssetKey.status === 401, `rpc with only the asset key: ${rpcWithAssetKey.status}`);
			const res = await fetch(`${BASE}/api/rpc`, { method: 'POST', headers: { 'x-taskboard-token': TOKEN, 'content-type': 'application/json', 'origin': 'https://evil.example' }, body: '{"method":"snapshot"}' });
			assert(res.status === 403, `cross origin: ${res.status}`);
		});
		await step('トークン付きの URL でボードが開く', async () => {
			await page.goto(`${BASE}/?token=${TOKEN}#/board`, { waitUntil: 'networkidle0' });
			await page.waitForSelector('.col[data-col="todo"] .card');
			const cols = await page.$$eval('.col', els => els.length);
			assert(cols >= 10, `columns: ${cols}`);
			await shot(page, '01-board-dark');
		});
		await step('質問に答えると作業中に戻る（#412）', async () => {
			await page.click('.card[data-task="gh:example/para-code#412"]');
			await page.waitForSelector('.panel.on .ask');
			await shot(page, '02-panel-question');
			const opts = await page.$$('.panel.on .opt');
			await opts[1].click();
			await clickText(page, '.panel.on .btn.primary', '回答を送る');
			await waitText(page, '回答しました');
			await page.waitForFunction(() => !document.querySelector('.panel.on .ask'), { timeout: 5000 });
		});
		await step('タブを数字キーで切り替え、モックを表示する', async () => {
			await page.keyboard.press('4');
			await page.waitForSelector('.panel.on .stage iframe');
			await shot(page, '03-panel-mock');
			await page.keyboard.press('Escape');
			await page.waitForFunction(() => !document.querySelector('.panel.on'));
		});
		await step('計画を読み、承認すると実装へ進む（#415）', async () => {
			await page.click('.card[data-task="gh:example/para-code#415"]');
			await page.waitForSelector('.panel.on .approve-card');
			await waitText(page, '一部の計測値');
			await shot(page, '04-panel-plan');
			await clickText(page, '.panel.on .btn.primary', '承認して次へ');
			await waitText(page, '承認しました');
			await page.waitForFunction(() => document.querySelector('.panel.on .ptab.on')?.textContent?.includes('進捗'));
			await shot(page, '05-panel-progress-working');
			await page.keyboard.press('Escape');
		});
		await step('失敗した PR のチェックと差分を見る（#398）', async () => {
			await page.click('.card[data-task="gh:example/para-code#398"]');
			await page.waitForSelector('.panel.on .check');
			await shot(page, '06-panel-pr-checks');
			await clickText(page, '.panel.on .subnav button', '変更ファイル');
			await page.waitForSelector('.panel.on .diff tr.add');
			await shot(page, '07-panel-pr-files');
			await clickText(page, '.panel.on .subnav button', '会話');
			await page.waitForSelector('.panel.on .review');
			await shot(page, '08-panel-pr-conversation');
			await page.keyboard.press('Escape');
		});
		await step('スクショを比べる（#395）', async () => {
			await page.click('.card[data-task="gh:example/para-code#395"]');
			await page.waitForSelector('.panel.on');
			await page.keyboard.press('6');
			await page.waitForSelector('.panel.on .gallery img');
			await clickText(page, '.panel.on .subnav button', '2 枚を比べる');
			await page.waitForSelector('.panel.on .compare');
			await shot(page, '09-panel-artifacts-compare');
			await page.keyboard.press('7');
			await page.waitForSelector('.panel.on .term');
			await shot(page, '10-panel-terminal');
			await page.keyboard.press('Escape');
		});
		await step('Issue にコメントする（見本なので GitHub には送らない）・プレビュー', async () => {
			await page.click('.card[data-task="gh:example/para-code#418"]');
			await page.waitForFunction(() => location.hash.includes('%23418'), { timeout: 3000 }).catch(async () => { throw new Error(`opened ${await page.evaluate(() => location.hash)}`); });
			await page.waitForSelector('.panel.on .composer textarea');
			await page.type('.panel.on .composer textarea', '**確認しました**。進めてください');
			await clickText(page, '.panel.on .composer .ctabs button', 'プレビュー');
			await page.waitForSelector('.panel.on .composer .md strong');
			await clickText(page, '.panel.on .composer .btn.primary', 'コメント');
			await waitText(page, 'コメントしました');
			await page.waitForFunction(() => [...document.querySelectorAll('.panel.on .cmt .box-b')].some(b => b.textContent?.includes('進めてください')));
			await shot(page, '10b-panel-issue-comment');
			await page.keyboard.press('Escape');
		});
		await step('タスクを追加して着手する', async () => {
			await page.keyboard.press('n');
			await page.waitForSelector('.modal input');
			await page.type('.modal input', 'E2E で足したタスク');
			await clickText(page, '.modal .btn.primary', '追加');
			await page.waitForSelector('.panel.on');
			await clickText(page, '.panel.on .btn.primary', '着手する');
			await page.waitForSelector('.modal textarea');
			await shot(page, '11-start-dialog');
			await page.click('.modal .btn.primary');
			await page.waitForFunction(() => !document.querySelector('.modal'));
			await page.keyboard.press('Escape');
			await page.waitForFunction(() => [...document.querySelectorAll('.col[data-col="plan"] .card')].some(c => c.textContent?.includes('E2E で足したタスク')));
		});
		await step('メニューから工程を移す（差し戻しのダイアログ）', async () => {
			const card = await page.$('.col[data-col="build"] .card, .col[data-col="review"] .card');
			assert(card, 'no card in build/review');
			await card.hover();
			await (await card.$('.menu-btn'))!.click();
			await clickText(page, '.menu button', '工程を移す');
			await page.waitForSelector('.movelist');
			await shot(page, '12-move-dialog');
			await page.keyboard.press('Escape');
		});
		await step('あなたの番・一覧・フロー', async () => {
			await page.keyboard.press('i');
			await page.waitForSelector('.inbox .sum');
			await shot(page, '13-inbox');
			await page.keyboard.press('l');
			await page.waitForSelector('.table tbody tr');
			await shot(page, '14-list');
			await page.keyboard.press('f');
			await page.waitForSelector('.flow .stepitem');
			await (await page.$$('.flow .stepitem'))[2].click();
			await page.click('#st-name', { count: 3 });
			await page.type('#st-name', '実装する');
			await waitText(page, '保存していない変更');
			await shot(page, '15-flow');
		});
		await step('絞り込みと「?」のキー一覧', async () => {
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await page.keyboard.press('b');
			await page.waitForSelector('.board');
			await page.keyboard.press('/');
			await page.keyboard.type('通知');
			const n = await page.$$eval('.card', els => els.length);
			assert(n >= 1 && n <= 4, `filtered cards: ${n}`);
			await page.keyboard.press('Escape');
			await page.keyboard.press('?');
			await page.waitForSelector('.shortcuts');
			await page.keyboard.press('Escape');
		});

		console.log('desktop (light)');
		await step('ライトテーマ', async () => {
			await page.evaluate(() => localStorage.setItem('taskboard:theme', '"light"'));
			await page.goto(`${BASE}/#/board`, { waitUntil: 'networkidle0' });
			await page.reload({ waitUntil: 'networkidle0' });
			await page.waitForSelector('.card');
			assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'theme not light');
			await shot(page, '20-board-light');
			await page.click('.card[data-task="gh:example/para-code#398"]');
			await page.waitForSelector('.panel.on .check');
			await shot(page, '21-panel-pr-light');
			await page.keyboard.press('7');
			await page.waitForSelector('.panel.on .term');
			const termBg = await page.$eval('.panel.on .term', el => getComputedStyle(el).backgroundColor);
			assert(termBg !== 'rgb(7, 9, 12)', `terminal is still dark in light mode: ${termBg}`);
			await shot(page, '21b-panel-terminal-light');
			await page.keyboard.press('Escape');
			await page.keyboard.press('i');
			await shot(page, '22-inbox-light');
			await page.evaluate(() => localStorage.setItem('taskboard:theme', '"dark"'));
		});

		console.log('tablet / phone');
		await step('タブレット（900px）', async () => {
			await page.setViewport({ width: 900, height: 1100 });
			await page.goto(`${BASE}/#/board`, { waitUntil: 'networkidle0' });
			await page.waitForSelector('.card');
			await shot(page, '30-tablet-board');
			await page.click('.card[data-task="gh:example/para-code#401"]');
			await page.waitForSelector('.panel.on');
			await shot(page, '31-tablet-panel');
			await page.keyboard.press('Escape');
		});
		await step('電話（390px）: 列の切り替え・詳細・下のバー', async () => {
			await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
			await page.goto(`${BASE}/#/board`, { waitUntil: 'networkidle0' });
			await page.waitForSelector('.colnav button');
			await shot(page, '40-phone-board');
			await clickText(page, '.colnav button', 'マージ');
			await new Promise(r => setTimeout(r, 600));
			await shot(page, '41-phone-board-merge');
			const card = await page.$('.col[data-col="merge"] .card');
			assert(card, 'no card in merge column');
			await card.evaluate(el => (el as HTMLElement).click());
			await page.waitForSelector('.panel.on');
			await shot(page, '42-phone-panel');
			await page.$eval('.side-toggle', el => (el as HTMLElement).click());
			await shot(page, '43-phone-panel-info');
			await page.$eval('.crumb .btn', el => (el as HTMLElement).click());
			await page.$eval('.navbar button:nth-child(2)', el => (el as HTMLElement).click());
			await page.waitForSelector('.inbox');
			await shot(page, '44-phone-inbox');
			await page.$eval('.navbar button:nth-child(4)', el => (el as HTMLElement).click());
			await page.waitForSelector('.flow');
			await shot(page, '45-phone-flow');
			await page.evaluate(() => localStorage.setItem('taskboard:theme', '"light"'));
			await page.$eval('.navbar button:nth-child(3)', el => (el as HTMLElement).click());
			await page.reload({ waitUntil: 'networkidle0' });
			await page.waitForSelector('.cards-list .card');
			await shot(page, '46-phone-list-light');
		});
	} finally {
		await browser.close();
		server.kill('SIGTERM');
		rmSync(dataDir, { recursive: true, force: true });
	}
	const failed = results.filter(r => !r.ok);
	const errors = consoleErrors.filter(e => !/React DevTools|\[vite\]|favicon/.test(e));
	console.log(`\n${results.length - failed.length}/${results.length} passed${errors.length ? `, console errors: ${errors.length}` : ''}`);
	for (const e of errors.slice(0, 10)) {
		console.log(`  console: ${e.slice(0, 300)}`);
	}
	console.log(`screenshots: ${OUT}`);
	process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
