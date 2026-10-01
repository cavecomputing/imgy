/** Trash dialog: restore, delete permanently, empty, and orphan cleanup. */
import { Elements } from './dom.js';
import { esc, formatCount } from './utils.js';
import { closeOnBackdropClick, showToast, withLoading } from './ui.js';
import { api } from './api.js';
import { loadData, reloadDataPreservingScroll } from './data.js';

async function emptyTrash() {
    if (!confirm('Permanently delete every item currently in trash? This cannot be undone.')) return;
    await withLoading(async () => {
        await api.delete('/api/trash/empty');
        await loadTrash();
        showToast('Trash emptied permanently');
    });
}

async function cleanupOrphans() {
    if (!confirm('Clean up orphaned database entries and thumbnail files? This cannot be undone.')) return;
    await withLoading(async () => {
        const res = await api.post('/api/maintenance/cleanup');
        const dbCount = Object.values(res.orphaned_db_entries).reduce((a, b) => a + b, 0);
        const thumbnailCount = Number(res.orphaned_thumbnails || 0);
        showToast(`Cleanup complete: ${formatCount(dbCount, 'DB entry', 'DB entries')}, ${formatCount(thumbnailCount, 'thumbnail')} removed`);
        await loadData();
    });
}

async function loadTrash() {
    const files = await api.get('/api/trash');
    Elements.trashList.innerHTML = files.length ? '' : '<div class="trash-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>Trash is empty</span></div>';
    files.forEach(f => {
        const item = document.createElement('div');
        item.className = 'trash-item';
        const displayName = f.original_name || f.trash_name;
        const dateStr = f.trash_date ? new Date(f.trash_date * 1000).toLocaleDateString() : '';
        item.innerHTML = `<div class="trash-item-preview"><img src="/thumbnails/.trash/${encodeURIComponent(f.trash_name)}" alt="" loading="lazy"></div><div class="trash-item-name">${esc(displayName)}${dateStr ? `<span class="trash-item-date">${esc(dateStr)}</span>` : ''}</div><div class="trash-item-actions"><button class="trash-item-btn restore" title="Restore" aria-label="Restore"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg></button><button class="trash-item-btn delete" title="Delete permanently" aria-label="Delete permanently"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button></div>`;
        item.querySelector('.restore').onclick = async function() {
            this.disabled = true;
            try {
                await api.post(`/api/trash/restore/${encodeURIComponent(f.trash_name)}`);
                showToast('Restored');
                await reloadDataPreservingScroll();
                loadTrash();
            }
            finally { this.disabled = false; }
        };
        item.querySelector('.delete').onclick = async function() {
            if (!confirm(`Permanently delete "${displayName}" from trash? This cannot be undone.`)) return;
            this.disabled = true;
            try { await api.delete(`/api/trash/${encodeURIComponent(f.trash_name)}`); await loadTrash(); }
            finally { this.disabled = false; }
        };
        Elements.trashList.appendChild(item);
    });
}

export function initTrash() {
    closeOnBackdropClick(Elements.trashModal);
    Elements.emptyTrashBtn.addEventListener('click', emptyTrash);
    Elements.cleanupOrphansBtn.addEventListener('click', cleanupOrphans);

    Elements.trashBtn.onclick = () => {
        if (Elements.trashModal.open) {
            Elements.trashModal.close();
        } else {
            Elements.trashModal.showModal(); loadTrash();
        }
    };
    Elements.closeTrashModal.onclick = () => { Elements.trashModal.close(); };
}
