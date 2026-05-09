import { expect } from 'chai';
import { workspacePathFromGitExtensionUriQuery } from '../utils/Platform';

describe('Platform.workspacePathFromGitExtensionUriQuery', () => {
    it('parses path from vscode git URI query JSON', () => {
        const q = JSON.stringify({ path: '/tmp/repo/src/changes/file.json', ref: 'HEAD' });
        expect(workspacePathFromGitExtensionUriQuery(q)).to.equal('/tmp/repo/src/changes/file.json');
    });

    it('returns undefined for invalid JSON', () => {
        expect(workspacePathFromGitExtensionUriQuery('')).to.equal(undefined);
        expect(workspacePathFromGitExtensionUriQuery('not-json')).to.equal(undefined);
    });
});
