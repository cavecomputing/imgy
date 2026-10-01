/** Single-file actions: favorite, tag, untag, and move to trash. */
import { decrementTagCount, getCurrentLightboxImage, incrementTagCount, LlmQueue, State } from './state.js';
import { Elements } from './dom.js';
import { getDisplayFilename, getExtension, getImageBaseName } from './utils.js';
import { showToast, withLoading } from './ui.js';
import { api } from './api.js';
import { applyFilters } from './data.js';
import { renderLibraryCount } from './grid.js';
import { closeLightbox, renderLightboxMeta, renderLightboxTagBar, setLightboxFavoriteState, updateLightboxContent } from './lightbox.js';
import { setTrashCount } from './trash.js';

/**
 * Point everything on the client that holds a file's name at its new name after the server
 * renamed it (`data` is the /api/images/rename response). Every rename path calls this.
 */
export function applyRenameLocally(oldFilename, data) {
    const newFilename = data.new_filename;
    const item = State.imagesByFilename.get(oldFilename);
    if (item) {
        State.imagesByFilename.delete(oldFilename);
        item.filename = newFilename;
        item.url = data.url;
        item.thumbnail_url = data.thumbnail_url;
        State.imagesByFilename.set(newFilename, item);
    }
    const gid = State.filenameToGroup[oldFilename];
    if (gid) {
        delete State.filenameToGroup[oldFilename];
        State.filenameToGroup[newFilename] = gid;
    }
    if (State.selectedImages.delete(oldFilename)) State.selectedImages.add(newFilename);
    const bulkFilenames = State.currentQuickTagImage?._bulkFilenames;
    const bulkIdx = bulkFilenames ? bulkFilenames.indexOf(oldFilename) : -1;
    if (bulkIdx !== -1) bulkFilenames[bulkIdx] = newFilename;
    for (const entry of LlmQueue.items) {
        if (entry.filename === oldFilename) entry.filename = newFilename;
    }

    const newBaseName = getImageBaseName(newFilename);
    const card = document.querySelector(`.image-card[data-filename="${CSS.escape(oldFilename)}"]`);
    if (card) {
        card.dataset.filename = newFilename;
        const title = card.querySelector('.card-title-text');
        if (title) title.textContent = newBaseName;
        const ext = card.querySelector('.card-ext');
        if (ext) ext.textContent = getExtension(newFilename);
        const img = card.querySelector('.card-media img');
        if (img) img.alt = newBaseName;
        const link = card.querySelector('a[download]');
        if (link) {
            link.href = data.url;
            link.download = getDisplayFilename(newFilename);
        }
    }

    if (State.currentQuickTagImage?.filename === newFilename && !State.bulkTagFlyupMode) {
        Elements.galleryTagTitle.textContent = getDisplayFilename(newFilename);
    }

    const current = getCurrentLightboxImage();
    if (Elements.lightbox.classList.contains('active') && current?.filename === newFilename) {
        Elements.lightboxHeaderFilename.textContent = newBaseName;
        Elements.lightboxHeaderExt.textContent = getExtension(newFilename);
        for (const link of [Elements.lightboxDownloadBtn, Elements.lightboxDownloadTab]) {
            link.href = data.url;
            link.download = getDisplayFilename(newFilename);
        }
        renderLightboxMeta(current);
    }
}

export async function toggleFavorite(filename) {
    const res = await api.post('/api/favorites/toggle', { filename });
    return res.is_favorite;
}

export function updateLocalState(filename, updates) {
    const img = State.imagesByFilename.get(filename);
    if (img) Object.assign(img, updates);
    
    const card = document.querySelector(`.image-card[data-filename="${CSS.escape(filename)}"]`);
    if (card && updates.is_favorite !== undefined) {
        card.classList.toggle('is-fav', updates.is_favorite);
        card.querySelector('.star-btn')?.setAttribute('aria-pressed', updates.is_favorite ? 'true' : 'false');
    }

    if (updates.is_favorite !== undefined) {
        if (State.showFavoritesOnly) applyFilters();
        else renderLibraryCount();
    }

    const current = getCurrentLightboxImage();
    if (Elements.lightbox.classList.contains('active') && current?.filename === filename) {
        if (updates.is_favorite !== undefined) setLightboxFavoriteState(updates.is_favorite);
        if (updates.tags) renderLightboxTagBar(updates.tags, filename);
    }
}

/** Add a list of tags to one file. Tags may contain spaces, so pass an array, not a string. */
export async function addTags(filename, tags) {
    const img = State.imagesByFilename.get(filename);
    if (!img) return;
    const existing = img.tags || [];
    const newTags = Array.from(new Set(tags.map(t => String(t).trim().toLowerCase()).filter(t => t && !existing.includes(t))));
    if (!newTags.length) return;
    
    await withLoading(async () => {
        await api.post('/api/tags/bulk', { filenames: [filename], tags: newTags });
        const updatedTags = [...existing, ...newTags];
        updateLocalState(filename, { tags: updatedTags });
        newTags.forEach(t => {
            if (!State.allTags.includes(t)) State.allTags.push(t);
            incrementTagCount(t);
        });
        State.allTags.sort();

        applyFilters();
    });
}

export async function removeTag(filename, tag) {
    // The bulk endpoint takes the tag in the body, so tags containing '/' work
    await api.post('/api/tags/bulk-remove', { filenames: [filename], tags: [tag] });
    const img = State.imagesByFilename.get(filename);
    if (img) {
        const hadTag = (img.tags || []).includes(tag);
        const updatedTags = (img.tags || []).filter(t => t !== tag);
        updateLocalState(filename, { tags: updatedTags });
        if (hadTag) decrementTagCount(tag);
    }
    applyFilters();
}

export async function deleteImage(idx) {
    const img = State.filteredImages[idx];
    if (!img) return;
    const displayName = getDisplayFilename(img.filename);
    await withLoading(async () => {
        await api.delete(`/api/images/${encodeURIComponent(img.filename)}`);
        setTrashCount(State.trashCount + 1);
        State.imagesByFilename.delete(img.filename);
        (img.tags || []).forEach(t => { decrementTagCount(t); });
        State.images = State.images.filter(i => i.filename !== img.filename);
        State.keepFocusPosition = true; // keyboard focus moves on to the next card
        applyFilters();
        if (Elements.lightbox.classList.contains('active')) {
            if (!State.filteredImages.length) closeLightbox();
            else {
                if (State.currentImageIndex >= State.filteredImages.length) State.currentImageIndex = State.filteredImages.length - 1;
                updateLightboxContent();
            }
        }
        showToast(`Moved ${displayName} to trash`);
    });
}
