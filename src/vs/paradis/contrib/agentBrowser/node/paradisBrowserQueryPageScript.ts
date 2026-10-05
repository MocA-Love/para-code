/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// wait_until / get_text / inspect_element / scroll_to がページの中で動かす関数（文字列）。
// 内蔵 chrome-devtools-mcp の evaluate_script へ `function` として渡す。ビルドの変換（名前の付け替え・
// 補助関数の差し込み）を受けないよう、TypeScript の関数ではなく文字列で持つ。ページの中では
// Para Code の名前空間や import は使えない。
//
// 呼び方: `(spec, els, predicate) => 結果`。
//   - spec: paradisBrowserQuery.ts の IParadisQuerySpec（JSON）
//   - els: evaluate_script の uid 引数で受けた要素（spec.targetIndex / spec.withinIndex が指す）
//   - predicate: wait_until の述語（無ければ undefined）。呼ぶと関数か値を返す
// 戻り値は JSON にできる値だけにする（evaluate_script が JSON.stringify する）。

/** ページの中で動かす関数の本体。 */
export const PARADIS_BROWSER_QUERY_PAGE_SCRIPT = String.raw`async (spec, els, predicate) => {
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

	// --- get_text -------------------------------------------------------------------------------
	if (spec.mode === 'text') {
		const found = hasLocator ? find() : [document.body || document.documentElement];
		if (found === null) { return { withinMissing: true }; }
		const picked = spec.all ? found.slice(0, 50) : found.slice(0, 1);
		const parts = spec.all
			? picked.map((el, index) => '[' + index + '] ' + shortLabel(el) + '\n' + textOf(el))
			: picked.map(textOf);
		const combined = parts.join('\n\n');
		return { matched: found.length, returned: picked.length, total: combined.length, part: combined.slice(spec.offset, spec.offset + spec.maxChars), element: picked.length === 1 ? describe(picked[0]) : undefined };
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
			if (!hit) { pointer[label] = 'nothing'; }
			else if (hit === el) { pointer[label] = 'self'; }
			else if (el.contains(hit)) { pointer[label] = 'self (child ' + shortLabel(hit) + ')'; }
			else if (hit.contains(el)) { pointer[label] = 'ancestor ' + shortLabel(hit) + ' (this element does not receive the pointer here)'; }
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
	if (spec.mode === 'scroll') {
		let container;
		if (spec.container) {
			container = selectAll(document, spec.container, [])[0];
			if (!container) { return { containerMissing: true }; }
		} else {
			const scope = scopeOf();
			if (scope && scope !== document && scrollsAlong(scope)) {
				container = scope;
			} else {
				let best = null;
				let bestArea = 0;
				for (const candidate of collect(document, [])) {
					if (candidate === document.body || candidate === document.documentElement || !scrollsAlong(candidate)) { continue; }
					const area = visibleArea(candidate);
					if (area > bestArea) { best = candidate; bestArea = area; }
				}
				const page = pageScroller();
				container = best && (!scrollsAlong(page) || bestArea > innerWidth * innerHeight * 0.3) ? best : page;
			}
		}
		const label = isPageScroller(container) ? 'the page' : shortLabel(container);
		if (spec.reset) {
			if (isPageScroller(container)) { window.scrollTo({ top: vertical ? 0 : scrollY, left: vertical ? scrollX : 0, behavior: 'instant' }); }
			else if (vertical) { container.scrollTop = 0; }
			else { container.scrollLeft = 0; }
			return { found: false, reset: true, container: label };
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
			return { found: false, moved: 0, container: label };
		}
		const before = scrollPosition(container);
		const size = isPageScroller(container) ? (vertical ? innerHeight : innerWidth) : (vertical ? container.clientHeight : container.clientWidth);
		const step = spec.stepPx > 0 ? spec.stepPx : Math.max(40, Math.round(size * 0.8));
		const sign = spec.direction === 'up' || spec.direction === 'left' ? -1 : 1;
		const delta = { top: vertical ? sign * step : 0, left: vertical ? 0 : sign * step, behavior: 'instant' };
		if (isPageScroller(container)) { window.scrollBy(delta); } else { container.scrollBy(delta); }
		const after = scrollPosition(container);
		return { found: false, moved: Math.round(after - before), position: Math.round(after), container: label };
	}

	return { error: 'unknown mode' };
}`;
