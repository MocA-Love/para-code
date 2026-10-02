// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import type { IParadisMobileBookmarks } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';
import { fetchBrowserBookmarks, onPcMessage } from '../../appState.js';

/**
 * PC の内蔵ブラウザのブックマーク（`browser.bookmarks.v1`）。
 *
 * `active` の間だけ読む。PC は要求を 10 分間の変更の購読として覚え、変わったら fs で
 * `bookmarksChanged` を送ってくるので、届いたら読み直す。購読が切れないよう 5 分ごとにも読み直す。
 * 読めなかったときは直前の一覧を残す（PC を持たない・オフラインでも、最後に見た一覧を出す）。
 */
const REFRESH_MS = 5 * 60_000;

/** 開発ビルド専用: PC とつながっていないシミュレータで見せる一覧（`src/dev/browserDemo.ts`）。 */
let devBookmarks: IParadisMobileBookmarks | undefined;
export function setDevBrowserBookmarks(bookmarks: IParadisMobileBookmarks | undefined): void {
	if (__DEV__) {
		devBookmarks = bookmarks;
	}
}

export function useBrowserBookmarks(pcId: string | undefined, active: boolean, supported: boolean): IParadisMobileBookmarks | undefined {
	const [bookmarks, setBookmarks] = useState<IParadisMobileBookmarks | undefined>(undefined);
	const generation = useRef(0);
	useEffect(() => {
		if (!supported) {
			setBookmarks(undefined);
		}
	}, [supported]);
	useEffect(() => {
		if (!active || !supported) {
			return;
		}
		let disposed = false;
		const load = () => {
			const current = ++generation.current;
			(devBookmarks !== undefined ? Promise.resolve(devBookmarks) : fetchBrowserBookmarks(pcId)).then(result => {
				if (!disposed && generation.current === current) {
					setBookmarks(result);
				}
			}).catch(() => { /* 次の知らせか定期の読み直しで取り直す */ });
		};
		load();
		const subscription = onPcMessage(pcId, 'fs', message => {
			if (message.t === 'bookmarksChanged') {
				load();
			}
		});
		const timer = setInterval(load, REFRESH_MS);
		return () => {
			disposed = true;
			subscription.dispose();
			clearInterval(timer);
		};
	}, [pcId, active, supported]);
	return bookmarks;
}
