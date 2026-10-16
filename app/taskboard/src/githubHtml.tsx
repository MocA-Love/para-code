// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import { withAssetKey } from './api.js';

/*
 * GitHub が描画した本文（bodyHTML）を表示する。
 * - DOMPurify で無害化する（スクリプト・イベント・style・iframe・フォームは落とす）
 * - 画像は GitHub の置き場のものだけをサーバーの中継（/api/image）に通す。非公開リポジトリの画像は
 *   ブラウザから直接読めないため。そのほかの外部の画像は読まない
 * - リンクは新しいタブで開く
 */

const GITHUB_IMAGE_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'private-user-images.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'objects.githubusercontent.com']);

/** 画像の URL を、表示に使う URL へ置き換える。GitHub の置き場でなければ undefined（読まない）。 */
export function imageProxyUrl(src: string): string | undefined {
	try {
		const url = new URL(src, 'https://github.com');
		if (url.protocol !== 'https:') {
			return undefined;
		}
		if (url.hostname === 'avatars.githubusercontent.com') {
			return url.toString();
		}
		return GITHUB_IMAGE_HOSTS.has(url.hostname) ? withAssetKey(`/api/image?url=${encodeURIComponent(url.toString())}`) : undefined;
	} catch {
		return undefined;
	}
}

let hooked = false;
function installHooks(): void {
	if (hooked) {
		return;
	}
	hooked = true;
	DOMPurify.addHook('afterSanitizeAttributes', node => {
		const el = node as Element;
		if (el.tagName === 'A') {
			const href = el.getAttribute('href') ?? '';
			if (href.startsWith('#')) {
				el.removeAttribute('href'); // 見出しへの飛び先はこの画面には無い
			} else {
				el.setAttribute('target', '_blank');
				el.setAttribute('rel', 'noreferrer noopener');
			}
		} else if (el.tagName === 'IMG') {
			// GitHub が自分の置き場（camo など）へ書き換えた src を優先し、だめなら元の URL を見る
			const src = el.getAttribute('src') ?? '';
			const proxied = imageProxyUrl(src) ?? imageProxyUrl(el.getAttribute('data-canonical-src') ?? '');
			if (proxied) {
				el.setAttribute('src', proxied);
				el.setAttribute('loading', 'lazy');
				el.setAttribute('referrerpolicy', 'no-referrer');
			} else {
				// 走査の途中で要素を差し替えると DOMPurify の巡回が崩れるので、印を付けて後で置き換える
				el.setAttribute('src', '');
				el.setAttribute('class', 'md-img-blocked');
				el.setAttribute('title', src);
			}
			el.removeAttribute('srcset');
		} else if (el.tagName === 'INPUT') {
			el.setAttribute('disabled', '');
		}
	});
}

export function sanitizeGitHubHtml(html: string): string {
	installHooks();
	const fragment = DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'object', 'embed'],
		FORBID_ATTR: ['style', 'id', 'name'],
		ADD_ATTR: ['target', 'data-canonical-src'],
		ALLOW_DATA_ATTR: false,
		RETURN_DOM_FRAGMENT: true,
	});
	for (const img of fragment.querySelectorAll('img.md-img-blocked')) {
		const span = document.createElement('span');
		span.className = 'md-img-fallback';
		span.textContent = `画像: ${img.getAttribute('alt') || img.getAttribute('title') || ''}`;
		img.replaceWith(span);
	}
	const holder = document.createElement('div');
	holder.append(fragment);
	return holder.innerHTML;
}

export function GitHubHtml({ html, className }: { html: string; className?: string }) {
	const clean = useMemo(() => sanitizeGitHubHtml(html), [html]);
	if (!clean.trim()) {
		return <p className="md-empty">説明はありません。</p>;
	}
	// 無害化済みの HTML だけを入れる
	return <div className={`md gh-html ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: clean }} />;
}
