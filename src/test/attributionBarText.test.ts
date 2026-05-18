import { expect } from 'chai';
import { countAiHumanLineDeltas, formatPostCommitAttributionBar } from '../utils/attributionBarText';

describe('attributionBarText', () => {
    it('counts AI and human blame rows', () => {
        expect(
            countAiHumanLineDeltas({
                a: [{ authorType: 'AI' } as any, { authorType: 'HUMAN' } as any],
            })
        ).to.deep.equal({ ai: 1, human: 1 });
    });

    it('formats a non-empty bar matching width split', () => {
        const s = formatPostCommitAttributionBar(30, 10, 20);
        expect(s).to.include('[blamely]');
        expect(s).to.include('[###############-----]');
        expect(s).to.include('AI 75.0%');
        expect(s).to.include('25.0% Human');
    });

    it('formats empty snapshot message', () => {
        expect(formatPostCommitAttributionBar(0, 0)).to.include(
            'no line-level attribution in this commit snapshot'
        );
    });
});
