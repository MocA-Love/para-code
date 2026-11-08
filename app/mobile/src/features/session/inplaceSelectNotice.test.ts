// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { hideInplaceSelectNotice, showInplaceSelectNotice, useInplaceSelectNotice } from './inplaceSelectNotice.js';

describe('inplaceSelectNotice', () => {
	it('uses the band only while a chat screen hosts it, and hides only its own notice', () => {
		const done = () => undefined;
		useInplaceSelectNotice.setState({ notice: undefined, hosts: 0 });
		const withoutHost = showInplaceSelectNotice({ key: 'a', speaker: 'エージェントの発言', done });
		useInplaceSelectNotice.setState({ hosts: 1 });
		const withHost = showInplaceSelectNotice({ key: 'b', speaker: 'エージェントの発言', done });
		hideInplaceSelectNotice('a');
		const kept = useInplaceSelectNotice.getState().notice?.key;
		hideInplaceSelectNotice('b');
		expect([withoutHost, withHost, kept, useInplaceSelectNotice.getState().notice]).toEqual([false, true, 'b', undefined]);
	});
});
