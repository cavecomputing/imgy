/** Selection mode and the bulk actions that apply to selected files. */
import { decrementTagCount, getImagesByFilenames, getSelectedFilenames, incrementTagCount, State } from './state.js';
import { Elements } from './dom.js';
import { formatCount } from './utils.js';
import { setToggleButtonState, showToast, withLoading } from './ui.js';
import { api } from './api.js';
import { applyFilters, reloadDataPreservingScroll } from './data.js';
import { updateLocalState } from './actions.js';
import { collectTagMutations, splitTagTokens } from './tags.js';
import { closeGalleryTagFlyup, isGalleryTagFlyupOpen, openBulkTagFlyup } from './flyup.js';
import { renderFilterBarTags } from './filters.js';
import { renderLibraryCount } from './grid.js';
import { llmQueueAdd } from './llm.js';

async function groupSelectedImages({ closeFlyup = false } = {}) {
    const filenames = getSelectedFilenames();
    if (filenames.length < 2) {
        showToast('Select at least 2 files to group');
        return false;
    }
    const res = await api.post('/api/groups', { filenames });
    if (!res.success) return false;
    showToast(`Grouped ${formatCount(filenames.length, 'file')}`);
    if (closeFlyup) closeGalleryTagFlyup();
    clearSelection();
    await reloadDataPreservingScroll();
    return true;
}

export function toggleSelectionMode() {
    State.selectionMode = !State.selectionMode;
    setToggleButtonState(Elements.selectModeBtn, State.selectionMode);
    Elements.imageGrid.classList.toggle('selection-mode', State.selectionMode);
    if (!State.selectionMode) {
        clearSelection();
    } else {
        Elements.selectionBar.classList.remove('hidden');
        updateSelectionBar();
    }
}

export function toggleImageSelection(filename, cardEl) {
    if (State.selectedImages.has(filename)) {
        State.selectedImages.delete(filename);
        cardEl.classList.remove('selected');
    } else {
        State.selectedImages.add(filename);
        cardEl.classList.add('selected');
    }
    updateSelectionBar();
}

export function updateSelectionBar() {
    const count = State.selectedImages.size;
    Elements.selectedCountEl.textContent = count;
    const actionTooltips = [
        [Elements.bulkFavoriteBtn, count === 0, 'Favorite or unfavorite the selected files'],
        [Elements.bulkTagBtn, count === 0, 'Edit tags (T)'],
        [Elements.groupSelectedBtn, count < 2, 'Group the selected files', 'Select at least 2 files to group'],
        [Elements.downloadSelectedBtn, count === 0, 'Download as a ZIP file'],
        [Elements.deleteSelectedBtn, count === 0, 'Move to trash']
    ];
    actionTooltips.forEach(([btn, disabled, enabledText, disabledText = 'Select files first']) => {
        if (!btn) return;
        btn.disabled = disabled;
        btn.title = disabled ? disabledText : enabledText;
    });
    Elements.clearSelectionBtn.title = count > 0 ? 'Clear the selection (Esc)' : 'Leave selection mode (Esc)';

    if (count > 0) {
        Elements.selectionBar.classList.remove('hidden');
    } else if (!State.selectionMode) {
        Elements.selectionBar.classList.add('hidden');
    }
    renderLibraryCount();
}

export function clearSelection() {
    State.selectedImages.clear();
    State.selectionMode = false;
    setToggleButtonState(Elements.selectModeBtn, false);
    Elements.imageGrid.classList.remove('selection-mode');
    Elements.selectionBar.classList.add('hidden');
    if (State.bulkTagFlyupMode) closeGalleryTagFlyup();
    document.querySelectorAll('.image-card.selected').forEach(el => el.classList.remove('selected'));
    updateSelectionBar();
}

