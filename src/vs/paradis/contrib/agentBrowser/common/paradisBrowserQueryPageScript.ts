/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// wait_until / get_text / inspect_element / scroll_to と click_by / fill_by がページの中で動かす関数（文字列）。
// 内蔵 chrome-devtools-mcp の evaluate_script へ `function` として渡す。ビルドの変換（名前の付け替え・
// 補助関数の差し込み）を受けないよう、TypeScript の関数ではなく文字列で持つ。ページの中では
// Para Code の名前空間や import は使えない。
//
// 呼び方: `(spec, els, predicate, notAfter) => 結果`。
//   - spec: paradisBrowserQuery.ts の IParadisQuerySpec（JSON）
//   - els: evaluate_script の uid 引数で受けた要素（spec.targetIndex / spec.withinIndex が指す）
//   - predicate: wait_until の述語（無ければ undefined）。呼ぶと関数か値を返す
//   - notAfter: この時刻（エポックからの ms）を過ぎてから動き始めたら何もせずに `{ paraLate: true }` を返す（無ければ undefined）
// 戻り値は JSON にできる値だけにする（evaluate_script が JSON.stringify する）。
// どの層の API も使わない文字列なので common に置き、ブラウザのテスト（test/browser）が実際の文書で動かせるようにしている。

import { PARADIS_POINTER_HIT_PAGE_SCRIPT } from './paradisPointerHitPageScript.js';

