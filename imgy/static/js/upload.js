/** Uploads from the file picker or drag-and-drop, with a progress bar. */
import { Elements } from './dom.js';
import { formatCount, isUploadableFile } from './utils.js';
import { showError, showToast } from './ui.js';
import { loadData } from './data.js';

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

async function uploadFiles(files) {
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
    await loadData();

    setTimeout(() => Elements.uploadProgress.classList.add('hidden'), 1500);
}

export function initUpload() {
    // The service worker sends files shared from the phone's share sheet here with the count it uploaded
    const shared = new URLSearchParams(location.search).get('shared');
    if (shared !== null) {
        history.replaceState(null, '', '/');
        if (shared === '0') showError('Could not add the shared files');
        else showToast(`Uploaded ${formatCount(Number(shared), 'file')}`);
    }

    Elements.uploadBtn.addEventListener('click', () => Elements.imageInput.click());
    Elements.imageInput.addEventListener('change', async (e) => {
        await uploadFiles(Array.from(e.target.files));
        Elements.imageInput.value = '';
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
