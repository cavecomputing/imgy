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

export function getImageBaseName(filename) {
    return filename.split('/').pop().replace(/\.[^/.]+$/, "");
}

export function getDisplayFilename(filename) {
    return filename.split('/').pop();
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
