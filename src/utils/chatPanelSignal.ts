/** Extension Host: chat/composer attribution signals (filter DevTools by `[Blamely][chat-panel-signal]`). */
export function chatPanelSignal(kind: string, payload: Record<string, unknown> = {}): void {
    console.log('[Blamely][chat-panel-signal]', kind, payload);
}
