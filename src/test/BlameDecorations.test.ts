import { strict as assert } from 'assert';
import { blameGutterTooltipText, formatBlameChangedDate } from '../ui/BlameDecorationsTooltip';
import { LineBlame } from '../blame/BlameMap';

describe('BlameDecorations', () => {
    it('formatBlameChangedDate returns Unknown when blank', () => {
        assert.equal(formatBlameChangedDate(''), 'Unknown');
        assert.equal(formatBlameChangedDate('   '), 'Unknown');
    });

    it('formatBlameChangedDate falls back to raw when not ISO instant', () => {
        assert.equal(formatBlameChangedDate('not-a-date'), 'not-a-date');
    });

    it('formatBlameChangedDate formats ISO instant', () => {
        const formatted = formatBlameChangedDate('2026-05-01T12:30:00Z');
        assert.ok(formatted.length > 0);
        assert.ok(formatted.includes('2026'));
    });

    it('blameGutterTooltipText human shows Author and Changed', () => {
        const entry: LineBlame = {
            lineNumber: 1,
            authorType: 'HUMAN',
            timestamp: '2026-05-01T12:00:00Z',
            aiChars: 0,
            humanChars: 5,
            changeType: 'ADD',
            codingType: 'TYPING',
        };
        const text = blameGutterTooltipText(entry);
        assert.ok(text.includes('Author: Human'), text);
        assert.ok(text.includes('Change Date:'), text);
    });

    it('blameGutterTooltipText ai shows Author and Model', () => {
        const entry: LineBlame = {
            lineNumber: 2,
            authorType: 'AI',
            provider: 'copilot',
            timestamp: '2026-05-01T15:00:00Z',
            model: 'gpt-4',
            interactionType: 'completion',
            aiChars: 10,
            humanChars: 0,
            changeType: 'ADD',
            codingType: 'TYPING',
        };
        const text = blameGutterTooltipText(entry);
        assert.ok(text.includes('Author: AI'), text);
        assert.ok(text.includes('Change Date:'), text);
        assert.ok(text.includes('Tool: Copilot'), text);
        assert.ok(text.includes('Model: gpt-4'), text);
        assert.ok(!text.includes('Interaction:'), text);
    });

    it('blameGutterTooltipText omits Change Date when timestamp is blank', () => {
        const entry: LineBlame = {
            lineNumber: 3,
            authorType: 'AI',
            provider: 'copilot',
            timestamp: '',
            aiChars: 10,
            humanChars: 0,
            changeType: 'ADD',
            codingType: 'TYPING',
        };
        const text = blameGutterTooltipText(entry);
        assert.ok(text.includes('Author: AI'), text);
        assert.ok(!text.includes('Change Date'), text);
        assert.ok(!text.includes('Unknown'), text);
    });
});
