/** Uploads from the file picker or drag-and-drop, and downloads from a link, with a progress bar. */
import { Elements } from './dom.js';
import { formatCount, formatFileSize, isUploadableFile } from './utils.js';
import { showError, showToast } from './ui.js';
import { loadData } from './data.js';
import { api } from './api.js';

function uploadFileXHR(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
        });
        xhr.addEventListener('load', () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
            } else {
                const err = new Error(data.error || `HTTP ${xhr.status}`);
                err.skipped = data.skipped || [];
                reject(err);
            }
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        const fd = new FormData();
        fd.append('images', file);
        xhr.send(fd);
    });
}

let uploadQueue = Promise.resolve();
let hideProgressTimer = null;

/** Uploads run one after another, so a second drop waits instead of sharing the first one's progress bar. */
function uploadFiles(files) {
    const run = uploadQueue.catch(() => {}).then(() => runUpload(files));
    uploadQueue = run;
    return run;
}

async function runUpload(files) {
    if (!files.length) return;

    const skippedClient = files
        .filter(f => !isUploadableFile(f))
        .map(f => ({ filename: f.name, reason: 'Unsupported file type' }));
    files = files.filter(isUploadableFile);

    if (!files.length) {
        const first = skippedClient[0];
        showError(first ? `No supported files to upload. Skipped ${first.filename}.` : 'No supported files to upload.');
        return;
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let completedBytes = 0;
    let currentFileLoaded = 0;
    let successCount = 0;
    let failCount = 0;
    const skippedServer = [];

    clearTimeout(hideProgressTimer);
    Elements.uploadProgressBar.style.width = '0%';
    Elements.uploadProgressText.textContent = `Uploading 1 of ${files.length}…`;
    Elements.uploadProgress.classList.remove('hidden');

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        currentFileLoaded = 0;
        Elements.uploadProgressText.textContent = files.length === 1
            ? `Uploading ${file.name}`
            : `Uploading ${i + 1} of ${files.length}…`;
        try {
            const result = await uploadFileXHR(file, (loaded, _total) => {
                currentFileLoaded = loaded;
                const pct = totalBytes > 0 ? ((completedBytes + currentFileLoaded) / totalBytes) * 100 : 0;
                Elements.uploadProgressBar.style.width = `${Math.min(pct, 100)}%`;
            });
            if (result.skipped?.length) skippedServer.push(...result.skipped);
            successCount++;
        } catch (err) {
            console.error(`Upload failed for ${file.name}:`, err);
            if (err.skipped?.length) {
                skippedServer.push(...err.skipped);
            } else {
                failCount++;
            }
        }
        completedBytes += file.size;
    }

    Elements.uploadProgressBar.style.width = '100%';
    const skippedCount = skippedClient.length + skippedServer.length;
    const resultParts = [`Uploaded ${formatCount(successCount, 'file')}`];
    if (skippedCount) resultParts.push(`${skippedCount} skipped`);
    if (failCount) resultParts.push(`${failCount} failed`);
    Elements.uploadProgressText.textContent = resultParts.join(', ');

    if (failCount > 0) showError(`Uploaded ${formatCount(successCount, 'file')}, ${failCount} failed`);
    else if (skippedCount > 0) {
        const first = skippedClient[0] || skippedServer[0];
        showToast(first ? `Skipped ${first.filename}: ${first.reason}` : `Skipped ${formatCount(skippedCount, 'file')}`);
    }
    try {
        await loadData();
    } finally {
        hideProgressTimer = setTimeout(() => Elements.uploadProgress.classList.add('hidden'), 1500);
    }
}

const DOWNLOAD_ACTIVE = new Set(['starting', 'downloading', 'processing']);
const watchedDownloads = new Set(); // seen running on this page, so it reports how each one ends once
let downloadPollTimer = null;

/** Ask the server to fetch the image or video at url; progress shows in the upload panel. */
export async function startDownload(url, tags = []) {
    const { id } = await api.post('/api/downloads', { url, tags });
    watchedDownloads.add(id);
    await pollDownloads();
}

