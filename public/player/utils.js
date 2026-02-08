export function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function formatEta(seconds) {
    if (!seconds || seconds === Infinity) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTime(s) {
    if (!s || Number.isNaN(s)) return '00:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const mStr = m.toString().padStart(2, '0');
    const sStr = sec.toString().padStart(2, '0');
    if (h > 0) {
        const hStr = h.toString().padStart(2, '0');
        return `${hStr}:${mStr}:${sStr}`;
    }
    return `${mStr}:${sStr}`;
}
