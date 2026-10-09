/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word の webview（単独表示と差分）に埋め込むスクリプト。docx-preview の解析結果（AST）の段落に目印を付けて
// 描かせ、描いた後に段落ごとの文字を報告し、ホストから届いた位置へ移る・要素に点線を付ける・押された要素の
// 情報を吹き出しに出す・コメントを余白に出す。
//
// docx-preview は AST の `cssStyle` のうち `$` で始まる鍵を属性として書き出すので、ライブラリを書き換えずに
// 目印を付けられる。ここは webview の中でそのまま実行する文字列にしておく（ビルドの変換が補助関数を差し込むと
// webview の中では動かないため）。文字列の中では逆斜線とテンプレートリテラルを使わない。
//
// 文書から来た文字は textContent でだけ書き込み、HTML として解釈しない。

/** 段落の目印の属性名（値は `${文書パーツの鍵}#${番号}`）。 */
export const PARADIS_WORD_PARAGRAPH_ATTRIBUTE = 'data-paradis-p';

/** webview に `window.paradisWordAnchors` を定義するスクリプト。 */
export const PARADIS_WORD_ANCHOR_RUNTIME = `(function () {
	var P = 'data-paradis-p';
	var SKIP = 'data-paradis-skip';
	var marks = [];
	var popover;
	var labels = { title: '', close: '' };

	function isSpace(ch) { return ch.trim() === ''; }
	function setAttribute(node, name, value) {
		if (!node.cssStyle) { node.cssStyle = {}; }
		node.cssStyle['$' + name] = value;
	}
	function hasParagraph(node) {
		var children = node && node.children;
		if (!children) { return false; }
		for (var i = 0; i < children.length; i++) {
			if (children[i].type === 'paragraph' || hasParagraph(children[i])) { return true; }
		}
		return false;
	}

	// AST の段落に、文書パーツごとの通し番号の目印を付ける。テキストボックス（VML・図形の中の段落）は、
	// 段落の直接の親ごとに別の文書パーツとして数える（意味モデルのテキストボックスの数え方と同じ）。
	function stamp(doc) {
		var counters = {};
		var textboxCounts = {};
		var textboxKeys = new Map();
		function next(key) { var n = counters[key] || 0; counters[key] = n + 1; return key + '#' + n; }
		function walkPart(root, key, path) {
			function walk(node, storyKey, inGraphic) {
				if (!node) { return; }
				var type = node.type;
				var graphic = inGraphic || type === 'vmlPicture' || type === 'vmlElement' || type === 'drawing';
				if (type === 'run' && node.children) {
					for (var r = 0; r < node.children.length; r++) {
						var childType = node.children[r].type;
						if (childType === 'footnoteReference' || childType === 'endnoteReference') { setAttribute(node, SKIP, '1'); }
					}
				}
				var children = node.children || [];
				for (var i = 0; i < children.length; i++) {
					var child = children[i];
					var childKey = storyKey;
					if (child.type === 'paragraph') {
						if (graphic) {
							if (!textboxKeys.has(node)) {
								var count = textboxCounts[path] || 0;
								textboxCounts[path] = count + 1;
								textboxKeys.set(node, 't:' + path + ':' + count);
							}
							childKey = textboxKeys.get(node);
						}
						setAttribute(child, P, next(childKey));
					}
					walk(child, childKey, graphic);
				}
			}
			walk(root, key, false);
		}
		if (doc.documentPart && doc.documentPart.body) { walkPart(doc.documentPart.body, 'b', doc.documentPart.path); }
		var parts = doc.parts || [];
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (part.rootElement && (part.rootElement.type === 'header' || part.rootElement.type === 'footer')) {
				walkPart(part.rootElement, 'p:' + part.path, part.path);
			}
		}
		var noteParts = [[doc.footnotesPart, 'fn:'], [doc.endnotesPart, 'en:']];
		for (var n = 0; n < noteParts.length; n++) {
			var notesPart = noteParts[n][0];
			if (!notesPart || !notesPart.notes) { continue; }
			for (var k = 0; k < notesPart.notes.length; k++) {
				var note = notesPart.notes[k];
				walkPart(note, noteParts[n][1] + note.id, notesPart.path);
			}
		}
	}

	// 段落の要素のうち、その段落自身の文字（入れ子の段落・脚注番号・削除された文字を除く）の
	// テキストノードを、空白を除いた 1 文字ずつの位置と一緒に並べる。
	function textIndex(elements, visibleOnly) {
		var nodes = [];
		var offsets = [];
		var flat = '';
		for (var e = 0; e < elements.length; e++) {
			var owner = elements[e];
			var walker = owner.ownerDocument.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
			for (var node = walker.nextNode(); node; node = walker.nextNode()) {
				var parent = node.parentElement;
				if (!parent || parent.closest('[' + P + ']') !== owner || parent.closest('[' + SKIP + ']') || parent.closest('del')) { continue; }
				if (visibleOnly && parent.getClientRects().length === 0) { continue; }
				var data = node.data;
				for (var i = 0; i < data.length; i++) {
					if (isSpace(data[i])) { continue; }
					flat += data[i];
					nodes.push(node);
					offsets.push(i);
				}
			}
		}
		return { flat: flat, nodes: nodes, offsets: offsets };
	}

	// 目印ごとの要素。ページの区切りで 2 つに分かれた段落は両方、ヘッダー・フッターの複製は最初の 1 つだけ。
	function groups(root) {
		var result = new Map();
		var all = root.querySelectorAll('[' + P + ']');
		for (var i = 0; i < all.length; i++) {
			var marker = all[i].getAttribute(P);
			var list = result.get(marker);
			if (list && all[i].closest('header,footer')) { continue; }
			if (!list) { list = []; result.set(marker, list); }
			list.push(all[i]);
		}
		return result;
	}

	// 見えている文字の索引。描き直すまで使い回す（描いた後の collect で捨てる）。
	var visibleIndexes = new Map();
	function visibleIndex(key, elements) {
		var index = visibleIndexes.get(key);
		if (!index) { index = textIndex(elements, true); visibleIndexes.set(key, index); }
		return index;
	}

	function collect(root) {
		visibleIndexes = new Map();
		var stories = {};
		groups(root).forEach(function (elements, marker) {
			var hash = marker.lastIndexOf('#');
			var key = marker.slice(0, hash);
			var index = Number(marker.slice(hash + 1));
			var list = stories[key] || (stories[key] = []);
			while (list.length < index) { list.push(''); }
			list[index] = textIndex(elements).flat;
		});
		return stories;
	}

	function rangeOf(index, start, end) {
		if (start < 0 || end <= start || end > index.nodes.length) { return undefined; }
		var range = document.createRange();
		range.setStart(index.nodes[start], index.offsets[start]);
		range.setEnd(index.nodes[end - 1], index.offsets[end - 1] + 1);
		return range;
	}

	function compact(value, matchCase) {
		var out = '';
		var text = String(value || '');
		for (var i = 0; i < text.length; i++) {
			if (isSpace(text[i])) { continue; }
			var folded = matchCase ? text[i] : text[i].toLowerCase();
			out += folded.length === 1 ? folded : text[i];
		}
		return out;
	}

	function show(range, element) {
		if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
			CSS.highlights.set('paradis-word-reveal', range ? new Highlight(range) : new Highlight());
		}
		var target = element || (range && range.startContainer.parentElement);
		if (target) { target.scrollIntoView({ block: 'center', inline: 'nearest' }); }
	}

	function showMessage(text) {
		if (!text) { return; }
		var toast = document.getElementById('paradis-word-reveal-message');
		if (!toast) {
			toast = document.createElement('div');
			toast.id = 'paradis-word-reveal-message';
			toast.setAttribute('role', 'status');
			document.body.appendChild(toast);
		}
		toast.textContent = text;
		toast.style.display = '';
		clearTimeout(toast.paradisTimer);
		toast.paradisTimer = setTimeout(function () { toast.style.display = 'none'; }, 2500);
	}

	// 見えている文字（隠れた削除・挿入を除く）の中で、文脈つきの文字を探して示す。目印の段落があればその中だけを探す。
	// 焦点の文字だけで文書全体を探すと別の場所の同じ文字へ飛ぶので、文脈が見つからなければ移らずにそう伝える
	// （目印の段落が分かっているときは、その段落を示す）。
	function reveal(root, message) {
		var matchCase = message.matchCase !== false;
		var elements = message.marker ? groups(root).get(message.marker) : undefined;
		var scoped = !!(elements && elements.length);
		var index = scoped ? visibleIndex('m:' + message.marker, elements) : visibleIndex('root', [root]);
		var flat = matchCase ? index.flat : compact(index.flat, false);
		var context = compact(message.context, matchCase);
		var focus = compact(message.focus, matchCase);
		var start = -1;
		var end = -1;
		var contextAt = context ? flat.indexOf(context) : -1;
		if (contextAt >= 0) {
			var prefix = typeof message.prefix === 'string' ? compact(message.prefix, matchCase).length : -1;
			var inner = prefix >= 0 && context.startsWith(focus, prefix) ? prefix : context.indexOf(focus);
			start = contextAt + (inner >= 0 ? inner : 0);
			end = inner >= 0 && focus ? start + focus.length : contextAt + context.length;
		} else if (scoped && focus) {
			start = flat.indexOf(focus);
			end = start >= 0 ? start + focus.length : -1;
		}
		var range = rangeOf(index, start, end);
		if (range) { show(range); return true; }
		if (scoped && elements[0].getClientRects().length > 0) { show(undefined, elements[0]); return true; }
		showMessage(message.notFound);
		return false;
	}

	function closePopover() {
		if (popover) { popover.remove(); popover = undefined; }
	}

	function openPopover(rows, x, y) {
		closePopover();
		popover = document.createElement('div');
		popover.className = 'paradis-word-popover';
		popover.setAttribute('role', 'dialog');
		popover.setAttribute('aria-label', labels.title);
		var close = document.createElement('button');
		close.type = 'button';
		close.className = 'paradis-word-popover-close';
		close.textContent = 'x';
		close.setAttribute('aria-label', labels.close);
		close.addEventListener('click', closePopover);
		popover.appendChild(close);
		var title = document.createElement('strong');
		title.textContent = labels.title;
		popover.appendChild(title);
		var grid = document.createElement('div');
		grid.className = 'paradis-word-popover-rows';
		for (var i = 0; i < rows.length; i++) {
			var key = document.createElement('div');
			key.textContent = String(rows[i][0]);
			var value = document.createElement('div');
			value.textContent = String(rows[i][1]);
			grid.appendChild(key);
			grid.appendChild(value);
		}
		popover.appendChild(grid);
		document.body.appendChild(popover);
		var width = popover.offsetWidth;
		var height = popover.offsetHeight;
		popover.style.left = Math.max(4, Math.min(x + 8, window.innerWidth - width - 4)) + 'px';
		popover.style.top = Math.max(4, Math.min(y + 12, window.innerHeight - height - 4)) + 'px';
		close.focus();
	}

	function elementOrdinal(elements, selector, ordinal) {
		var count = 0;
		for (var e = 0; e < elements.length; e++) {
			var found = elements[e].querySelectorAll(selector);
			for (var i = 0; i < found.length; i++) {
				if (found[i].closest('[' + P + ']') !== elements[e]) { continue; }
				if (count++ === ordinal) { return found[i]; }
			}
		}
		return undefined;
	}

	// 段落の中の要素に点線を付け、押されたときに吹き出しを出せるように覚えておく。
	function setMarks(root, entries, newLabels, mode) {
		labels = newLabels || labels;
		marks = [];
		var ranges = [];
		var byMarker = groups(root);
		for (var i = 0; i < entries.length; i++) {
			var elements = byMarker.get(entries[i].marker);
			if (!elements || !elements.length) { continue; }
			var index = textIndex(elements);
			for (var m = 0; m < entries[i].marks.length; m++) {
				var mark = entries[i].marks[m];
				// var は繰り返しの中でも前の値を持ち越すので、毎回空にする。
				var element = undefined;
				if (mark.kind === 'image') { element = elementOrdinal(elements, 'img,svg', mark.ordinal); }
				else if (mark.kind === 'noteReference') { element = elementOrdinal(elements, '[' + SKIP + ']', mark.ordinal); }
				else if (mark.kind === 'revision' && mode !== 'final' && typeof mark.ordinal === 'number') {
					element = elementOrdinal(elements, mark.start === mark.end ? 'del' : 'ins', mark.ordinal);
				}
				var range;
				if (element) {
					range = document.createRange();
					range.selectNodeContents(element);
				} else {
					range = rangeOf(index, mark.start, mark.end);
				}
				if (!range) { continue; }
				ranges.push(range);
				marks.push({ range: range, element: element, rows: mark.rows, size: element ? 0 : mark.end - mark.start });
			}
		}
		if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
			CSS.highlights.set('paradis-word-node', new Highlight(...ranges));
		}
	}

	function hit(target, x, y) {
		var best;
		var caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
		// 押した位置の文字（caret）で探す。図形などが重なっていて caret が別の要素を指すときは、
		// 押した要素の文字がまるごと印の範囲に入っているかで探す。
		var targetText = target && target.textContent ? target.textContent.trim() : '';
		for (var pass = 0; pass < 2 && !best; pass++) {
			for (var i = 0; i < marks.length; i++) {
				var mark = marks[i];
				var inside;
				if (mark.element) {
					inside = mark.element === target || mark.element.contains(target);
				} else if (pass === 0) {
					inside = !!caret && mark.range.isPointInRange(caret.startContainer, caret.startOffset) && mark.range.intersectsNode(target);
				} else {
					inside = !!targetText && mark.range.intersectsNode(target) && mark.range.toString().indexOf(targetText) >= 0;
				}
				if (inside && (!best || mark.size < best.size)) { best = mark; }
			}
		}
		return best;
	}

	function onClick(event) {
		if (popover && popover.contains(event.target)) { return; }
		var mark = hit(event.target, event.clientX, event.clientY);
		if (mark) { openPopover(mark.rows, event.clientX, event.clientY); } else { closePopover(); }
	}

	// コメントを、付いた段落の横（ページの右の余白の外）に出す。重ならないよう下へずらす。
	// ページ（section）は docx-preview が overflow:hidden にしているので、中ではなく、ページを並べている
	// 入れ物（overflow は visible）に置く。位置は描き終わった後の配置（getBoundingClientRect）から求め、
	// 次の描画の前と、ウィンドウの大きさが変わったときに置き直す（描いた直後は幅が定まっていないことがある）。
	var commentState;
	function placeComments() {
		if (!commentState) { return; }
		var root = commentState.root;
		var old = root.querySelectorAll('.paradis-word-comment-note');
		for (var o = 0; o < old.length; o++) { old[o].remove(); }
		var byMarker = groups(root);
		var bottoms = new Map();
		var placed = 0;
		for (var i = 0; i < commentState.entries.length; i++) {
			var entry = commentState.entries[i];
			var elements = byMarker.get(entry.marker);
			var anchor = elements && elements[0];
			var section = anchor && anchor.closest('section');
			var container = section && section.parentElement;
			if (!container) { continue; }
			if (!container.style.position) { container.style.position = 'relative'; }
			var containerRect = container.getBoundingClientRect();
			var scale = container.offsetWidth > 0 ? containerRect.width / container.offsetWidth : 1;
			var sectionRect = section.getBoundingClientRect();
			var anchorRect = anchor.getBoundingClientRect();
			var top = Math.max((anchorRect.top - containerRect.top) / scale, bottoms.get(container) || 0);
			var note = document.createElement('div');
			note.className = 'paradis-word-comment-note';
			note.setAttribute('role', 'note');
			var author = document.createElement('strong');
			author.textContent = entry.author || '';
			note.appendChild(author);
			if (entry.date) {
				var date = document.createElement('span');
				date.textContent = ' ' + entry.date;
				note.appendChild(date);
			}
			var text = document.createElement('div');
			text.textContent = entry.text || '';
			note.appendChild(text);
			note.style.top = top + 'px';
			note.style.left = ((sectionRect.right - containerRect.left) / scale + 12) + 'px';
			container.appendChild(note);
			bottoms.set(container, top + note.offsetHeight + 4);
			placed++;
		}
		commentState.contentEl.classList.toggle('paradis-word-has-comments', placed > 0);
	}
	function setComments(root, contentEl, entries) {
		commentState = { root: root, contentEl: contentEl, entries: entries };
		contentEl.classList.toggle('paradis-word-has-comments', entries.length > 0);
		placeComments();
		requestAnimationFrame(placeComments);
	}
	window.addEventListener('resize', function () { requestAnimationFrame(placeComments); });

	document.addEventListener('click', onClick);
	document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closePopover(); } });
	window.paradisWordAnchors = { stamp: stamp, collect: collect, reveal: reveal, setMarks: setMarks, setComments: setComments, closePopover: closePopover };
})();`;

