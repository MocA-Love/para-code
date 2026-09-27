/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Design Mode がページへ入れる仕掛け（要素の選択と番号札）。
//
// main プロセスが `webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, …)`
// で流す。isolated world は DOM だけをページと共有し、JS の変数・プロトタイプは別になるので、
//  - ページの script は `globalThis.__paradisDesign` を見ることも差し替えることもできない
//  - ページが Promise や Array を書き換えても、ここの処理は影響を受けない
//  - ここから Para Code の機能を呼ぶ口は無い（main が戻り値を受け取るだけ）
// ページが触れるのは、画面に出した DOM（閉じた shadow root の外枠）だけ。ページが偽の
// クリックを投げても `isTrusted` で弾く。
//
// 要素の情報の集め方（セレクタの組み方・近くのテキスト・属性の伏せ方）は Orca（stablyai/orca、
// MIT License、Copyright (c) 2026 Lovecast Inc.）の src/main/browser/grab-guest-*.ts を元にした。
//
// 注意: このファイルの文字列はページの中で実行される。テンプレート文字列の中なので、ページ側の
// 正規表現に要るバックスラッシュは二重に書く（`\\s` → ページでは `\s`）。スタイルは CSP の
// style-src に掛からない `element.style` 経由でだけ当て、`innerHTML` は使わない（Trusted Types）。

import { IParadisDesignPin } from './paradisDesignMode.js';

