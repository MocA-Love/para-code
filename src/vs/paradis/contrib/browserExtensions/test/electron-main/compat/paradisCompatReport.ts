/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// paradisCompatProbe.ts の結果（JSON）から、互換性の表（HTML、ライトテーマ）を作る。
//   node --experimental-strip-types src/vs/paradis/contrib/browserExtensions/test/electron-main/compat/paradisCompatReport.ts <結果の JSON> <書き出す HTML> [<手で書いた注の JSON>]
// 手で書いた注は { "<id>": "注の文" } の形（自動では見られないこと。サインインが要る確認など）。

import { promises as fs } from 'fs';
import type { IParadisCompatResult } from './paradisCompatProbe.js';

type Status = 'ok' | 'partial' | 'ng';
const STATUS_LABELS: Record<Status, string> = { ok: '動く', partial: '一部動く', ng: '動かない' };

const [, , input, output, notesPath] = process.argv;
const raw = await fs.readFile(input, 'utf8');
// 結果はリポジトリに入れる。手元の絶対パス（ユーザー名を含む）が残った結果からは表を作らない（測り直すか、パスを消してから）
const leaked = /\/(?:home|Users)\/[^/\s'"<]+|[A-Za-z]:\\+Users\\+/.exec(raw);
if (leaked) {
	throw new Error(`The compatibility results contain a local path (${leaked[0].slice(0, 6)}...). Redact it before making the table.`);
}
const data = JSON.parse(raw) as { electron: string; chrome: string; checkedAt: string; results: IParadisCompatResult[] };
const notes: Record<string, string> = notesPath ? JSON.parse(await fs.readFile(notesPath, 'utf8')) : {};

const escape = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Para Code（と Electron 43）が持たない名前空間のうち、拡張機能の主な働きに関わるもの。 */
const MAJOR_APIS = new Set(['declarativeNetRequest', 'webRequest', 'userScripts', 'sidePanel', 'offscreen', 'identity', 'tabCapture', 'desktopCapture', 'debugger', 'proxy', 'privacy', 'history', 'bookmarks', 'tabGroups', 'search', 'tts', 'ttsEngine', 'idle', 'alarms', 'sessions', 'topSites', 'contentSettings']);

/** 1 つの結果を「動く / 一部動く / 動かない」と理由にする。 */
function classify(result: IParadisCompatResult): { status: Status; reasons: string[] } {
	const reasons: string[] = [];
	if (result.install !== 'ok') {
		const why = /Not a CRX file|download failed \(204\)|404/.test(result.install ?? '') ? 'Chrome ウェブストアにありません（公開が終わっています）' : `ストアから入れられません（${result.install}）`;
		return { status: 'ng', reasons: [why] };
	}
	if (!result.loaded) {
		return { status: 'ng', reasons: [`Electron に読み込めません（${result.loadError ?? '理由は不明'}）`] };
	}
	if (result.worker === 'not running') {
		const crash = (result.workerErrors ?? []).find((message: string) => /Cannot read propert|is not a function|is not defined/.test(message));
		return { status: 'ng', reasons: [`service worker が動き出しません${crash ? `（${crash}）` : ''}`] };
	}
	const required = new Set((result.permissions ?? []).filter(permission => !permission.endsWith('?')));
	// chrome.storage はどの拡張機能のページにもある。それが無いと出るのは、ページが chrome を置き換えているとき（推測）なので、API の確かめは当てにしない
	const apiCheckUnreliable = (result.missingApis ?? []).includes('storage');
	const missing = apiCheckUnreliable ? [] : (result.missingApis ?? []);
	if (result.missingApisFrom === 'manifest.json') {
		reasons.push('ポップアップとオプションのページを読めなかったので、API は拡張機能の manifest.json の文書で、Electron が元から持つものだけを見ました');
	}
	if (apiCheckUnreliable) {
		reasons.push('推測: ポップアップが chrome を置き換えているため、API があるかは自動では確かめられません');
	}
	// 詰め物で「ある」ことにしたが、断る形のもの（名前空間はあるので、上の「使えない API」には出ない）
	const refusedForms: string[] = [];
	if (required.has('identity')) {
		refusedForms.push('Google へのサインイン（chrome.identity.getAuthToken）は断る形で足したので、それを使う働きは動きません');
	}
	if (required.has('debugger')) {
		refusedForms.push('ページへのデバッガーの接続（chrome.debugger.attach）は断る形で足したので、それを使う働きは動きません');
	}
	reasons.push(...refusedForms);
	// 主な働きが Para Code（Electron）に無いもの
	if ((result.urlOverrides ?? []).length > 0) {
		return { status: 'ng', reasons: [`新しいタブなどの置き換え（chrome_url_overrides: ${(result.urlOverrides ?? []).join('、')}）に対応していません。拡張機能の主な働きがこれです`] };
	}
	if (missing.includes('desktopCapture') && missing.includes('tabCapture')) {
		return { status: 'ng', reasons: ['画面とタブの録画（chrome.desktopCapture・chrome.tabCapture）がありません。拡張機能の主な働きがこれです'] };
	}
	if (result.category === 'Orca で不可だったもの' && missing.includes('userScripts')) {
		return { status: 'ng', reasons: ['ユーザースクリプトを動かす chrome.userScripts がありません。拡張機能の主な働きがこれです'] };
	}
	const missingRequired = missing.filter(name => [...required].some(permission => permission.startsWith(name.split('.')[0]) || name.startsWith(permission)));
	const missingMajor = missingRequired.filter(name => MAJOR_APIS.has(name.split('.')[0]));
	if (missingMajor.length > 0) {
		reasons.push(`使えない API: ${missingMajor.join('、')}`);
	}
	const missingMinor = missing.filter(name => !missingMajor.includes(name));
	if (missingMinor.length > 0) {
		reasons.push(`無い API（任意の権限など。主な働きには関わらない見込みです）: ${missingMinor.join('、')}`);
	}
	if (result.contentScript === 'did not run' && result.contentScriptForTestPage !== false) {
		reasons.push('試験用のページで content script が動きません');
	} else if (result.contentScript === 'did not run') {
		reasons.push('content script は決まったサイト（GitHub など）だけのものなので、試験用のページでは動かないのが正しいです（そのサイトでは手で確かめます）');
	}
	if (result.category === '広告・プライバシー') {
		reasons.push('広告のブロック（declarativeNetRequest）は D7 で後回しにしました。ブロックするかは見ていません');
	}
	for (const kind of ['popup', 'options'] as const) {
		const value = result[kind];
		if (typeof value === 'string' && value !== 'none' && value !== 'rendered') {
			reasons.push(value === 'unreadable'
				? `【要確認】${kind === 'popup' ? 'ポップアップ' : 'オプションのページ'}は開きましたが、自動の確かめの前に閉じたか、読めませんでした（手で確かめます）`
				: `${kind === 'popup' ? 'ポップアップ' : 'オプションのページ'}が ${value} でした`);
		}
	}
	const ownErrors = [...(result.workerErrors ?? []), ...(result.popupErrors ?? []), ...(result.optionsErrors ?? [])].filter(message => message.includes('paracode-extension-api'));
	if (ownErrors.length > 0) {
		reasons.push(`Para Code の API の呼び出しが止まっています: ${ownErrors[0].slice(0, 160)}`);
	}
	const apiErrors = [...(result.workerErrors ?? []), ...(result.popupErrors ?? []), ...(result.optionsErrors ?? [])].filter(message => /chrome\.[\w.]+ is not a function|Cannot read propert(y|ies) of undefined \(reading '[\w]+'\)/.test(message));
	if (apiErrors.length > 0) {
		reasons.push(`API のエラー: ${[...new Set(apiErrors)].slice(0, 2).join(' / ')}`);
	}
	if (result.devtoolsPage) {
		reasons.push('DevTools のパネルは自動では見ていません（手で確かめます）');
	}
	const partial = missingMajor.length > 0 || refusedForms.length > 0 || ownErrors.length > 0 || (result.contentScript === 'did not run' && result.contentScriptForTestPage !== false) || apiErrors.length > 0 || (result.popup !== 'none' && result.popup !== 'rendered');
	return { status: partial ? 'partial' : 'ok', reasons: reasons.length > 0 ? reasons : ['読み込み・worker・content script・ポップアップのどれも問題ありませんでした'] };
}

/** 互換性の確かめで見つけて直したもの（P8）。 */
const FIXED = [
	['Angular DevTools', 'chrome.debugger が無く、worker が起動のときに落ちていました', 'chrome.debugger を足しました。接続（attach）は「拡張機能にはデバッガーをつながせない」で断ります'],
	['Google Keep', 'chrome.identity が無く、worker が起動のときに落ちていました', 'chrome.identity を足しました。Google へのサインイン（getAuthToken）とウェブの認証の窓は断ります'],
	['1Password・Bitwarden・Dashlane・NordPass・AdGuard・Privacy Badger', 'chrome.privacy がありませんでした（Chrome のパスワードの保存を切る、WebRTC で IP を漏らさない、など）', 'chrome.privacy を足しました。network.webRTCIPHandlingPolicy は、その場所の利用者のタブへ本当に効かせます。Para Code に同じものが無いほかの設定は「変えられない」と答え、変えようとすると断ります'],
	['Dark Reader', 'chrome.extension.isAllowedFileSchemeAccess が無く、エラーが出ていました', 'isAllowedFileSchemeAccess・isAllowedIncognitoAccess を足しました（どちらも false）'],
	['Keeper', '入れるときに大きすぎると断っていました（フォルダから入れるときの 200 MB の上限）', 'ストアから入れるときは、展開のときと同じ 512 MB までにしました'],
	['1Password・NordPass', 'ポップアップが <meta> の Content-Security-Policy で接続先を絞っていて、Para Code が足した API の呼び出しが止まっていました', 'ページの <meta> の connect-src にも、Para Code の私用スキームを足すようにしました（manifest の方針には前から足していました）'],
	['DeepL', 'chrome.tts がありませんでした（P9a）', 'chrome.tts を足しました。OS の読み上げ（Chromium の speechSynthesis）で、拡張機能もウェブのページも入らない見えない窓の中で読みます'],
	['Keeper・Ghostery', 'chrome.browsingData がありませんでした（P9a）', 'chrome.browsingData を足しました。消すのは呼び出し元のセッションのウェブのデータだけで、拡張機能のデータ・エージェントのセッション・ほかの場所のデータには触れません。期間の指定と、Para Code に無いデータ（履歴など）は断ります'],
];

/** 直していないもの（大きいので別にする）。 */
const NOT_FIXED = [
	['サイドパネル（chrome.sidePanel）', 'Bitwarden・Stylus・DeepL・Grammarly', 'Para Code にサイドパネルの置き場がありません。ポップアップなどほかの入り口は動きます'],
	['ユーザースクリプト（chrome.userScripts）', 'Tampermonkey・uBlock Origin Lite・AdGuard・Ghostery', 'Electron 43 にありません。Tampermonkey は主な働きがこれです'],
	['新しいタブの置き換え（chrome_url_overrides）', 'Momentum', 'Para Code の新しいタブは内蔵ブラウザのページではありません'],
	['画面とタブの録画（chrome.desktopCapture・chrome.tabCapture）', 'Loom', 'Electron 43 にありません'],
	['広告のブロック（declarativeNetRequest）', '広告・プライバシーの 4 つ', 'D7 で後回しにしました'],
];

const rows = data.results.map(result => ({ result, ...classify(result) }));
const counts: Record<Status, number> = { ok: 0, partial: 0, ng: 0 };
for (const row of rows) {
	counts[row.status]++;
}
const cell = (value: unknown): string => value === undefined ? '-' : escape(value);
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Para Code 内蔵ブラウザの Chrome 拡張機能 互換性の表（P8、${escape(data.checkedAt.slice(0, 10))}）</title>
<style>
body { background: #ffffff; color: #1f2328; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; margin: 32px; line-height: 1.6; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 17px; margin: 28px 0 8px; }
p, li { font-size: 14px; }
.muted { color: #656d76; }
.panel { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0 16px; }
th, td { border: 1px solid #d0d7de; padding: 6px 8px; vertical-align: top; text-align: left; }
th { background: #f6f8fa; }
.ok { color: #1a7f37; font-weight: 600; }
.partial { color: #9a6700; font-weight: 600; }
.ng { color: #cf222e; font-weight: 600; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; padding: 0 3px; }
.summary td { text-align: center; font-size: 15px; }
</style>
</head>
<body>
<h1>${rows.length} 個中、動く ${counts.ok}・一部動く ${counts.partial}・動かない ${counts.ng}</h1>
<p class="muted">Electron ${escape(data.electron)}（Chromium ${escape(data.chrome)}）、Linux の Xvfb で ${escape(data.checkedAt)} に自動で確かめた結果です。拡張機能は Chrome ウェブストアから、Para Code と同じ道（署名の確かめを含む）で入れました。</p>

<table class="summary"><tr><th>動く</th><th>一部動く</th><th>動かない</th></tr>
<tr><td class="ok">${counts.ok}</td><td class="partial">${counts.partial}</td><td class="ng">${counts.ng}</td></tr></table>

<h2>自動で見たことと、見ていないこと</h2>
<div class="panel">
<p>拡張機能ごとに、次の 5 つを記録しました。<strong>サインインが要る働き（パスワード管理の解錠・自動入力、翻訳のアカウントなど）と DevTools のパネルは、自動では見ていません</strong>。それらは Mac での手の確認（Q479・Q484〜Q486）で見ます。</p>
<ul>
<li>ストアから入れられるか、Electron に読み込めるか</li>
<li>service worker が動き出すか、worker の console のエラー</li>
<li>手元の試験用のページ（ログインの欄・文章を含む）で content script の文脈ができるか</li>
<li>ポップアップとオプションのページが開くか、そこでのエラー</li>
<li>宣言した権限の <code>chrome.*</code> が、ポップアップかオプションのページにあるか</li>
</ul>
<p>広告ブロッカー（<code>declarativeNetRequest</code>）は D7 で後回しにしたので、ここでは「入るがブロックしない」かを記録しただけです。</p>
</div>

<h2>拡張機能ごとの結果</h2>
<table>
<tr><th>区分</th><th>拡張機能</th><th>結果</th><th>理由</th><th>版</th><th>worker</th><th>content script</th><th>ポップアップ</th></tr>
${rows.map(({ result, status, reasons }) => `<tr><td>${escape(result.category)}</td><td>${escape(result.name ?? result.label)}<br><span class="muted"><code>${escape(result.id)}</code></span></td><td class="${status}">${STATUS_LABELS[status]}</td><td>${reasons.map(escape).join('<br>')}${notes[result.id] ? `<br><span class="muted">${escape(notes[result.id])}</span>` : ''}</td><td>${cell(result.version)}</td><td>${cell(result.worker)}</td><td>${cell(result.contentScript)}</td><td>${cell(result.popup)}</td></tr>`).join('\n')}
</table>

<h2>この確かめで見つけて直したもの</h2>
<table>
<tr><th>拡張機能</th><th>起きていたこと</th><th>直し方</th></tr>
${FIXED.map((row: readonly string[]) => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('\n')}
</table>

<h2>直していないもの（大きいので別にします）</h2>
<table>
<tr><th>足りないもの</th><th>当たる拡張機能</th><th>理由</th></tr>
${NOT_FIXED.map((row: readonly string[]) => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('\n')}
</table>

<h2>作り方</h2>
<p>互換性の確かめは <code>src/vs/paradis/contrib/browserExtensions/test/electron-main/compat/paradisCompatProbe.ts</code>（Electron の main として動かします）で行い、この表は <code>paradisCompatReport.ts</code> で作ります。手順は両方のファイルの冒頭にあります。</p>
</body>
</html>
`;
await fs.writeFile(output, html);
console.log(`wrote ${output}: ${JSON.stringify(counts)}`);