/** 吹き出し・点線・コメントの見た目（webview の <style> に足す）。 */
export const PARADIS_WORD_ANCHOR_STYLE = `
	::highlight(paradis-word-reveal) { background-color: #ffd33d; color: #000000; }
	::highlight(paradis-word-node) { text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: #0969da; text-decoration-thickness: 1px; }
	.paradis-word-popover { position: fixed; z-index: 1000; max-width: 360px; padding: 8px 28px 8px 10px; background: #ffffff; color: #1f2328; border: 1px solid #d0d7de; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.18); font: 12px/1.5 var(--vscode-font-family, sans-serif); }
	.paradis-word-popover-close { position: absolute; top: 4px; right: 4px; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328; border-radius: 4px; cursor: pointer; }
	.paradis-word-popover-rows { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin-top: 4px; word-break: break-all; }
	.paradis-word-popover-rows > div:nth-child(odd) { color: #656d76; }
	.paradis-word-has-comments { padding-right: 248px !important; }
	#paradis-word-reveal-message { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 1000; padding: 4px 10px; background: #f6f8fa; color: #1f2328; border: 1px solid #d0d7de; border-radius: 4px; font: 12px var(--vscode-font-family, sans-serif); }
	.paradis-word-comment-note { position: absolute; width: 220px; padding: 6px 8px; background: #fff8c5; color: #1f2328; border: 1px solid #d4a72c; border-radius: 4px; font: 11px/1.45 var(--vscode-font-family, sans-serif); white-space: pre-wrap; word-break: break-word; }
`;
