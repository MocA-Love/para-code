// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { LiveInputResync } from './liveInputResync.js';

describe('LiveInputResync', () => {
	it('切断中に捨てた打鍵があれば、つながり直したときに一度だけ入力欄を作り直す（送り直さない）', () => {
		const events: string[] = [];
		const resync = new LiveInputResync(() => events.push('rebuild'));
		resync.setReady(true);
		resync.settle(true);
		events.push('online-accepted');
		resync.setReady(false);
		resync.settle(false);
		resync.settle(false);
		events.push('offline-dropped');
		resync.setReady(true);
		events.push('reconnected');
		resync.setReady(true);
		// つながっている間に届かなかった（再接続の直後で PC がまだ受け付けない等）ときは、すぐ作り直す
		resync.settle(false);
		expect(events).toEqual(['online-accepted', 'offline-dropped', 'rebuild', 'reconnected', 'rebuild']);
	});
});