/** Show the running downloads and report the ones that ended, every second while any run. */
async function pollDownloads() {
    clearTimeout(downloadPollTimer);
    const { downloads } = await api.get('/api/downloads');
    const running = downloads.filter(d => DOWNLOAD_ACTIVE.has(d.status));
    let added = false;
    for (const d of downloads) {
        if (DOWNLOAD_ACTIVE.has(d.status)) { watchedDownloads.add(d.id); continue; }
        if (!watchedDownloads.delete(d.id)) continue;
        if (d.status === 'done') { added = true; showToast(`Downloaded ${d.filename}`); }
        if (d.status === 'failed') showError(`Couldn't download from ${d.site}: ${d.error}`);
    }
    showDownloadProgress(running);
    if (added) await loadData();
    if (running.length) downloadPollTimer = setTimeout(pollDownloads, 1000);
}

function showDownloadProgress(running) {
    const panel = Elements.uploadProgress;
    if (!running.length) {
        if (panel.dataset.download) { panel.classList.add('hidden'); delete panel.dataset.download; }
        Elements.uploadProgressCancel.classList.add('hidden');
        Elements.uploadProgressMeta.classList.add('hidden');
        return;
    }
    const d = running[0];
    const pct = d.status === 'processing' ? 100 : d.total ? Math.min(100, (d.downloaded / d.total) * 100) : 0;
    const step = d.status === 'starting' ? 'looking up the link'
        : d.status === 'processing' ? 'joining video and audio'
        : `${d.part ? `${d.part} ` : ''}${formatFileSize(d.downloaded || 0)} of ${d.total ? formatFileSize(d.total) : '?'}`;
    const others = running.length > 1 ? ` · +${running.length - 1}` : '';
    Elements.uploadProgressText.textContent = d.title || `Downloading from ${d.site}`;
    Elements.uploadProgressMeta.textContent = `${d.site} · ${step}${others}`;
    Elements.uploadProgressBar.style.width = `${pct}%`;
    Elements.uploadProgressCancel.dataset.id = d.id;
    Elements.uploadProgressCancel.classList.remove('hidden');
    Elements.uploadProgressMeta.classList.remove('hidden');
    panel.dataset.download = d.id;
    panel.classList.remove('hidden');
}

export function initUpload() {
    // Downloads started on another device or before a reload keep running on the server
    pollDownloads().catch(() => {});
    Elements.uploadProgressCancel.addEventListener('click', async (e) => {
        e.currentTarget.blur();
        await api.delete(`/api/downloads/${Elements.uploadProgressCancel.dataset.id}`);
        showToast('Download cancelled');
        await pollDownloads();
    });

    // Paste a link anywhere outside a text field to put it in the filter bar, which says what Enter will do
    document.addEventListener('paste', (e) => {
        if (e.target.closest?.('input, textarea, [contenteditable], dialog')) return;
        const text = e.clipboardData.getData('text/plain').trim();
        if (!/^https?:\/\/\S+$/i.test(text)) return;
        e.preventDefault();
        Elements.tagSearch.value = text;
        Elements.tagSearch.focus();
        Elements.tagSearch.dispatchEvent(new Event('input'));
    });

    // The service worker sends files shared from the phone's share sheet here with the count it uploaded
    const shared = new URLSearchParams(location.search).get('shared');
    if (shared !== null) {
        history.replaceState(null, '', '/');
        if (shared === '0') showError('Could not add the shared files');
        else if (shared === 'link') showToast('Downloading the shared link');
        else showToast(`Uploaded ${formatCount(Number(shared), 'file')}`);
    }

    Elements.uploadBtn.addEventListener('click', () => Elements.imageInput.click());
    Elements.imageInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        Elements.imageInput.value = ''; // so picking the same files again still fires a change
        await uploadFiles(files);
    });

    let internalDrag = false;
    document.addEventListener('dragstart', () => { internalDrag = true; });
    document.addEventListener('dragend', () => { internalDrag = false; });
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!internalDrag) document.body.classList.add('drag-over');
    });
    document.addEventListener('dragleave', (e) => {
        if (e.relatedTarget === null || !document.body.contains(e.relatedTarget)) {
            document.body.classList.remove('drag-over');
        }
    });
    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        document.body.classList.remove('drag-over');
        if (internalDrag) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length) await uploadFiles(files);
    });
}
