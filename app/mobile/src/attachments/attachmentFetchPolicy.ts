// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 添付画像の取り寄せの判断（純関数）。失敗の見分けと、transcript の画像のブロックとの照合。
 */

export type AttachmentFailureKind = 'missing' | 'old-pc' | 'offline' | 'not-here' | 'no-thumbnail' | 'other';

/** 利用者向けの文。 */
export const ATTACHMENT_FAILURE_MESSAGES: Readonly<Record<AttachmentFailureKind, string>> = {
	'missing': 'PC に画像が残っていません',
	'old-pc': 'PC の Para Code を更新すると表示できます',
	'offline': 'PC につながると表示できます',
	'not-here': 'この PC 画面では見つかりません',
	'no-thumbnail': 'プレビューを作れない画像です',
	'other': '画像を読み込めませんでした',
};

/**
 * PC への要求の失敗を見分ける。
 * - `code` があればそれに従う（`missing`・`no-thumbnail`。その他の code は other）
 * - `code` の無い失敗は、つながっていない（store が `PcUnreachableError` で返したもの。切断・再接続待ち・時間切れ）
 *   なら offline、それ以外（スペースが見つからない・古い形の失敗）は not-here
 */
export function classifyAttachmentFailure(code: string | undefined, unreachable: boolean): AttachmentFailureKind {
	if (code === 'missing') {
		return 'missing';
	}
	if (code === 'no-thumbnail') {
		return 'no-thumbnail';
	}
	if (code !== undefined) {
		return 'other';
	}
	return unreachable ? 'offline' : 'not-here';
}

/**
 * スペースを付けて頼んだ失敗のうち、スペースを付けずにもう 1 回頼むもの（別の PC 画面の置き場にあるかもしれない）。
 * スペースを付けていなかったら頼み直さない。
 */
export function shouldRetryWithoutWorkspace(kind: AttachmentFailureKind, hadWorkspace: boolean): boolean {
	return hadWorkspace && (kind === 'missing' || kind === 'not-here');
}

/**
 * 最後の失敗の種類。スペースを決められずに頼んで置き場に無かったときは、別の画面にある見込みがあるので not-here。
 */
export function finalAttachmentFailure(kind: AttachmentFailureKind, hadWorkspace: boolean): AttachmentFailureKind {
	return kind === 'missing' && !hadWorkspace ? 'not-here' : kind;
}

/** transcript の画像のブロックの大きさは「おおよそ」（base64 の長さからの換算）なので、この差までは同じとみなす。 */
const SIZE_TOLERANCE = 2;

/**
 * 下の画像のカード（transcript の画像のブロック）を隠すか。添付の札と枚数が同じなら、同じ画像を 2 度出さないよう隠す
 * （中身を札に当てるかは {@link attachmentImagesMatch} で別に決める）。
 */
export function attachmentImagesDuplicate(attachmentCount: number, imageCount: number): boolean {
	return attachmentCount > 0 && attachmentCount === imageCount;
}

/**
 * transcript の画像のブロックを、並び順で札の中身に当ててよいか。枚数が同じで、添付の原寸の大きさが
 * すべて分かっていて、1 枚ずつ大きさが一致するときだけ（分からない・違うときは当てない。取り違えた画像を出さない）。
 */
export function attachmentImagesMatch(sizes: readonly (number | undefined)[], images: readonly { readonly bytes: number }[]): boolean {
	return sizes.length > 0 && sizes.length === images.length
		&& sizes.every((size, index) => size !== undefined && Math.abs(size - (images[index]?.bytes ?? -Infinity)) <= SIZE_TOLERANCE);
}

/** base64 の中身のバイト数。 */
export function base64ByteLength(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.floor(base64.length * 3 / 4) - padding;
}
