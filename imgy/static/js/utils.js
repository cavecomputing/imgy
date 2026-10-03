/** Pure helpers: HTML escaping, formatting, and file-type checks. */
const UPLOAD_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
    'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'
]);

export function isUploadableFile(f) {
    const ext = f.name.split('.').pop()?.toLowerCase();
    return ext && UPLOAD_EXTENSIONS.has(ext);
}

export function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

export function formatCount(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Whether a file's path contains `term`, ignoring case. Spaces, underscores and hyphens count as
 * the same character, since uploads turn spaces into underscores and auto-tag names use hyphens.
 */
export function nameContains(filename, term) {
    const words = s => s.toLowerCase().replace(/[\s_-]+/g, ' ');
    return words(filename).includes(words(term));
}

export function getImageBaseName(filename) {
    return filename.split('/').pop().replace(/\.[^/.]+$/, "");
}

export function getDisplayFilename(filename) {
    return filename.split('/').pop();
}

/** The extension with its dot ('.jpg'), or '' when the name has none. */
export function getExtension(filename) {
    const name = getDisplayFilename(filename);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot) : '';
}

/** Escape text for HTML and wrap the first case-insensitive match of `term` in <mark>. */
export function highlightMatch(text, term) {
    const i = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + term.length)) + '</mark>' + esc(text.slice(i + term.length));
}

/** "Oct 1", or "Oct 1, 2025" for another year. */
export function formatShortDate(seconds) {
    const d = new Date(seconds * 1000);
    if (isNaN(d)) return '';
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
}

export function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);

export function isVideo(filename) {
    const ext = '.' + filename.split('.').pop().toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}