const INSTALL_SCRIPT = `(function () {
	'use strict';
	var g = globalThis;
	if (g.__paradisDesign) { return; }

	var TEXT_MAX = 200;
	var NEARBY_MAX = 6;
	var HTML_MAX = 4096;
	var SELECTOR_MAX = 700;
	var PATH_MAX = 900;
	var TEXT_NODE_SCAN_LIMIT = 80;
	var ACCENT = '#005fb8';
	var SAFE_ATTRS = new Set(['id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt', 'title', 'placeholder', 'for', 'action', 'method']);
	var SECRET = ['access_token', 'auth_token', 'api_key', 'apikey', 'client_secret', 'oauth_state', 'x-amz-', 'session_id', 'sessionid', 'csrf', 'secret', 'password', 'passwd'];
	var STYLE_PROPS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'border', 'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'z-index'];

	function clamp(value, max) {
		var text = typeof value === 'string' ? value : '';
		return text.length <= max ? text : text.slice(0, max) + ' (truncated)';
	}
	function containsSecret(value) {
		if (!value) { return false; }
		var lower = String(value).toLowerCase();
		for (var i = 0; i < SECRET.length; i++) {
			if (lower.indexOf(SECRET[i]) !== -1) { return true; }
		}
		return false;
	}
	function sanitizeUrl(value) {
		try {
			var url = new URL(value, document.baseURI);
			if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') { return ''; }
			url.search = '';
			url.hash = '';
			return url.href;
		} catch (e) {
			return '';
		}
	}
	function normalizeSpaces(text) {
		return String(text || '').split(/\\s+/).join(' ').trim();
	}
	function boundedText(el, max) {
		try {
			var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			var parts = [];
			var length = 0;
			var inspected = 0;
			var node = walker.nextNode();
			while (node && length < max + 20 && inspected < TEXT_NODE_SCAN_LIMIT) {
				inspected++;
				var value = normalizeSpaces((node.nodeValue || '').slice(0, max + 20));
				if (value) {
					parts.push(value);
					length += value.length + 1;
				}
				node = walker.nextNode();
			}
			return clamp(parts.join(' '), max);
		} catch (e) {
			return '';
		}
	}
	function looksHashy(value) {
		return /^[A-Za-z0-9_-]{12,}$/.test(value) && /[0-9]/.test(value) && /[A-Z]/.test(value);
	}
	function stableClasses(el, maxCount) {
		var result = [];
		if (!el.classList) { return result; }
		for (var i = 0; i < el.classList.length && result.length < maxCount; i++) {
			var name = el.classList[i];
			if (!name || name.length > 60 || containsSecret(name)) { continue; }
			if (/^css-[a-z0-9]+$/i.test(name) || looksHashy(name)) { continue; }
			result.push(name);
		}
		return result;
	}
	function selectorPart(el) {
		var tag = el.tagName.toLowerCase();
		if (el.id && !containsSecret(el.id)) { return tag + '#' + CSS.escape(el.id); }
		var classes = stableClasses(el, 2);
		if (classes.length) { return tag + classes.map(function (name) { return '.' + CSS.escape(name); }).join(''); }
		return tag;
	}
	function isUnique(selector) {
		try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; }
	}
	function nthOfType(el) {
		var index = 1;
		var sibling = el.previousElementSibling;
		while (sibling) {
			if (sibling.tagName === el.tagName) { index++; }
			sibling = sibling.previousElementSibling;
		}
		if (index > 1) { return ':nth-of-type(' + index + ')'; }
		sibling = el.nextElementSibling;
		while (sibling) {
			if (sibling.tagName === el.tagName) { return ':nth-of-type(1)'; }
			sibling = sibling.nextElementSibling;
		}
		return '';
	}
	function buildSelector(el) {
		var parts = [];
		var current = el;
		while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 10) {
			var part = selectorPart(current);
			if (current.parentElement && !isUnique([part].concat(parts).join(' > '))) {
				part += nthOfType(current);
			}
			parts.unshift(part);
			var selector = parts.join(' > ');
			if (isUnique(selector)) { return clamp(selector, SELECTOR_MAX); }
			current = current.parentElement;
		}
		return clamp(parts.join(' > ') || el.tagName.toLowerCase(), SELECTOR_MAX);
	}
	function readablePath(el) {
		var parts = [];
		var current = el;
		while (current && current !== document.documentElement && current !== document.body && parts.length < 6) {
			var tag = current.tagName.toLowerCase();
			var label = tag;
			var aria = current.getAttribute('aria-label');
			var role = current.getAttribute('role');
			var classes = stableClasses(current, 1);
			if (current.id && !containsSecret(current.id)) {
				label = '#' + CSS.escape(current.id);
			} else if (aria && !containsSecret(aria)) {
				label = tag + '[aria-label="' + clamp(aria, 40).split('"').join("'") + '"]';
			} else if (role) {
				label = tag + '[role="' + clamp(role, 30).split('"').join("'") + '"]';
			} else if (classes.length) {
				label = '.' + CSS.escape(classes[0]);
			}
			parts.unshift(label);
			current = current.parentElement;
		}
		return clamp(parts.join(' > '), PATH_MAX);
	}
	function htmlSnippet(el) {
		var clone = el.cloneNode(true);
		var drop = clone.querySelectorAll('script, noscript, template, iframe, object, embed');
		for (var i = 0; i < drop.length; i++) { drop[i].remove(); }
		var nodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*'), 0, 2000));
		for (var j = 0; j < nodes.length; j++) {
			var node = nodes[j];
			var type = (node.getAttribute('type') || '').toLowerCase();
			if (node.hasAttribute('value') && (type === 'password' || type === 'hidden' || containsSecret(node.getAttribute('name') || '') || containsSecret(node.id || ''))) {
				node.setAttribute('value', '[redacted]');
			}
			var attrs = Array.prototype.slice.call(node.attributes);
			for (var k = 0; k < attrs.length; k++) {
				var name = attrs[k].name.toLowerCase();
				if (name.indexOf('on') === 0) {
					node.removeAttribute(attrs[k].name);
				} else if (containsSecret(attrs[k].value)) {
					node.setAttribute(attrs[k].name, '[redacted]');
				}
			}
		}
		return clamp(clone.outerHTML || '', HTML_MAX);
	}
	function safeAttributes(el) {
		var result = {};
		for (var i = 0; i < el.attributes.length && i < 40; i++) {
			var attr = el.attributes[i];
			var name = attr.name.toLowerCase();
			if (!SAFE_ATTRS.has(name) && name.indexOf('aria-') !== 0) { continue; }
			if (containsSecret(attr.value)) {
				result[name] = '[redacted]';
			} else if (name === 'href' || name === 'src' || name === 'action') {
				result[name] = sanitizeUrl(attr.value);
			} else {
				result[name] = clamp(attr.value, 500);
			}
		}
		return result;
	}
	function accessibleName(el) {
		var label = el.getAttribute('aria-label');
		if (label) { return clamp(label, 200); }
		var labelledBy = el.getAttribute('aria-labelledby');
		if (labelledBy) {
			var names = [];
			var ids = labelledBy.split(' ').slice(0, 8);
			for (var i = 0; i < ids.length; i++) {
				var ref = ids[i] ? document.getElementById(ids[i]) : null;
				if (ref) { names.push(boundedText(ref, 100)); }
			}
			if (names.length) { return clamp(names.join(' '), 200); }
		}
		var tag = el.tagName.toLowerCase();
		if (tag === 'button' || tag === 'a' || tag === 'label') { return boundedText(el, 100); }
		return clamp(el.getAttribute('title') || el.getAttribute('alt') || '', 200);
	}
	function computedStyles(el) {
		var style = getComputedStyle(el);
		var result = {};
		for (var i = 0; i < STYLE_PROPS.length; i++) {
			result[STYLE_PROPS[i]] = style.getPropertyValue(STYLE_PROPS[i]) || '';
		}
		return result;
	}
	function nearbyText(el) {
		var result = [];
		var previous = el.previousElementSibling;
		var next = el.nextElementSibling;
		var inspected = 0;
		while (result.length < NEARBY_MAX && inspected < 40 && (previous || next)) {
			if (previous) {
				inspected++;
				var before = boundedText(previous, TEXT_MAX);
				if (before) { result.push(before); }
				previous = previous.previousElementSibling;
			}
			if (next && result.length < NEARBY_MAX) {
				inspected++;
				var after = boundedText(next, TEXT_MAX);
				if (after) { result.push(after); }
				next = next.nextElementSibling;
			}
		}
		return result;
	}
	function extract(el) {
		var rect = el.getBoundingClientRect();
		return {
			url: sanitizeUrl(location.href),
			title: clamp(document.title || '', 300),
			viewportWidth: innerWidth,
			viewportHeight: innerHeight,
			tagName: el.tagName.toLowerCase(),
			selector: buildSelector(el),
			path: readablePath(el),
			textSnippet: boundedText(el, TEXT_MAX),
			htmlSnippet: htmlSnippet(el),
			accessibleName: accessibleName(el),
			attributes: safeAttributes(el),
			styles: computedStyles(el),
			nearbyText: nearbyText(el),
			rectViewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			rectPage: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }
		};
	}
	function style(element, css) {
		element.style.cssText = css;
		return element;
	}

	// ---- 要素の選択 ----
	var pick = null;
	function finishPick(result) {
		var current = pick;
		if (!current) { return; }
		pick = null;
		removeEventListener('keydown', current.onKeyDown, true);
		try { current.host.remove(); } catch (e) { }
		current.resolve(result);
	}
	function startPick() {
		if (pick) { finishPick({ cancelled: true }); }
		return new Promise(function (resolve) {
			var host = style(document.createElement('div'), 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:auto;cursor:crosshair;background:transparent;margin:0;padding:0;border:0;');
			var shadow = host.attachShadow({ mode: 'closed' });
			var box = style(document.createElement('div'), 'position:fixed;display:none;pointer-events:none;border:2px solid ' + ACCENT + ';border-radius:3px;background:rgba(0,95,184,0.08);box-shadow:0 0 0 1px rgba(255,255,255,0.8);');
			var label = style(document.createElement('div'), 'position:fixed;display:none;pointer-events:none;padding:2px 6px;border-radius:4px;background:' + ACCENT + ';color:#fff;font:11px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;');
			shadow.appendChild(box);
			shadow.appendChild(label);
			var target = null;
			function elementAt(x, y) {
				host.style.pointerEvents = 'none';
				var el = document.elementFromPoint(x, y);
				host.style.pointerEvents = 'auto';
				if (!el || el === document.documentElement || el === document.body || el === host) { return null; }
				return el;
			}
			function show(el) {
				target = el;
				if (!el) {
					box.style.display = 'none';
					label.style.display = 'none';
					return;
				}
				var rect = el.getBoundingClientRect();
				box.style.left = rect.x + 'px';
				box.style.top = rect.y + 'px';
				box.style.width = rect.width + 'px';
				box.style.height = rect.height + 'px';
				box.style.display = 'block';
				label.textContent = el.tagName.toLowerCase() + '  ' + Math.round(rect.width) + ' x ' + Math.round(rect.height);
				var top = rect.bottom + 6;
				if (top + 24 > innerHeight) { top = Math.max(2, rect.top - 24); }
				label.style.left = Math.max(2, Math.min(rect.x, innerWidth - 200)) + 'px';
				label.style.top = top + 'px';
				label.style.display = 'block';
			}
			host.addEventListener('mousemove', function (event) {
				if (!event.isTrusted) { return; }
				show(elementAt(event.clientX, event.clientY));
			});
			host.addEventListener('mousedown', function (event) {
				event.preventDefault();
				event.stopPropagation();
			}, true);
			host.addEventListener('click', function (event) {
				event.preventDefault();
				event.stopPropagation();
				if (!event.isTrusted) { return; }
				var el = target || elementAt(event.clientX, event.clientY);
				if (!el) { return; }
				var data;
				try {
					data = extract(el);
				} catch (e) {
					finishPick({ cancelled: true });
					return;
				}
				hidePins();
				finishPick({ element: data });
			}, true);
			host.addEventListener('contextmenu', function (event) {
				event.preventDefault();
				event.stopPropagation();
				if (event.isTrusted) { finishPick({ cancelled: true }); }
			}, true);
			var onKeyDown = function (event) {
				if (event.isTrusted && event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					finishPick({ cancelled: true });
				}
			};
			addEventListener('keydown', onKeyDown, true);
			pick = { host: host, resolve: resolve, onKeyDown: onKeyDown };
			document.documentElement.appendChild(host);
		});
	}

	// ---- 番号札 ----
	var pinState = { host: null, layer: null, pins: [], frame: 0 };
	function ensurePinHost() {
		if (pinState.host && pinState.host.isConnected) { return; }
		var host = style(document.createElement('div'), 'position:fixed;inset:0;width:0;height:0;overflow:visible;z-index:2147483646;pointer-events:none;margin:0;padding:0;border:0;');
		var shadow = host.attachShadow({ mode: 'closed' });
		var layer = style(document.createElement('div'), 'position:fixed;inset:0;pointer-events:none;');
		shadow.appendChild(layer);
		pinState.host = host;
		pinState.layer = layer;
		document.documentElement.appendChild(host);
		addEventListener('scroll', schedulePins, { capture: true, passive: true });
		addEventListener('resize', schedulePins, { passive: true });
	}
	function schedulePins() {
		if (pinState.frame) { return; }
		pinState.frame = requestAnimationFrame(function () {
			pinState.frame = 0;
			layoutPins();
		});
	}
	function layoutPins() {
		for (var i = 0; i < pinState.pins.length; i++) {
			var pin = pinState.pins[i];
			var el = pin.element && pin.element.isConnected ? pin.element : null;
			if (!el && pin.selector) {
				try { el = document.querySelector(pin.selector); } catch (e) { el = null; }
				pin.element = el;
			}
			var x, y;
			if (el) {
				var rect = el.getBoundingClientRect();
				x = rect.x;
				y = rect.y;
			} else {
				x = pin.rect.x - scrollX;
				y = pin.rect.y - scrollY;
			}
			pin.node.style.left = Math.max(2, Math.min(x - 8, innerWidth - 22)) + 'px';
			pin.node.style.top = Math.max(2, Math.min(y - 8, innerHeight - 22)) + 'px';
		}
	}
	function hidePins() {
		if (pinState.host) { pinState.host.style.display = 'none'; }
	}
	function setPins(list) {
		for (var i = 0; i < pinState.pins.length; i++) { pinState.pins[i].node.remove(); }
		pinState.pins = [];
		if (!Array.isArray(list) || list.length === 0) {
			if (pinState.host) { pinState.host.remove(); }
			pinState.host = null;
			removeEventListener('scroll', schedulePins, { capture: true });
			removeEventListener('resize', schedulePins);
			return;
		}
		ensurePinHost();
		pinState.host.style.display = 'block';
		for (var j = 0; j < list.length && j < 40; j++) {
			var item = list[j] || {};
			var node = style(document.createElement('div'), 'position:fixed;width:18px;height:18px;border-radius:50%;background:' + ACCENT + ';color:#fff;font:600 10px/18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,0.35);pointer-events:none;');
			node.textContent = String(item.label || '').slice(0, 3);
			pinState.layer.appendChild(node);
			var rect = item.rectPage || {};
			pinState.pins.push({ node: node, selector: typeof item.selector === 'string' ? item.selector : '', element: null, rect: { x: Number(rect.x) || 0, y: Number(rect.y) || 0 } });
		}
		layoutPins();
	}

	g.__paradisDesign = {
		pick: startPick,
		cancel: function () { finishPick({ cancelled: true }); },
		setPins: setPins
	};
})();`;

