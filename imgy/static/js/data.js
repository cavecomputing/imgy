/** Loads images and tags from the server and applies the active filters. */
import { CONFIG } from './config.js';
import { incrementTagCount, State } from './state.js';
import { Elements } from './dom.js';
import { hideLoading, showError, showLoading } from './ui.js';
import { api } from './api.js';
import { renderImageGrid } from './grid.js';
import { updateSelectionBar } from './selection.js';
import { renderFilterBarTags } from './filters.js';

export async function reloadDataPreservingScroll() {
    const scrollY = window.scrollY;
    await loadData();
    window.scrollTo(0, scrollY);
}

let loadDataController = null;

export function abortLoadData() {
    if (loadDataController) loadDataController.abort();
}

export async function loadData() {
    // Abort any in-flight loadData request
    if (loadDataController) loadDataController.abort();
    const controller = new AbortController();
    loadDataController = controller;

    const timeoutId = setTimeout(() => controller.abort(), CONFIG.LOAD_DATA_TIMEOUT_MS);

    showLoading();
    try {
        const [imagesResp, tags] = await Promise.all([
            api.get('/api/images', { signal: controller.signal }),
            api.get('/api/tags', { signal: controller.signal })
        ]);
        // If this call was superseded, discard stale results
        if (controller.signal.aborted) return;
        const images = imagesResp.images || imagesResp;
        const groups = imagesResp.groups || {};
        State.filenameToGroup = {};
        for (const [gid, members] of Object.entries(groups)) {
            for (const fn of members) State.filenameToGroup[fn] = gid;
        }
        State.images = images;
        State.imagesByFilename = new Map(images.map(img => [img.filename, img]));
        State.allTags = tags;
        State.tagCounts = {};
        images.forEach(img => img.tags?.forEach(t => {
            incrementTagCount(t);
        }));
        applyFilters();

        renderFilterBarTags();
    } catch (err) {
        if (err.name === 'AbortError') {
            // Distinguish timeout from superseded-by-newer-call
            if (loadDataController === controller) {
                showError('Loading timed out — try refreshing the page.');
            }
            return;
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
        // Only hide loading if this is still the active request
        if (loadDataController === controller) hideLoading();
    }
}

/**
 * Sort newest first, then pull each group's members up to its newest member so the group
 * sits in one block. The grid, the lightbox, and keyboard navigation all follow this order.
 */
function sortForDisplay(images) {
    images.sort((a, b) => b.modified - a.modified);
    const blocks = [];
    const groupBlocks = {};
    for (const img of images) {
        const gid = State.filenameToGroup[img.filename];
        if (!gid) { blocks.push([img]); continue; }
        if (!groupBlocks[gid]) { groupBlocks[gid] = []; blocks.push(groupBlocks[gid]); }
        groupBlocks[gid].push(img);
    }
    return blocks.flat();
}

export function applyFilters() {
    const scrollY = window.scrollY;
    const inLightbox = Elements.lightbox.classList.contains('active');
    const pinnedFilename = inLightbox ? State.filteredImages[State.currentImageIndex]?.filename : null;

    const filtered = State.images.filter(img => {
        // Keep the pinned lightbox image in the list even if it no longer matches filters
        if (pinnedFilename && img.filename === pinnedFilename) return true;
        const matchesUntagged = !State.showUntaggedOnly || (!img.tags || img.tags.length === 0);
        const matchesFavorites = !State.showFavoritesOnly || img.is_favorite;
        const matchesTags = State.activeTags.size === 0 || Array.from(State.activeTags).every(t => img.tags?.includes(t));
        const matchesExclude = State.excludeTags.size === 0 || !Array.from(State.excludeTags).some(t => img.tags?.includes(t));
        return matchesUntagged && matchesFavorites && matchesTags && matchesExclude;
    });
    State.filteredImages = sortForDisplay(filtered);

    // Restore lightbox index to the pinned image
    if (pinnedFilename) {
        const newIdx = State.filteredImages.findIndex(i => i.filename === pinnedFilename);
        if (newIdx >= 0) State.currentImageIndex = newIdx;
        else State.currentImageIndex = Math.min(State.currentImageIndex, Math.max(0, State.filteredImages.length - 1));
    }

    // Prune selections that are no longer visible
    if (State.selectedImages.size > 0) {
        const visibleSet = new Set(State.filteredImages.map(i => i.filename));
        for (const fn of State.selectedImages) {
            if (!visibleSet.has(fn)) State.selectedImages.delete(fn);
        }
        updateSelectionBar();
    }

    renderImageGrid();
    window.scrollTo(0, scrollY);
}
