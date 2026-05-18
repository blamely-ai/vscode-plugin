import { expect } from 'chai';
import {
    blameKeyFromSnapshotSidecarPath,
    normalizeBlamePersistenceKey,
} from '../utils/Platform';

describe('snapshot sidecar blame keys', () => {
    it('maps snapshots/branch/file.blame.json to source key', () => {
        expect(blameKeyFromSnapshotSidecarPath('snapshots/master/kerim1.py.blame.json')).to.equal('kerim1.py');
    });

    it('maps logs/commits/sha/snapshots/file.blame.json to source key', () => {
        expect(
            blameKeyFromSnapshotSidecarPath('logs/commits/deadbeefdeadbeef/snapshots/kerim1.py.blame.json')
        ).to.equal('kerim1.py');
    });

    it('decodes encoded stem under snapshots', () => {
        expect(blameKeyFromSnapshotSidecarPath('snapshots/main/src__foo__bar.py.blame.json')).to.equal('src/foo/bar.py');
    });

    it('returns null for normal source paths', () => {
        expect(blameKeyFromSnapshotSidecarPath('src/foo.ts')).to.equal(null);
    });

    it('normalizeBlamePersistenceKey strips double .blame.json mistake', () => {
        const home =
            '/Users/x/.blamely/repos/blamely-ci-test/snapshots/master/__Users__x__.blamely__repos__blamely-ci-test__snapshots__master__kerim1.py.blame.json.blame.json';
        expect(normalizeBlamePersistenceKey(home)).to.equal('kerim1.py');
    });

    it('normalizeBlamePersistenceKey maps snapshot sidecar absolute path', () => {
        const abs = '/Users/x/.blamely/repos/repo/snapshots/master/kerim1.py.blame.json';
        expect(normalizeBlamePersistenceKey(abs)).to.equal('kerim1.py');
    });
});