export async function processBulkTagsFromInput(tagsStr) {
    if (!tagsStr || State.selectedImages.size === 0) return;

    const tokens = splitTagTokens(tagsStr);
    if (tokens.length === 0) return;

    const filenames = getSelectedFilenames();

    // Handle '++' group: group all selected images
    if (tokens.includes('++')) {
        if (tokens.length > 1) { showToast('"++" must be the only token'); return; }
        await groupSelectedImages({ closeFlyup: true });
        return;
    }

    // Handle '?' LLM analyze: queue each selected image
    if (tokens.includes('?')) {
        if (tokens.length > 1) { showToast('"?" must be the only token'); return; }
        for (const filename of filenames) llmQueueAdd(filename);
        return;
    }

    // Handle '=' equalize: give all selected images the union of all their tags
    if (tokens.includes('=')) {
        if (tokens.length > 1) { showToast('"=" must be the only token'); return; }
        const selectedImgs = getImagesByFilenames(filenames);
        const unionTags = [...new Set(selectedImgs.flatMap(img => img.tags || []))];
        if (unionTags.length === 0) { showToast('No tags to equalize'); return; }
        await withLoading(async () => {
            await api.post('/api/tags/bulk', { filenames, tags: unionTags });
            for (const img of selectedImgs) {
                const oldTags = img.tags || [];
                for (const t of unionTags) {
                    if (!oldTags.includes(t)) incrementTagCount(t);
                }
                img.tags = [...new Set([...oldTags, ...unionTags])];
            }
            applyFilters();
            renderFilterBarTags();
            updateSelectionBar();
            showToast(`Shared ${formatCount(unionTags.length, 'tag')} across ${formatCount(filenames.length, 'file')}`);
        });
        return;
    }

    // Handle '--' clear all tags
    if (tokens.length === 1 && tokens[0] === '--') {
        const allTags = new Set(filenames.flatMap(f => State.imagesByFilename.get(f)?.tags || []));
        if (allTags.size === 0) { showToast('No tags to remove'); return; }
        await withLoading(async () => {
            await api.post('/api/tags/bulk-remove', { filenames, tags: [...allTags] });
            for (const filename of filenames) {
                const img = State.imagesByFilename.get(filename);
                if (!img) continue;
                for (const t of img.tags || []) {
                    decrementTagCount(t);
                }
                img.tags = [];
            }
            applyFilters();
            renderFilterBarTags();
            updateSelectionBar();
            showToast(`Removed every tag from ${formatCount(filenames.length, 'file')}`);
        });
        return;
    }

    // Validate tokens and build toAdd/toRemove/toRename
    const unionTags = new Set(filenames.flatMap(f => State.imagesByFilename.get(f)?.tags || []));
    const { toAdd, toRemove, toRename } = collectTagMutations(tokens, {
        availableTags: State.allTags,
        existingTags: unionTags,
        unavailablePlainMessage: tag => `No tag named "${tag}". Use +${tag} to create it`,
        removeMissingMessage: tag => `"${tag}" is not on any selected file`,
        renameMissingMessage: tag => `"${tag}" is not on any selected file`
    });

    const uniqueAdds = [...new Set(toAdd)];
    const uniqueRemoves = [...new Set(toRemove)];
    if (uniqueAdds.length === 0 && uniqueRemoves.length === 0 && toRename.length === 0) return;

    // Each rename applies only to the files holding oldName at that point (after the adds,
    // removes, and earlier renames), the same files the local update below changes
    const renameTargets = toRename.map(() => []);
    for (const filename of filenames) {
        const tags = new Set(State.imagesByFilename.get(filename)?.tags || []);
        uniqueAdds.forEach(t => tags.add(t));
        uniqueRemoves.forEach(t => tags.delete(t));
        toRename.forEach(({ oldName, newName }, i) => {
            if (tags.delete(oldName)) {
                tags.add(newName);
                renameTargets[i].push(filename);
            }
        });
    }

    await withLoading(async () => {
        if (uniqueAdds.length > 0) {
            await api.post('/api/tags/bulk', { filenames, tags: uniqueAdds });
        }
        if (uniqueRemoves.length > 0) {
            await api.post('/api/tags/bulk-remove', { filenames, tags: uniqueRemoves });
        }
        // Rename: remove old + add new on the selected images that have the old tag
        for (const [i, { oldName, newName }] of toRename.entries()) {
            const targets = renameTargets[i];
            if (!targets.length) continue;
            await api.post('/api/tags/bulk-remove', { filenames: targets, tags: [oldName] });
            await api.post('/api/tags/bulk', { filenames: targets, tags: [newName] });
        }
        // Update local state instead of reloading
        let addedCount = 0, removedCount = 0, renamedCount = 0;
        for (const filename of filenames) {
            const img = State.imagesByFilename.get(filename);
            if (!img) continue;
            let tags = img.tags || [];
            for (const t of uniqueAdds) {
                if (!tags.includes(t)) {
                    tags = [...tags, t];
                    incrementTagCount(t);
                    addedCount++;
                }
            }
            for (const t of uniqueRemoves) {
                if (tags.includes(t)) {
                    tags = tags.filter(x => x !== t);
                    decrementTagCount(t);
                    removedCount++;
                }
            }
            for (const { oldName, newName } of toRename) {
                if (tags.includes(oldName)) {
                    tags = tags.filter(x => x !== oldName);
                    decrementTagCount(oldName);
                    if (!tags.includes(newName)) {
                        tags = [...tags, newName];
                        incrementTagCount(newName);
                    }
                    renamedCount++;
                }
            }
            img.tags = tags;
        }
        for (const t of uniqueAdds) {
            if (!State.allTags.includes(t)) State.allTags.push(t);
        }
        for (const { newName } of toRename) {
            if (!State.allTags.includes(newName)) State.allTags.push(newName);
        }
        State.allTags.sort();

        applyFilters();
        renderFilterBarTags();
        updateSelectionBar();

        // Show confirmation toast
        const parts = [];
        if (uniqueAdds.length > 0) parts.push(`+${uniqueAdds.join(', +')} (${addedCount})`);
        if (uniqueRemoves.length > 0) parts.push(`-${uniqueRemoves.join(', -')} (${removedCount})`);
        if (toRename.length > 0) parts.push(`${toRename.map(r => r.oldName + '>' + r.newName).join(', ')} (${renamedCount})`);
        const totalChanged = addedCount + removedCount + renamedCount;
        showToast(`${parts.join(', ')}: ${formatCount(totalChanged, 'change')}`);
    });
}

