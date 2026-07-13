// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { glassComposerTextInputBehavior } from './glassComposerBehavior.js';

describe('glassComposerTextInputBehavior', () => {
	it('keeps Enter as a newline for monospace terminal input', () => {
		expect(glassComposerTextInputBehavior()).toEqual({ multiline: true, blurOnSubmit: false });
	});
});
