export function text(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return { content: [{ type: 'text', text }] };
}
