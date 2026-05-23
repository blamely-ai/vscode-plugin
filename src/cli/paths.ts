import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Matches oobeya-cli config.BlamelyDir / BLAMELY_HOME overrides. */
export function blamelyHome(): string {
    const homeOverride = process.env.BLAMELY_HOME?.trim();
    if (homeOverride) {
        return path.normalize(homeOverride);
    }
    const dataHome = process.env.BLAMELY_DATA_HOME?.trim();
    if (dataHome) {
        return path.normalize(dataHome);
    }
    return path.join(os.homedir(), '.blamely');
}

export function dbPath(): string {
    return path.join(blamelyHome(), 'db.sqlite');
}

export function daemonPortPath(): string {
    return path.join(blamelyHome(), 'daemon.port');
}

export function statePath(): string {
    return path.join(blamelyHome(), 'state.json');
}

export function installedBinaryPath(): string {
    const name = process.platform === 'win32' ? 'blamely.exe' : 'blamely';
    return path.join(blamelyHome(), 'bin', name);
}

export function gitHooksDir(): string {
    return path.join(blamelyHome(), 'git-hooks');
}

export function daemonLogPath(): string {
    return path.join(blamelyHome(), 'daemon.log');
}

export function readDaemonPort(): number | null {
    try {
        const raw = fs.readFileSync(daemonPortPath(), 'utf8').trim();
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
        return null;
    }
}
