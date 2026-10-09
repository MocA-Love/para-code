/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 操作の後の変化（paradisBrowserObserve.ts）を集めるための、ページの中で動かす関数のソース。
// evaluate_script へ渡すので、引数は要素の uid しか渡せない。値はソースへ JSON で埋め込む。
//
// 決め事:
// - 記録はページの window に、呼び出しごとの乱数の名前（列挙されない）で置く。60 秒で自分で止まる
// - aria-hidden の中（Para Code のカーソルの演出など）の変化は数えない
// - 見えない要素・script / style などは報告しない。文字は 1 行 160 字で切る

/** 記録を始める関数の本体（`rec` を作って window に置く）。`N` は記録の名前、`NAV` は遷移の後に作り直したか。 */
const INSTALL_BODY = String.raw`
	const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);
	const hiddenFromA11y = node => {
		const el = node && (node.nodeType === 1 ? node : node.parentElement);
		return !!(el && el.closest && el.closest('[aria-hidden="true"]'));
	};
	const brief = node => {
		const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
		if (!text) { return undefined; }
		const tag = node.nodeType === 1 ? node.tagName.toLowerCase() : 'text';
		return { tag, text: text.slice(0, 160) };
	};
	const old = window[N];
	if (old && old.mo) { old.mo.disconnect(); }
	const rec = { last: performance.now(), added: [], removed: [], changed: new Set(), overflow: 0, url: location.href, title: document.title, focusBefore: document.activeElement, navigated: NAV };
	rec.mo = new MutationObserver(list => {
		for (const m of list) {
			if (hiddenFromA11y(m.target)) { continue; }
			rec.last = performance.now();
			if (m.type === 'childList') {
				for (const n of m.addedNodes) {
					if (n.nodeType === 3) { if (n.parentElement) { rec.changed.add(n.parentElement); } continue; }
					if (n.nodeType !== 1 || SKIP.has(n.tagName)) { continue; }
					if (rec.added.length < 400) { rec.added.push(n); } else { rec.overflow++; }
				}
				for (const n of m.removedNodes) {
					const index = rec.added.indexOf(n);
					if (index >= 0) { rec.added.splice(index, 1); continue; }
					if (n.nodeType === 1 && SKIP.has(n.tagName)) { continue; }
					const b = brief(n);
					if (b && rec.removed.length < 60) { rec.removed.push(b); }
				}
			} else if (m.type === 'characterData') {
				if (m.target.parentElement) { rec.changed.add(m.target.parentElement); }
			} else if (m.target.nodeType === 1) {
				rec.changed.add(m.target);
			}
		}
	});
	rec.mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
		attributeFilter: ['disabled', 'checked', 'selected', 'value', 'hidden', 'open', 'class', 'style', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled', 'aria-invalid', 'aria-pressed', 'aria-busy'] });
	// 読まれずに残った記録（道具の失敗・ダイアログ）は 60 秒で止めて消す
	setTimeout(() => { rec.mo.disconnect(); if (window[N] === rec) { delete window[N]; } }, 60000);
	Object.defineProperty(window, N, { value: rec, configurable: true, enumerable: false });
`;

/** 記録を始め、今の URL とタイトルを返す。 */
export function paradisObserveInstallFunction(name: string): string {
	return `() => { const N = ${JSON.stringify(name)}; const NAV = false; ${INSTALL_BODY} return { url: location.href, title: document.title }; }`;
}

/**
 * 記録の様子をすぐに返す（ページの中では待たない。待つのは呼び出し側で、その間にダイアログが開いていないかを
 * 確かめるため。ページの中で待つと、待っている間に開いた confirm を内蔵 chrome-devtools-mcp が閉じてしまう）。
 * 記録が無ければ（別の文書へ移った）その文書で記録を始め直し、`navigated: true` を返す。
 */
export function paradisObserveReadFunction(name: string): string {
	return `() => {
	const N = ${JSON.stringify(name)};
	let navigated = false;
	if (!window[N]) { navigated = true; const NAV = true; ${INSTALL_BODY} }
	const rec = window[N];
	// 読み込み中の印（スピナー・aria-busy など）が見えている間は落ち着いたとみなさない
	const busy = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .spinner, .loading, [class*="spinner"], [class*="loading"]')).some(el => !el.closest('[aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
	return { age: Math.round(performance.now() - rec.last), ready: document.readyState === 'complete', busy, navigated: navigated || rec.navigated };
}`;
}