/** 要素を1つ選ばせる。結果は `{ element }` か `{ cancelled: true }`（未検証の値）。 */
export function paradisBuildPickScript(): string {
	return `${INSTALL_SCRIPT}\nglobalThis.__paradisDesign.pick();`;
}

/** 選択中なら取り消す。仕掛けが入っていなければ何もしない。 */
export function paradisBuildCancelPickScript(): string {
	return 'globalThis.__paradisDesign ? globalThis.__paradisDesign.cancel() : undefined;';
}

/**
 * 番号札を置き直す。値は JSON としてスクリプトへ埋め込む（JSON はそのまま JS の式として
 * 読めるので、文字列の連結で式を組み立てない）。
 */
export function paradisBuildSetPinsScript(pins: readonly IParadisDesignPin[]): string {
	const payload = pins.map(pin => ({
		label: String(pin.label).slice(0, 3),
		selector: String(pin.selector).slice(0, 700),
		rectPage: { x: Number(pin.rectPage.x) || 0, y: Number(pin.rectPage.y) || 0 },
	}));
	if (payload.length === 0) {
		return 'globalThis.__paradisDesign ? globalThis.__paradisDesign.setPins([]) : undefined;';
	}
	return `${INSTALL_SCRIPT}\nglobalThis.__paradisDesign.setPins(${JSON.stringify(payload)});`;
}
