// Test-only stub for the `vscode` module, which is only available inside the
// extension host. Unit tests that import modules transitively requiring `vscode`
// (e.g. CliDataService for its pure attribution functions) need the import to
// resolve; the stubbed surface is intentionally minimal. Loaded via the mocha
// `--require` list before the test files.
const Module = require('module');
const origLoad = Module._load;

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({ get: (_key, def) => def }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        textDocuments: [],
    },
    window: {},
    commands: {},
    Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
    env: { appName: 'test' },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    Disposable: class { dispose() {} },
};

Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.apply(this, arguments);
};