/** ページの中で動かす関数の本体。 */
export const PARADIS_BROWSER_QUERY_PAGE_SCRIPT = String.raw`async (spec, els, predicate, notAfter) => {
	// Started too late (the page did not answer in time): do nothing, so a stale step does not scroll or type (q.html Q379).
	// The page's own Date may be faked (fake timers, a mocked date), so read the monotonic clock, and trust neither clock
	// when it is more than a day away from notAfter.
	if (typeof notAfter === 'number') {
		const pageNow = typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number' && typeof performance.now === 'function' ? performance.timeOrigin + performance.now() : Date.now();
		if (pageNow > notAfter && pageNow - notAfter < 86400000) { return { paraLate: true }; }
	}
	const MAX_ELEMENTS = 20000;
	const norm = value => String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
	const squash = value => String(value === null || value === undefined ? '' : value).replace(/\s+/g, '').toLowerCase();
	const lower = value => norm(value).toLowerCase();
	const cut = (value, max) => { const text = norm(value); return text.length > max ? text.slice(0, max) + '...' : text; };
	const matches = (value, wanted) => spec.exact ? norm(value) === norm(wanted) : lower(value).includes(lower(wanted));
	const textOf = el => (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
	const vertical = spec.direction !== 'left' && spec.direction !== 'right';

	const visible = el => {
		if (!el || !el.isConnected) { return false; }
		if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) { return false; }
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};
${PARADIS_POINTER_HIT_PAGE_SCRIPT}

	const IMPLICIT_ROLES = {
		button: 'button', textarea: 'textbox', option: 'option', li: 'listitem', ul: 'list', ol: 'list', menu: 'list',
		nav: 'navigation', main: 'main', aside: 'complementary', header: 'banner', footer: 'contentinfo', form: 'form',
		dialog: 'dialog', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', thead: 'rowgroup', tbody: 'rowgroup',
		tfoot: 'rowgroup', progress: 'progressbar', meter: 'meter', output: 'status', article: 'article', section: 'region',
		fieldset: 'group', details: 'group', summary: 'button', hr: 'separator', p: 'paragraph', img: 'img',
		h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
	};
	const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'listitem', 'checkbox', 'radio', 'switch', 'tooltip', 'row', 'gridcell']);

	const roleOf = el => {
		const explicit = norm(el.getAttribute('role')).split(' ')[0];
		if (explicit) { return explicit.toLowerCase(); }
		const tag = el.localName;
		if (tag === 'a' || tag === 'area') { return el.hasAttribute('href') ? 'link' : ''; }
		if (tag === 'input') {
			const type = lower(el.getAttribute('type') || 'text');
			if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') { return 'button'; }
			if (type === 'checkbox' || type === 'radio') { return type; }
			if (type === 'range') { return 'slider'; }
			if (type === 'number') { return 'spinbutton'; }
			if (type === 'hidden') { return ''; }
			if (el.hasAttribute('list')) { return 'combobox'; }
			return type === 'search' ? 'searchbox' : 'textbox';
		}
		if (tag === 'select') { return el.multiple || el.size > 1 ? 'listbox' : 'combobox'; }
		if (tag === 'img' && el.getAttribute('alt') === '') { return 'presentation'; }
		return IMPLICIT_ROLES[tag] || '';
	};

	const byId = (el, id) => {
		const root = el.getRootNode();
		return (root && typeof root.getElementById === 'function' ? root.getElementById(id) : null) || document.getElementById(id);
	};

	const nameOf = el => {
		const labelledBy = norm(el.getAttribute('aria-labelledby'));
		if (labelledBy) {
			const text = norm(labelledBy.split(' ').map(id => { const label = byId(el, id); return label ? textOf(label) : ''; }).join(' '));
			if (text) { return text; }
		}
		const label = norm(el.getAttribute('aria-label'));
		if (label) { return label; }
		const tag = el.localName;
		if (tag === 'input' || tag === 'select' || tag === 'textarea') {
			const type = lower(el.getAttribute('type'));
			if (type === 'button' || type === 'submit' || type === 'reset') { return norm(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''); }
			if (type === 'image') { return norm(el.getAttribute('alt')) || norm(el.getAttribute('title')); }
			const labels = el.labels ? norm(Array.from(el.labels).map(textOf).join(' ')) : '';
			return labels || norm(el.getAttribute('placeholder')) || norm(el.getAttribute('title'));
		}
		if (tag === 'img' || tag === 'area') { return norm(el.getAttribute('alt')) || norm(el.getAttribute('title')); }
		if (tag === 'fieldset') { const legend = el.querySelector('legend'); if (legend) { return norm(textOf(legend)); } }
		if (tag === 'table') { const caption = el.querySelector('caption'); if (caption) { return norm(textOf(caption)); } }
		if (NAME_FROM_CONTENT.has(roleOf(el))) { return norm(textOf(el)); }
		return norm(el.getAttribute('title'));
	};

	const collect = (root, out) => {
		for (const node of root.querySelectorAll('*')) {
			if (out.length >= MAX_ELEMENTS) { break; }
			out.push(node);
			if (node.shadowRoot) { collect(node.shadowRoot, out); }
		}
		return out;
	};
	const selectAll = (root, selector, out) => {
		for (const node of root.querySelectorAll(selector)) { out.push(node); }
		for (const node of root.querySelectorAll('*')) {
			if (node.shadowRoot) { selectAll(node.shadowRoot, selector, out); }
		}
		return out;
	};

	const describe = el => {
		const rect = el.getBoundingClientRect();
		const out = { tag: el.localName };
		if (el.id) { out.id = el.id; }
		const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 4) : [];
		if (classes.length > 0) { out.classes = classes; }
		const role = roleOf(el);
		if (role) { out.role = role; }
		const name = cut(nameOf(el), 100);
		if (name) { out.name = name; }
		const text = cut(textOf(el), 100);
		if (text && text !== name) { out.text = text; }
		out.visible = visible(el);
		out.rect = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
		// The rect is relative to the element's own frame, not the page's viewport.
		if (window.top !== window || el.ownerDocument !== document) { out.inIframe = true; }
		return out;
	};
	const shortLabel = el => {
		let label = el.localName;
		if (el.id) { label += '#' + el.id; }
		const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
		for (const name of classes) { label += '.' + name; }
		return label;
	};

	const hasLocator = spec.targetIndex !== undefined || !!spec.selector || !!spec.role || !!spec.text;

	/** The container searched in. null: "within" matched nothing. */
	const scopeOf = () => {
		if (spec.withinIndex !== undefined) { return els[spec.withinIndex] || null; }
		if (spec.within) { return selectAll(document, spec.within, [])[0] || null; }
		return document;
	};

	/** Matching elements in document order. null: the "within" container was not found. */
	const find = () => {
		if (spec.targetIndex !== undefined) {
			const el = els[spec.targetIndex];
			return el && el.isConnected ? [el] : [];
		}
		const scope = scopeOf();
		if (scope === null) { return null; }
		return findIn(scope);
	};
	const findIn = scope => {
		let list = spec.selector ? selectAll(scope, spec.selector, []) : undefined;
		if (spec.role) {
			const role = lower(spec.role);
			list = (list || collect(scope, [])).filter(el => roleOf(el) === role && (!spec.name || matches(nameOf(el), spec.name)));
		}
		if (spec.text) {
			const wanted = squash(spec.text);
			const narrowed = list !== undefined;
			const hits = (list || collect(scope, [])).filter(el => squash(el.textContent).includes(wanted) && matches(textOf(el), spec.text)).slice(0, 2000);
			list = narrowed ? hits : hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
		}
		return Array.from(new Set(list || []));
	};

	// --- what is close to a locator that matched nothing ----------------------------------------
	// Run once, only after a miss (click_by / fill_by / get_text found nothing, or wait_until timed out). Reads the
	// DOM once, returns at most NEAR_MAX candidates of at most NEAR_CUT characters, and never reads what is typed in
	// a form field (the value of input / textarea / select, the content of contenteditable): only the number of fields.
	const NEAR_MAX = 5;
	const NEAR_CUT = 60;
	const NEAR_SOURCE_MAX = 300;
	const NEAR_ATTRIBUTES = ['aria-label', 'title', 'alt', 'placeholder'];
	const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
	const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
	const NAMED_ROLES = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'dialog', 'cell', 'columnheader', 'rowheader', 'gridcell']);
	const fold = value => {
		let text = String(value === null || value === undefined ? '' : value);
		try { text = text.normalize('NFKC'); } catch { /* keep as is */ }
		return text.replace(/\s+/g, '').toLowerCase();
	};
	/** Pairs of neighbouring characters, with the start and the end marked (so "Item 3" is closer to "Itme 3" than "Item 1" is). */
	const pairsOf = value => { const padded = ' ' + value + ' '; const out = new Map(); for (let i = 0; i < padded.length - 1; i++) { const pair = padded.slice(i, i + 2); out.set(pair, (out.get(pair) || 0) + 1); } return out; };
	/** How close a candidate is to the wanted text (0-1). Both are folded (NFKC, no spaces, lower case). */
	const closeness = (wanted, wantedPairs, candidate) => {
		if (!candidate || !wanted) { return 0; }
		if (candidate.includes(wanted)) { return 1; }
		if (candidate.length >= 2 && wanted.includes(candidate)) { return 0.5 + 0.4 * candidate.length / wanted.length; }
		const pairs = pairsOf(candidate);
		let shared = 0;
		for (const [pair, count] of wantedPairs) { shared += Math.min(count, pairs.get(pair) || 0); }
		return 2 * shared / (wanted.length + 1 + candidate.length + 1);
	};
	const inField = el => !!(el.closest && el.closest('input, textarea, select')) || !!el.isContentEditable;
	const ownText = el => { let out = ''; for (const node of el.childNodes) { if (node.nodeType === 3) { out += node.nodeValue; } } return norm(out); };
	/** The element itself or a close ancestor with a role that has a name: how to give it as role + name. */
	const namedControl = el => {
		let current = el;
		for (let depth = 0; current && depth < 4; depth++) {
			if (current.nodeType === 1 && NAMED_ROLES.has(roleOf(current))) { return current; }
			current = current.parentElement;
		}
		return undefined;
	};
	const truncate = value => { const text = norm(value); return text.length > NEAR_CUT ? text.slice(0, NEAR_CUT) : text; };
	/** Elements in the pool whose text or name is close to "wanted", as locators that can be given as they are. */
	const closeCandidates = (pool, wanted, role) => {
		const folded = fold(wanted);
		if (!folded) { return []; }
		const wantedPairs = pairsOf(folded);
		const scored = [];
		for (const el of pool) {
			if (SKIP_TAGS.has(el.localName)) { continue; }
			if (role) {
				const value = nameOf(el);
				const score = closeness(folded, wantedPairs, fold(value.slice(0, NEAR_SOURCE_MAX)));
				if (score >= 0.35) { scored.push({ el, score, source: 'name', value }); }
				continue;
			}
			if (!FIELD_TAGS.has(el.localName) && !inField(el)) {
				const value = ownText(el);
				if (value && value.length <= NEAR_SOURCE_MAX) {
					const score = closeness(folded, wantedPairs, fold(value));
					if (score >= 0.35) { scored.push({ el, score, source: 'text', value }); }
				}
			}
			for (const attribute of NEAR_ATTRIBUTES) {
				const value = norm(el.getAttribute(attribute));
				if (value && value.length <= NEAR_SOURCE_MAX) {
					const score = closeness(folded, wantedPairs, fold(value));
					if (score >= 0.35) { scored.push({ el, score, source: 'attribute', value }); }
				}
			}
		}
		scored.sort((a, b) => b.score - a.score);
		const out = [];
		const seen = new Set();
		for (const entry of scored) {
			if (out.length >= NEAR_MAX) { break; }
			if (!visible(entry.el)) { continue; }
			const control = role ? entry.el : namedControl(entry.el);
			const candidate = {};
			if (control) {
				const name = truncate(nameOf(control));
				if (name) { candidate.role = roleOf(control); candidate.name = name; }
			}
			if (entry.source === 'text') { candidate.text = truncate(entry.value); }
			if (!candidate.name && !candidate.text) { continue; }
			const key = JSON.stringify(candidate);
			if (seen.has(key)) { continue; }
			seen.add(key);
			out.push(candidate);
		}
		return out;
	};
	const countSafe = (root, selector) => { try { return selectAll(root, selector, []).length; } catch { return -1; } };
	/** Same-origin frames that can be searched, and how many cannot (cross-origin). */
	const framesOf = () => {
		const out = { documents: [], crossOrigin: 0 };
		for (const frame of Array.from(document.querySelectorAll('iframe, frame')).slice(0, 20)) {
			let inner = null;
			try { inner = frame.contentDocument; } catch { inner = null; }
			if (inner && inner.documentElement) { out.documents.push(inner); } else { out.crossOrigin++; }
		}
		return out;
	};
	/** Why a CSS selector matches nothing: the parts that match nothing, similar ids / classes / attribute values that exist. */
	const selectorHints = (scope, selector, all) => {
		const out = {};
		// Attribute values and :not(...) may hold spaces, ">", "~", "," and dots: set them aside while splitting.
		const kept = [];
		const masked = selector.trim().replace(/\[[^\]]*\]|\([^)]*\)/g, part => { kept.push(part); return '\u0001' + (kept.length - 1) + '\u0001'; });
		if (masked.includes(',')) { return out; }
		const unmask = value => value.replace(/\u0001(?<index>\d+)\u0001/g, (...args) => kept[Number(args[args.length - 1].index)]);
		const compounds = masked.split(/\s*[>+~]\s*|\s+/).filter(Boolean).map(unmask);
		const last = compounds[compounds.length - 1];
		if (compounds.length > 1 && last) {
			const count = countSafe(scope, last);
			if (count > 0) { out.lastPart = { part: last.slice(0, 80), count }; }
		}
		const tokens = Array.from(new Set((masked.match(/#[\w-]+|\.[\w-]+/g) || []).concat(kept.filter(part => part[0] === '[')))).slice(0, 12);
		const missing = tokens.filter(token => countSafe(document, token) === 0);
		if (missing.length > 0) { out.missingParts = missing.slice(0, NEAR_MAX).map(token => token.slice(0, 80)); }
		const similar = [];
		for (const token of missing) {
			if (similar.length >= NEAR_MAX) { break; }
			let kind; let wanted; let attribute;
			if (token[0] === '#') { kind = 'id'; wanted = token.slice(1); }
			else if (token[0] === '.') { kind = 'class'; wanted = token.slice(1); }
			else {
				const parts = /^\[\s*(?<name>[\w:-]+)\s*(?:[~|^$*]?=\s*["']?(?<value>[^"'\]]*)["']?\s*(?:[is])?)?\s*\]$/.exec(token);
				if (!parts || !parts.groups || !parts.groups.value || lower(parts.groups.name) === 'value') { continue; }
				kind = 'attribute'; attribute = parts.groups.name; wanted = parts.groups.value;
			}
			const folded = fold(wanted);
			const wantedPairs = pairsOf(folded);
			const counts = new Map();
			for (const el of all) {
				if (kind === 'id') { if (el.id) { counts.set(el.id, (counts.get(el.id) || 0) + 1); } }
				else if (kind === 'class') { if (el.classList) { for (const name of el.classList) { counts.set(name, (counts.get(name) || 0) + 1); } } }
				else if (!(el.localName === 'input' && lower(el.getAttribute('type')) === 'password')) { const value = el.getAttribute(attribute); if (value) { counts.set(value, (counts.get(value) || 0) + 1); } }
				if (counts.size > 5000) { break; }
			}
			const ranked = Array.from(counts.keys()).filter(value => value.length <= 120).map(value => ({ value, score: closeness(folded, wantedPairs, fold(value)) })).filter(entry => entry.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
			for (const entry of ranked) {
				const written = kind === 'id' ? '#' + entry.value : kind === 'class' ? '.' + entry.value : '[' + attribute + '="' + entry.value + '"]';
				similar.push({ instead: token.slice(0, 80), selector: written.slice(0, 80), count: counts.get(entry.value) });
			}
		}
		if (similar.length > 0) { out.similar = similar.slice(0, NEAR_MAX); }
		return out;
	};
	const nearMiss = () => {
		if (spec.targetIndex !== undefined) { return undefined; }
		const scope = scopeOf();
		if (scope === null) { return undefined; }
		const out = {};
		const all = collect(document, []);
		let pool;
		if (spec.selector) {
			const selected = (() => { try { return selectAll(scope, spec.selector, []); } catch { return null; } })();
			if (selected === null) { return undefined; }
			if (selected.length === 0) {
				Object.assign(out, selectorHints(scope, spec.selector, all));
			} else if (spec.role || spec.text) {
				out.selectorMatches = selected.length;
				pool = Array.from(new Set(selected.concat(selected.slice(0, 200).flatMap(el => collect(el, []))))).slice(0, MAX_ELEMENTS);
			}
		}
		if (!spec.selector || pool) {
			pool = pool || (scope === document ? all : collect(scope, []));
			if (spec.role) {
				const role = lower(spec.role);
				const sameRole = pool.filter(el => roleOf(el) === role);
				out.roleCount = sameRole.length;
				if (spec.name) { out.candidates = closeCandidates(sameRole.slice(0, 2000), spec.name, true); }
				if (spec.name && out.candidates.length < NEAR_MAX) {
					const others = closeCandidates(pool, spec.name, false).filter(candidate => candidate.role !== role || !candidate.name);
					out.candidates = out.candidates.concat(others).slice(0, NEAR_MAX);
				}
			} else if (spec.text) {
				out.candidates = closeCandidates(pool, spec.text, false);
				const wanted = lower(spec.text);
				out.inFields = all.filter(el => ((el.localName === 'input' && !isSecretInput(el)) || el.localName === 'textarea') && lower(el.value).includes(wanted)).length;
			}
		}
		if (scope !== document) {
			const outside = findIn(document);
			if (outside && outside.length > 0) { out.outsideWithin = outside.length; }
		}
		const frames = framesOf();
		let inFrames = 0;
		for (const inner of frames.documents) {
			try {
				if (spec.selector) { if (!pool) { inFrames += inner.querySelectorAll(spec.selector).length; } }
				else if (spec.text && inner.body && squash(inner.body.textContent).includes(squash(spec.text))) { inFrames++; }
			} catch { /* a frame being unloaded */ }
		}
		if (inFrames > 0) { out.inFrames = inFrames; }
		if (frames.crossOrigin > 0) { out.crossOriginFrames = frames.crossOrigin; }
		return out;
	};
	const isSecretInput = el => lower(el.getAttribute('type')) === 'password';

	const pageScroller = () => document.scrollingElement || document.documentElement;
	const isPageScroller = el => el === pageScroller() || el === document.documentElement || el === document.body;
	const scrollsAlong = el => {
		if (isPageScroller(el)) {
			return vertical ? pageScroller().scrollHeight > innerHeight + 1 : pageScroller().scrollWidth > innerWidth + 1;
		}
		const style = getComputedStyle(el);
		const overflow = vertical ? style.overflowY : style.overflowX;
		return /(auto|scroll|overlay)/.test(overflow) && (vertical ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1);
	};
	const visibleArea = el => {
		const rect = el.getBoundingClientRect();
		return Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
	};
	const scrollPosition = el => isPageScroller(el) ? (vertical ? scrollY : scrollX) : (vertical ? el.scrollTop : el.scrollLeft);

	// --- wait_until -----------------------------------------------------------------------------
	if (spec.mode === 'wait') {
		const deadline = Date.now() + spec.sliceMs;
		const check = async () => {
			const result = { met: true };
			if (hasLocator) {
				const found = find();
				if (found === null) {
					result.withinMissing = true;
					result.matched = 0;
					result.visible = 0;
					result.met = spec.state === 'hidden' || spec.state === 'detached';
				} else {
					const shown = found.filter(visible);
					result.matched = found.length;
					result.visible = shown.length;
					if (spec.state === 'attached') {
						result.met = found.length >= spec.count;
						if (found.length > 0) { result.element = describe(found[0]); }
					} else if (spec.state === 'hidden') {
						result.met = shown.length === 0;
					} else if (spec.state === 'detached') {
						result.met = found.length === 0;
					} else {
						result.met = shown.length >= spec.count;
						if (shown.length > 0) { result.element = describe(shown[0]); }
					}
				}
			}
			if (predicate !== undefined) {
				try {
					const value = predicate();
					// A promise that never settles must not keep this evaluate (and the pane's other tools) waiting past the slice.
					let timer;
					const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('the predicate did not settle within this check')), Math.max(50, deadline - Date.now())); });
					const outcome = await Promise.race([Promise.resolve(typeof value === 'function' ? value() : value), late]).finally(() => clearTimeout(timer));
					result.predicateValue = outcome === undefined ? 'undefined' : cut(JSON.stringify(outcome), 200);
					result.met = result.met && !!outcome;
				} catch (error) {
					result.met = false;
					result.predicateError = cut(error && error.message ? error.message : String(error), 300);
				}
			}
			return result;
		};
		for (;;) {
			const result = await check();
			if (result.met || Date.now() + spec.intervalMs > deadline) {
				result.url = location.href;
				return result;
			}
			await new Promise(resolve => setTimeout(resolve, spec.intervalMs));
		}
	}

	// --- wait_until timed out without a match: what is close to the locator (one read) ---------
	if (spec.mode === 'nearMiss') {
		return { near: nearMiss() || null };
	}

	// --- get_text -------------------------------------------------------------------------------
	if (spec.mode === 'text') {
		const found = hasLocator ? find() : [document.body || document.documentElement];
		if (found === null) { return { withinMissing: true }; }
		const picked = spec.all ? found.slice(0, 50) : found.slice(0, 1);
		const parts = spec.all
			? picked.map((el, index) => '[' + index + '] ' + shortLabel(el) + '\n' + textOf(el))
			: picked.map(textOf);
		const combined = parts.join('\n\n');
		return { matched: found.length, returned: picked.length, total: combined.length, part: combined.slice(spec.offset, spec.offset + spec.maxChars), element: picked.length === 1 ? describe(picked[0]) : undefined, near: hasLocator && found.length === 0 ? nearMiss() : undefined };
	}

	// --- inspect_element ------------------------------------------------------------------------
	if (spec.mode === 'inspect') {
		const found = find();
		if (found === null) { return { withinMissing: true }; }
		const el = found[spec.index];
		if (!el) { return { matched: found.length, notFound: true }; }
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		const styles = {};
		for (const property of spec.styles) { styles[property] = style.getPropertyValue(property); }
		const root = el.getRootNode();
		const hitTest = typeof root.elementFromPoint === 'function' ? root : document;
		const points = [
			['center', rect.left + rect.width / 2, rect.top + rect.height / 2],
			['top-left', rect.left + 1, rect.top + 1],
			['top-right', rect.right - 1, rect.top + 1],
			['bottom-left', rect.left + 1, rect.bottom - 1],
			['bottom-right', rect.right - 1, rect.bottom - 1],
		];
		const pointer = {};
		for (const [label, x, y] of points) {
			if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || rect.width <= 0 || rect.height <= 0) { pointer[label] = 'outside the viewport'; continue; }
			const hit = hitTest.elementFromPoint(x, y);
			const reach = hit ? pointerHit(el, hit) : undefined;
			if (!hit) { pointer[label] = 'nothing'; }
			else if (reach === 'self') { pointer[label] = 'self'; }
			else if (reach === 'child') { pointer[label] = 'self (child ' + shortLabel(hit) + ')'; }
			else if (reach === 'ancestor') { pointer[label] = 'ancestor ' + shortLabel(hit) + ' (this element does not receive the pointer here)'; }
			else { pointer[label] = { coveredBy: describe(hit) }; }
		}
		const ancestors = [];
		let parent = el.parentElement || (root && root.host) || null;
		while (parent && ancestors.length < 10) {
			const parentStyle = getComputedStyle(parent);
			const clips = parentStyle.overflowX !== 'visible' || parentStyle.overflowY !== 'visible';
			if (clips) {
				const parentRect = parent.getBoundingClientRect();
				ancestors.push({
					element: shortLabel(parent),
					overflow: parentStyle.overflowX + ' ' + parentStyle.overflowY,
					scrollTop: Math.round(parent.scrollTop), scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight,
					scrollLeft: Math.round(parent.scrollLeft), scrollWidth: parent.scrollWidth, clientWidth: parent.clientWidth,
					clipsThisElement: rect.top < parentRect.top - 1 || rect.left < parentRect.left - 1 || rect.bottom > parentRect.bottom + 1 || rect.right > parentRect.right + 1,
				});
			}
			const next = parent.parentElement;
			parent = next || (parent.getRootNode() !== document ? parent.getRootNode().host || null : null);
		}
		const aria = {};
		for (const attribute of Array.from(el.attributes)) {
			if (attribute.name.startsWith('aria-') || attribute.name === 'role' || attribute.name === 'tabindex' || attribute.name === 'hidden' || attribute.name === 'inert' || attribute.name === 'disabled') {
				aria[attribute.name] = cut(attribute.value, 200);
			}
		}
		let active = document.activeElement;
		while (active && active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; }
		const disabled = (typeof el.matches === 'function' && el.matches(':disabled')) || !!el.closest('[aria-disabled="true"]') || !!el.closest('[inert]');
		return {
			matched: found.length,
			index: spec.index,
			element: describe(el),
			inMainFrame: window.top === window,
			viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
			rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
			inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
			fullyInViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
			visible: visible(el),
			enabled: !disabled,
			focused: active === el,
			editable: !!el.isContentEditable || ((el.localName === 'input' || el.localName === 'textarea') && !el.readOnly && !disabled),
			pointer,
			overflow: {
				contentOverflowsX: el.scrollWidth > el.clientWidth + 1,
				contentOverflowsY: el.scrollHeight > el.clientHeight + 1,
				textCutWithEllipsis: style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1,
			},
			clippingAncestors: ancestors,
			role: roleOf(el),
			name: cut(nameOf(el), 200),
			aria,
			styles,
		};
	}

	// --- scroll_to (one step) -------------------------------------------------------------------
	const pickContainer = () => {
		if (spec.container) {
			return selectAll(document, spec.container, [])[0] || null;
		}
		const scope = scopeOf();
		if (scope && scope !== document && scrollsAlong(scope)) {
			return scope;
		}
		let best = null;
		let bestArea = 0;
		for (const candidate of collect(document, [])) {
			if (candidate === document.body || candidate === document.documentElement || !scrollsAlong(candidate)) { continue; }
			const area = visibleArea(candidate);
			if (area > bestArea) { best = candidate; bestArea = area; }
		}
		const page = pageScroller();
		return best && (!scrollsAlong(page) || bestArea > innerWidth * innerHeight * 0.3) ? best : page;
	};
	const extentOf = el => isPageScroller(el) ? (vertical ? pageScroller().scrollHeight : pageScroller().scrollWidth) : (vertical ? el.scrollHeight : el.scrollWidth);
	const maxPosition = el => Math.max(0, extentOf(el) - (isPageScroller(el) ? (vertical ? innerHeight : innerWidth) : (vertical ? el.clientHeight : el.clientWidth)));
	const scrollToPosition = (el, position) => {
		if (isPageScroller(el)) { window.scrollTo({ top: vertical ? position : scrollY, left: vertical ? scrollX : position, behavior: 'instant' }); }
		else if (vertical) { el.scrollTop = position; }
		else { el.scrollLeft = position; }
	};
	if (spec.mode === 'scroll') {
		const container = pickContainer();
		if (!container) { return { containerMissing: true }; }
		const label = isPageScroller(container) ? 'the page' : shortLabel(container);
		if (spec.reset) {
			// resetTo "end": the far end, for a search that goes up or left.
			const before = scrollPosition(container);
			scrollToPosition(container, spec.resetTo === 'end' ? maxPosition(container) : 0);
			return { found: false, reset: true, container: label, before: Math.round(before), position: Math.round(scrollPosition(container)) };
		}
		if (typeof spec.restoreTo === 'number') {
			// Only undo our own scrolling: not when the user scrolled meanwhile, or when another area is picked now.
			if (label !== spec.expectContainer || typeof spec.expectAt !== 'number' || Math.abs(scrollPosition(container) - spec.expectAt) > 1) {
				return { restored: false, container: label };
			}
			scrollToPosition(container, spec.restoreTo);
			return { restored: true, container: label };
		}
		const found = find();
		if (found === null && spec.withinIndex === undefined && !spec.container) {
			// "within" is not rendered yet; scroll the page to look for it.
		} else if (found === null) {
			return { withinMissing: true };
		}
		if (found && found.length > 0) {
			const el = found[0];
			el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
			return { found: true, matched: found.length, element: describe(el), container: label };
		}
		if (spec.checkOnly) {
			return { found: false, moved: 0, container: label, extent: Math.round(extentOf(container)) };
		}
		const before = scrollPosition(container);
		const size = isPageScroller(container) ? (vertical ? innerHeight : innerWidth) : (vertical ? container.clientHeight : container.clientWidth);
		const step = spec.stepPx > 0 ? spec.stepPx : Math.max(40, Math.round(size * 0.8));
		const sign = spec.direction === 'up' || spec.direction === 'left' ? -1 : 1;
		const delta = { top: vertical ? sign * step : 0, left: vertical ? 0 : sign * step, behavior: 'instant' };
		if (isPageScroller(container)) { window.scrollBy(delta); } else { container.scrollBy(delta); }
		const after = scrollPosition(container);
		return { found: false, moved: Math.round(after - before), before: Math.round(before), position: Math.round(after), max: Math.round(maxPosition(container)), extent: Math.round(extentOf(container)), container: label };
	}

	// --- scroll_to (why nothing was found) ------------------------------------------------------
	// Run once after a miss: things that keep an element out of reach of scrolling.
	if (spec.mode === 'scrollMiss') {
		const all = collect(document, []);
		const hints = {};
		if (spec.text) {
			const wanted = lower(spec.text);
			const fields = all.filter(el => ((el.localName === 'input' || el.localName === 'textarea') && lower(el.value).includes(wanted))
				|| (el.localName === 'select' && Array.from(el.selectedOptions || []).some(option => lower(option.textContent).includes(wanted))));
			if (fields.length > 0) { hints.inField = { count: fields.length, first: describe(fields[0]) }; }
		}
		const collapsed = all.filter(el => el.getAttribute('aria-expanded') === 'false' && visible(el));
		if (collapsed.length > 0) {
			hints.collapsed = { count: collapsed.length, names: collapsed.slice(0, 3).map(el => cut(nameOf(el) || textOf(el), 60)) };
		}
		const dialog = all.find(el => ((el.localName === 'dialog' && el.open) || roleOf(el) === 'dialog' || roleOf(el) === 'alertdialog' || el.getAttribute('aria-modal') === 'true') && visible(el));
		if (dialog) { hints.dialog = cut(nameOf(dialog) || textOf(dialog), 80); }
		if (spec.role && spec.name) {
			const role = lower(spec.role);
			hints.sameRole = all.filter(el => roleOf(el) === role && visible(el)).map(el => cut(nameOf(el), 60)).filter(Boolean).slice(0, 8);
		}
		const used = pickContainer();
		hints.otherContainers = all.filter(el => el !== used && el !== document.body && el !== document.documentElement && scrollsAlong(el) && visibleArea(el) > 0)
			.sort((a, b) => visibleArea(b) - visibleArea(a)).slice(0, 3).map(shortLabel);
		return hints;
	}

	// --- click_by / fill_by --------------------------------------------------------------------
	// The element found by "locate" is kept under a nonce (spec.ref) in a page-global map of WeakRefs, so the
	// next evaluate of the same tool call acts on the same element without marking the DOM.
	const REFS_KEY = Symbol.for('paradis.browser.actTargets');
	const remember = el => {
		const refs = window[REFS_KEY] || (window[REFS_KEY] = new Map());
		for (const [key, value] of refs) { if (!value.deref()) { refs.delete(key); } }
		while (refs.size >= 32) { refs.delete(refs.keys().next().value); }
		refs.set(spec.ref, new WeakRef(el));
	};
	const recall = () => { const value = window[REFS_KEY] ? window[REFS_KEY].get(spec.ref) : undefined; const el = value ? value.deref() : undefined; return el && el.isConnected ? el : undefined; };
	const deepActive = () => { let active = document.activeElement; while (active && active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; } return active; };
	const isDisabled = el => (typeof el.matches === 'function' && el.matches(':disabled')) || !!el.closest('[aria-disabled="true"]') || !!el.closest('[inert]');
	const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
	// Date and time fields have segments, not a text selection: Input.insertText does not replace their value,
	// so they get the value through the native setter (which React's value tracker notices) and input/change.
	const VALUE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);
	const kindOf = el => {
		const tag = el.localName;
		if (tag === 'select') { return 'select'; }
		if (tag === 'textarea') { return 'text'; }
		if (tag === 'input') {
			const type = lower(el.getAttribute('type'));
			if (type === 'checkbox' || type === 'radio') { return type; }
			return TEXT_INPUT_TYPES.has(type) ? 'text' : VALUE_INPUT_TYPES.has(type) ? 'value' : 'other';
		}
		if (el.isContentEditable) { return 'text'; }
		return 'other';
	};
	/** fill_by on a wrapper (an MUI TextField, a labelled group): the field inside it. */
	const fieldOf = el => {
		if (kindOf(el) !== 'other') { return el; }
		const inner = selectAll(el, 'input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"]', []);
		return inner.find(visible) || inner[0] || el;
	};
	const valueOf = el => {
		const kind = kindOf(el);
		if (kind === 'checkbox' || kind === 'radio') { return el.checked ? 'true' : 'false'; }
		if (kind === 'select') { return Array.from(el.selectedOptions || []).map(option => option.value).join(','); }
		if (el.localName === 'input' || el.localName === 'textarea') { return el.value; }
		return textOf(el);
	};
	/** What is shown to the agent: a password field's value is never returned, only its length. */
	const isSecret = el => el.localName === 'input' && lower(el.getAttribute('type')) === 'password';
	const shownValue = (el, max) => isSecret(el) ? '(' + valueOf(el).length + ' characters, hidden)' : cut(valueOf(el), max);
	/** Where a pointer at the center of the element would land, and why it would not reach the element. */
	const hitAt = el => {
		const rect = el.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		const out = { x, y, rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } };
		if (rect.width <= 0 || rect.height <= 0) { out.problem = 'zero-size'; return out; }
		if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) { out.problem = 'outside-viewport'; return out; }
		let hit = document.elementFromPoint(x, y);
		while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) { break; } hit = inner; }
		if (!hit) { out.problem = 'nothing-at-point'; return out; }
		// The element itself or something inside it (also inside its shadow root) takes the click. An ancestor takes it only when
		// the element does not receive the pointer (pointer-events: none), as it would for a person, or when it is the link or button
		// that holds the element (said so in the result, q.html Q396); not when the element is clipped away at the point (the click
		// would land on the ancestor), and never for a field, which must get focus itself.
		if (pointerHit(el, hit) === 'ancestor' && spec.purpose !== 'fill' && pointerControl(el, hit)) {
			out.receivedBy = describe(hit);
		}
		if (!pointerReaches(el, hit, spec.purpose)) {
			// A <label> for the element forwards the click to it.
			const label = hit.closest ? hit.closest('label') : null;
			if (!(label && el.labels && Array.from(el.labels).includes(label))) {
				out.problem = 'covered';
				out.coveredBy = describe(hit);
			}
		}
		return out;
	};

	if (spec.mode === 'locate') {
		const found = find();
		if (found === null) { return { withinMissing: true }; }
		if (found.length === 0) { return { matched: 0, near: nearMiss() }; }
		let el;
		if (spec.index !== undefined) {
			el = found[spec.index];
			if (!el) { return { matched: found.length, noIndex: true }; }
		} else {
			el = found.find(candidate => visible(candidate) && !isDisabled(candidate)) || found.find(visible) || found[0];
		}
		const target = spec.purpose === 'fill' ? fieldOf(el) : el;
		if (target.ownerDocument !== document || window.top !== window) { return { matched: found.length, element: describe(target), problem: 'iframe' }; }
		const kind = kindOf(target);
		// A native checkbox / radio hidden behind a custom look is clicked through its visible label.
		let pointEl = target;
		if ((kind === 'checkbox' || kind === 'radio') && !visible(target) && target.labels) {
			pointEl = Array.from(target.labels).find(visible) || target;
		}
		if (visible(pointEl)) {
			const rect = pointEl.getBoundingClientRect();
			if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
				pointEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
			}
		}
		remember(target);
		const hit = hitAt(pointEl);
		const out = {
			matched: found.length,
			element: describe(target),
			kind,
			visible: visible(pointEl),
			enabled: !isDisabled(target),
			readOnly: !!target.readOnly,
			focused: deepActive() === target,
			value: shownValue(target, 200),
			secret: isSecret(target),
			x: hit.x, y: hit.y,
			viewport: { width: innerWidth, height: innerHeight },
		};
		if (hit.problem) { out.problem = hit.problem; }
		if (hit.coveredBy) { out.coveredBy = hit.coveredBy; }
		if (hit.receivedBy) { out.receivedBy = hit.receivedBy; }
		if (kind === 'select') { out.options = Array.from(target.options).slice(0, 50).map(option => ({ value: option.value, label: cut(option.label || option.text, 80) })); }
		return out;
	}

	if (spec.mode === 'focusField') {
		const el = recall();
		if (!el) { return { lost: true }; }
		if (deepActive() !== el && typeof el.focus === 'function') { el.focus({ preventScroll: true }); }
		const focused = deepActive() === el;
		if (focused) {
			if (el.localName === 'input' || el.localName === 'textarea') {
				try { el.select(); } catch { /* types without a text selection */ }
			} else if (el.isContentEditable) {
				const range = document.createRange();
				range.selectNodeContents(el);
				const selection = getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
			}
		}
		return { focused, value: shownValue(el, 200), empty: valueOf(el).length === 0 };
	}

	if (spec.mode === 'setValue') {
		const el = recall();
		if (!el) { return { lost: true }; }
		el.focus({ preventScroll: true });
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
		setter.call(el, spec.value);
		el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return { value: valueOf(el), accepted: valueOf(el) === spec.value };
	}

	if (spec.mode === 'selectOption') {
		const el = recall();
		if (!el) { return { lost: true }; }
		const wanted = spec.value;
		const option = Array.from(el.options).find(candidate => candidate.value === wanted) || Array.from(el.options).find(candidate => norm(candidate.label || candidate.text) === norm(wanted)) || Array.from(el.options).find(candidate => lower(candidate.label || candidate.text).includes(lower(wanted)));
		if (!option) { return { noOption: true, options: Array.from(el.options).slice(0, 50).map(candidate => ({ value: candidate.value, label: cut(candidate.label || candidate.text, 80) })) }; }
		if (!option.selected || el.multiple) {
			// The same as a user choosing it: the framework's listeners see input and change.
			if (el.multiple) { for (const candidate of el.options) { candidate.selected = candidate === option; } } else { el.value = option.value; }
			el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		}
		return { value: valueOf(el), label: cut(option.label || option.text, 80) };
	}

	// --- capture_screenshot: the document rectangle of an element ------------------------------
	if (spec.mode === 'rect') {
		const found = find();
		if (found === null) { return { withinMissing: true }; }
		if (found.length === 0) { return { matched: 0 }; }
		const el = spec.index !== undefined ? found[spec.index] : (found.find(visible) || found[0]);
		if (!el) { return { matched: found.length, noIndex: true }; }
		if (el.ownerDocument !== document || window.top !== window) { return { matched: found.length, element: describe(el), problem: 'iframe' }; }
		const rect = el.getBoundingClientRect();
		const page = pageScroller();
		return {
			matched: found.length,
			element: describe(el),
			x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height,
			documentWidth: Math.max(page.scrollWidth, innerWidth), documentHeight: Math.max(page.scrollHeight, innerHeight),
		};
	}

	if (spec.mode === 'readField') {
		const el = recall();
		if (!el) { return { lost: true }; }
		return { value: shownValue(el, 2000), secret: isSecret(el), length: valueOf(el).length, focused: deepActive() === el, element: describe(el) };
	}

	return { error: 'unknown mode' };
}`;
