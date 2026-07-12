/** oobeya-cli git note JSON schema (refs/notes/blamely). */
export interface CliNote {
    schema: number;
    commit: string;
    /** Branch the commit was on (recorded by the CLI note; shown in History). */
    branch?: string;
    generated_by?: string;
    /** Full commit message (subject + body), when the note records it. */
    message?: string;
    /** Wall-clock coding time from the earliest observed edit to the commit. */
    coding_time_nanos?: number;
    totals: {
        added_lines?: number;
        ai_added_lines?: number;
        human_added_lines?: number;
        deleted_lines: number;
        ai_deleted_lines?: number;
        human_deleted_lines?: number;
        /** legacy (pre-1.x notes): superseded by ai_added_lines / human_added_lines */
        ai_lines?: number;
        human_lines?: number;
        files: number;
        tokens?: {
            input: number;
            output: number;
            cache_read: number;
            cache_write: number;
        };
        models?: Record<string, number>;
    };
    by_tool?: Record<string, {
        lines: number;
        suggested_lines?: number;
        accepted_lines?: number;
        model?: string;
        tokens?: {
            input: number;
            output: number;
            cache_read: number;
            cache_write: number;
        };
    }>;
    by_gen_type?: {
        chat: number;
        cli: number;
        completion: number;
        unknown?: number;
    };
    files?: CliNoteFile[];
}

export interface CliNoteFile {
    path: string;
    type?: string;
    renamed_from?: string;
    copied_from?: string;
    added_lines?: number;
    deleted_lines?: number;
    /** Per-file AI/Human split of added_lines/deleted_lines (same keys as totals); omitted when 0. */
    ai_added_lines?: number;
    human_added_lines?: number;
    ai_deleted_lines?: number;
    human_deleted_lines?: number;
    /** legacy (pre-1.x notes): superseded by added_lines / deleted_lines */
    added?: number;
    deleted?: number;
    lines: CliNoteLine[];
}

export interface CliNoteLine {
    line: number;
    type: 'add' | 'delete';
    author_type?: 'AI' | 'Human' | '';
    tool?: string;
    model?: string | null;
    gen_type?: string | null;
    edit_id?: number | null;
}

export interface CliEditRow {
    id: number;
    ts: number;
    file_path: string;
    tool: string;
    model: string | null;
    gen_type: string;
    start_line: number;
    end_line: number;
    // Per-line content hash when the edit recorded line content (chat applies).
    // Used to attribute a line to AI only when its current content still
    // matches what the AI applied. Empty/null for range-only edits.
    content_sha: string | null;
    // Hash of the whitespace-normalized line text (trim + collapse internal
    // whitespace). Fallback match when an autoformatter reflows an
    // AI-written line (reindent, trailing whitespace) and content_sha no
    // longer matches. Empty/null for blank lines or range-only edits.
    content_sha_norm: string | null;
}

export interface DaemonStatus {
    running: boolean;
    port?: number;
}