async function downloadSelectedAsZip() {
    if (State.selectedImages.size === 0) return;
    const filenames = getSelectedFilenames();
    showToast(`Preparing ZIP for ${formatCount(filenames.length, 'file')}`);
    await withLoading(async () => {
        const res = await fetch('/api/download-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames })
        });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'imgy_export.zip';
        a.click();
        URL.revokeObjectURL(url);
        showToast('ZIP download started');
    }).catch(() => showToast('Download failed'));
}

async function deleteSelectedImages() {
    if (State.selectedImages.size === 0) return;
    await withLoading(async () => {
        // Counts only the files that moved: some may have been deleted or trashed elsewhere
        const { count } = await api.post('/api/images/bulk-trash', { filenames: getSelectedFilenames() });
        clearSelection();
        await reloadDataPreservingScroll();
        showToast(`Moved ${formatCount(count, 'file')} to trash`);
    });
}

export async function bulkToggleFavorites() {
    const filenames = getSelectedFilenames();
    if (!filenames.length) return;
    const res = await api.post('/api/favorites/bulk-toggle', { filenames });
    for (const [filename, isFav] of Object.entries(res.results || {})) {
        updateLocalState(filename, { is_favorite: isFav });
    }
    const favorited = Object.values(res.results || {}).filter(Boolean).length;
    showToast(favorited ? `Favorited ${formatCount(favorited, 'file')}` : `Unfavorited ${formatCount(filenames.length, 'file')}`);
}

export function initSelection() {
    setToggleButtonState(Elements.selectModeBtn, false);

    updateSelectionBar();

    Elements.selectModeBtn.addEventListener('click', toggleSelectionMode);
    Elements.clearSelectionBtn.addEventListener('click', clearSelection);
    Elements.deleteSelectedBtn.addEventListener('click', deleteSelectedImages);
    Elements.downloadSelectedBtn.addEventListener('click', downloadSelectedAsZip);
    Elements.groupSelectedBtn.addEventListener('click', async () => {
        await groupSelectedImages();
    });
    Elements.bulkTagBtn.addEventListener('click', () => {
        if (isGalleryTagFlyupOpen() && State.bulkTagFlyupMode) closeGalleryTagFlyup();
        else openBulkTagFlyup();
    });
    Elements.bulkFavoriteBtn.addEventListener('click', () => bulkToggleFavorites());
}