/** 記録を止めて、増えた・変わった・消えた要素を行にして返す（記録は消す）。 */
export function paradisObserveCollectFunction(name: string, maxLines: number): string {
	return `() => {
	const N = ${JSON.stringify(name)};
	const rec = window[N];
	if (!rec) { return { missing: true, url: location.href, title: document.title }; }
	rec.mo.disconnect();
	delete window[N];
	const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', DIALOG: 'dialog', LI: 'listitem', TR: 'row', TD: 'cell', TH: 'columnheader', TABLE: 'table', FORM: 'form', OPTION: 'option', IMG: 'img', UL: 'list', OL: 'list', LABEL: 'label', IFRAME: 'iframe', P: 'paragraph' };
	const INTERACTIVE = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=switch], [role=radio], [role=option], [role=tab], [role=menuitem], [role=combobox], [role=textbox]';
	const clean = text => (text || '').replace(/\\s+/g, ' ').trim();
	const visible = el => {
		if (!el.isConnected || el.closest('[aria-hidden="true"]')) { return false; }
		const rects = el.getClientRects();
		if (!rects.length) { return false; }
		const style = getComputedStyle(el);
		if (style.visibility === 'hidden' || style.display === 'none') { return false; }
		return Array.from(rects).some(r => r.width > 0 && r.height > 0);
	};
	const roleOf = el => {
		const role = el.getAttribute('role');
		if (role) { return role; }
		if (el.tagName === 'INPUT') { const type = (el.type || 'text').toLowerCase(); return type === 'checkbox' || type === 'radio' ? type : (type === 'button' || type === 'submit' || type === 'reset') ? 'button' : 'textbox'; }
		return IMPLICIT[el.tagName] || el.tagName.toLowerCase();
	};
	const nameOf = el => {
		const label = el.getAttribute('aria-label');
		if (label) { return clean(label); }
		const by = el.getAttribute('aria-labelledby');
		if (by) { const text = by.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(x => x.textContent).join(' '); if (clean(text)) { return clean(text); } }
		if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
			const own = el.labels && el.labels[0] ? clean(el.labels[0].textContent) : '';
			return own || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'));
		}
		return clean(el.innerText !== undefined ? el.innerText : el.textContent);
	};
	const stateOf = el => {
		const s = [];
		if (el.disabled || el.getAttribute('aria-disabled') === 'true') { s.push('disabled'); }
		if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { s.push(el.checked ? 'checked' : 'not checked'); }
		for (const a of ['aria-checked', 'aria-expanded', 'aria-selected', 'aria-pressed']) { const v = el.getAttribute(a); if (v !== null) { s.push(a.slice(5) + '=' + v); } }
		if ((el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
			s.push(el.type === 'password' ? 'value=(' + el.value.length + ' chars)' : 'value=' + JSON.stringify(String(el.value).slice(0, 80)));
		}
		if (el.getAttribute('aria-invalid') === 'true') { s.push('invalid'); }
		return s.length ? ' [' + s.join(', ') + ']' : '';
	};
	const line = el => { const name = nameOf(el).slice(0, 160); return roleOf(el) + (name ? ' ' + JSON.stringify(name) : '') + stateOf(el); };
	const out = { url: location.href, title: document.title, navigated: rec.navigated, added: [], changed: [], removed: rec.removed.map(r => (r.tag === 'text' ? '' : r.tag + ' ') + JSON.stringify(r.text)), more: rec.overflow };
	const addedSet = new Set(rec.added.filter(el => el.isConnected));
	const insideAdded = el => { for (let p = el.parentElement; p; p = p.parentElement) { if (addedSet.has(p)) { return true; } } return false; };
	const tops = Array.from(addedSet).filter(el => !insideAdded(el) && visible(el));
	tops.sort((a, b) => { const da = a.matches('dialog, [role=dialog], [role=alertdialog], [aria-modal=true]') ? 0 : 1; const db = b.matches('dialog, [role=dialog], [role=alertdialog], [aria-modal=true]') ? 0 : 1; return da - db || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1); });
	for (const el of tops) {
		out.added.push(line(el));
		if (!el.matches(INTERACTIVE)) {
			const controls = Array.from(el.querySelectorAll(INTERACTIVE)).filter(visible).slice(0, 8);
			for (const c of controls) { out.added.push('  ' + line(c)); }
		}
	}
	for (const el of rec.changed) {
		if (!el.isConnected || addedSet.has(el) || insideAdded(el) || !visible(el)) { continue; }
		out.changed.push(line(el));
	}
	const focus = document.activeElement;
	if (focus && focus !== rec.focusBefore && focus !== document.body && focus !== document.documentElement) { out.focus = line(focus); }
	if (rec.navigated) { out.text = clean(document.body ? document.body.innerText : '').slice(0, 600); }
	let budget = ${maxLines};
	for (const key of ['added', 'changed', 'removed']) {
		const kept = out[key].slice(0, Math.max(0, budget));
		out.more += out[key].length - kept.length;
		budget -= kept.length;
		out[key] = Array.from(new Set(kept));
	}
	return out;
}`;
}
