// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { PAIRING_URI_SCHEME } from '@para/protocol';

/**
 * ペアリング画面（`/pair`）が受け取る文字列の整え方と、失敗の伝え方。
 * 画面から切り離した純関数なので、テストで固定している（`pairingInput.test.ts`）。
 *
 * ペアリングの処理そのもの（リレーへの接続・確認コードの算出・台帳への保存）は既存の
 * `useAppStore().pairFromUri`（`src/appState.ts` → `src/pairingClient.ts`）が持つ。ここでは書き直さない。
 */

const PAYLOAD_PREFIX = `${PAIRING_URI_SCHEME}?d=`;

/**
 * 貼り付け・読み取った文字列から、ペアリングのリンク（`paracode-mobile://pair?d=…`）を取り出す。
 *
 * PC の画面からコピーすると前後に空白や改行、説明の文章が付いてくることがあるので、
 * リンクの部分だけを抜き出す。リンクの中身（`d=` の後ろ）は base64url なので、そこで使わない
 * 文字（空白・引用符・山かっこなど）が来たところで打ち切る。リンクが見つからなければ undefined。
 */
export function extractPairingUri(text: string): string | undefined {
	const start = text.indexOf(PAYLOAD_PREFIX);
	if (start < 0) {
		return undefined;
	}
	const rest = text.slice(start + PAYLOAD_PREFIX.length);
	const payload = /^[A-Za-z0-9_\-=%]+/.exec(rest)?.[0];
	return payload === undefined ? undefined : `${PAYLOAD_PREFIX}${payload}`;
}

/**
 * ディープリンク（`paracode-mobile://pair?d=…` を OS から開いた）で `/pair` に渡ってきた `d` から、
 * `pairFromUri` に渡すリンクを組み直す。`d` が無い・空なら undefined（通常の読み取り画面を出す）。
 */
export function pairingUriFromLinkParam(param: string | readonly string[] | undefined): string | undefined {
	const value = typeof param === 'string' ? param : param?.[0];
	if (value === undefined || value.trim().length === 0) {
		return undefined;
	}
	return extractPairingUri(`${PAYLOAD_PREFIX}${value.trim()}`);
}

/** 確認コード（6桁）を「123 456」のように3桁ずつ区切る。6桁でなければそのまま返す。 */
export function formatSasCode(code: string): string {
	return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** 中断（画面を離れた・キャンセルを押した）で終わったペアリングか。これは失敗として出さない。 */
export function isPairingCancelled(error: unknown): boolean {
	return error instanceof Error && error.message === 'pairing cancelled';
}

/**
 * ペアリングの失敗を、利用者が次に何をすればよいかが分かる文にする。
 * 失敗の元の文言（英語）は `src/pairingClient.ts` と `@para/protocol` の `decodePairingUri` が出すもの。
 * 知らない失敗は元の文言を括弧で添える（原因を PC 側と突き合わせられるように）。
 */
export function pairingErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	if (raw === 'not a Para Code pairing URI' || raw.startsWith('malformed pairing payload') || raw === 'unsupported pairing payload') {
		return 'Para Code のペアリング用のコードではありません。PC に表示された QR コードかリンクを使ってください。';
	}
	if (raw === 'pairing connection timeout' || raw === 'pairing socket closed') {
		return '中継サーバーにつながりませんでした。通信状態を確かめて、もう一度読み取ってください。';
	}
	if (raw === 'pairing approval timeout') {
		return 'PC で承認されないまま時間切れになりました。PC で QR コードを出し直して、もう一度読み取ってください。';
	}
	if (raw === 'pairing device mismatch') {
		return 'QR コードと違う PC から応答がありました。安全のため中止しました。';
	}
	if (raw === 'not initialized') {
		return 'アプリの準備が終わっていません。少し待ってから、もう一度お試しください。';
	}
	return `ペアリングできませんでした（${raw}）`;
}
