/** oobeya-cli git note JSON schema (refs/notes/blamely). */
export interface CliNote {
    schema: number;
    commit: string;
    generated_by?: string;
    totals: {
        ai_lines: number;
        human_lines: number;
        deleted_lines: number;
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
    added: number;
    deleted: number;
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
}

export interface DaemonStatus {
    running: boolean;
    port?: number;
}
