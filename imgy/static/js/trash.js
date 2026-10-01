/** Trash dialog: restore, delete permanently, empty, and orphan cleanup. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, formatFileSize, formatShortDate } from './utils.js';
import { closeOnBackdropClick, showToast, withLoading } from './ui.js';
import { api } from './api.js';
import { loadData, reloadDataPreservingScroll } from './data.js';

/** The badge on the top-bar trash button. */
export function setTrashCount(count) {
    State.trashCount = Math.max(0, count);
    Elements.trashCount.textContent = State.trashCount > 99 ? '99+' : String(State.trashCount);
    Elements.trashCount.classList.toggle('hidden', State.trashCount === 0);
    Elements.trashBtn.setAttribute('aria-label', State.trashCount ? `Open trash, ${formatCount(State.trashCount, 'file')}` : 'Open trash');
}

async function emptyTrash() {
    if (!confirm('Permanently delete every file in the trash? This cannot be undone.')) return;
    await withLoading(async () => {
        await api.delete('/api/trash/empty');
        await loadTrash();
        showToast('Trash emptied');
    });
}

async function cleanupOrphans() {
    if (!confirm('Drop the tags, favorites and thumbnails left behind by files deleted outside Imgy? This cannot be undone.')) return;
    await withLoading(async () => {
        const res = await api.post('/api/maintenance/cleanup');
        const dbCount = Object.values(res.orphaned_db_entries).reduce((a, b) => a + b, 0);
        const thumbnailCount = Number(res.orphaned_thumbnails || 0);
        showToast(`Cleaned up ${formatCount(dbCount, 'database entry', 'database entries')} and ${formatCount(thumbnailCount, 'thumbnail')}`);
        await loadData();
    });
}

function renderTrashRow(f) {
    const displayName = f.original_name || f.trash_name;
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><div class="trash-file"><img src="/thumbnails/.trash/${encodeURIComponent(f.trash_name)}" alt="" loading="lazy"><span title="${esc(displayName)}">${esc(displayName)}</span></div></td>
        <td class="cc-note">${esc(formatFileSize(f.size) || '—')}</td>
        <td class="cc-note">${esc(f.trash_date ? formatShortDate(f.trash_date) : '—')}</td>
        <td class="trash-actions">
            <button class="cc-btn cc-btn--ghost btn-sm restore" type="button" title="Put it back where it was"><svg class="i i-xs" aria-hidden="true"><use href="#i-restore"/></svg><span>Restore</span></button>
            <button class="icon-btn icon-btn--warn icon-btn--sm delete" type="button" title="Delete forever" aria-label="Delete ${esc(displayName)} forever"><svg class="i i-sm" aria-hidden="true"><use href="#i-x"/></svg></button>
        </td>
    `;
    row.querySelector('.restore').addEventListener('click', async function () {
        this.disabled = true;
        try {
            await api.post(`/api/trash/restore/${encodeURIComponent(f.trash_name)}`);
            showToast(`Restored ${displayName}`);
            await reloadDataPreservingScroll();
            await loadTrash();
        } finally { this.disabled = false; }
    });
    row.querySelector('.delete').addEventListener('click', async function () {
        if (!confirm(`Permanently delete "${displayName}"? This cannot be undone.`)) return;
        this.disabled = true;
        try {
            await api.delete(`/api/trash/${encodeURIComponent(f.trash_name)}`);
            await loadTrash();
        } finally { this.disabled = false; }
    });
    return row;
}

async function loadTrash() {
    const files = await api.get('/api/trash');
    setTrashCount(files.length);
    Elements.emptyTrashBtn.disabled = files.length === 0;
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    Elements.trashSummary.textContent = files.length
        ? `${formatCount(files.length, 'file')}${totalSize ? ` · ${formatFileSize(totalSize)}` : ''}`
        : 'empty';

    if (!files.length) {
        Elements.trashList.innerHTML = '<div class="trash-empty"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg><span>Trash is empty</span></div>';
        return;
    }
    const table = document.createElement('table');
    table.className = 'cc-table trash-table';
    table.innerHTML = '<thead><tr><th>File</th><th>Size</th><th>Trashed</th><th><span class="sr-only">Actions</span></th></tr></thead>';
    const body = document.createElement('tbody');
    files.forEach(f => body.appendChild(renderTrashRow(f)));
    table.appendChild(body);
    Elements.trashList.replaceChildren(table);
}

export function toggleTrashModal() {
    if (Elements.trashModal.open) {
        Elements.trashModal.close();
    } else {
        Elements.trashModal.showModal();
        loadTrash();
    }
}

export function initTrash() {
    closeOnBackdropClick(Elements.trashModal);
    Elements.emptyTrashBtn.addEventListener('click', emptyTrash);
    Elements.cleanupOrphansBtn.addEventListener('click', cleanupOrphans);
    Elements.trashBtn.addEventListener('click', toggleTrashModal);
    Elements.closeTrashModal.addEventListener('click', () => Elements.trashModal.close());
}
