/** Gallery grid: image cards, groups, and the masonry layout. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, getDisplayFilename, getImageBaseName, isVideo } from './utils.js';
import { showToast } from './ui.js';
import { api } from './api.js';
import { reloadDataPreservingScroll } from './data.js';
import { startInlineRename } from './rename.js';
import { clearCardFocus, getFocusedCard, restoreCardFocus } from './navigation.js';
import { toggleImageSelection } from './selection.js';
import { deleteImage, toggleFavorite, updateLocalState } from './actions.js';
import { openGalleryTagFlyup } from './flyup.js';
import { openLightbox } from './lightbox.js';
import { llmQueueUpdateUI } from './llm.js';

function createCardTagPreview(tags = []) {
    if (!tags.length) return '';
    const visible = tags.slice(0, 3);
    const overflow = tags.length - visible.length;
    return `
        <div class="card-tag-preview" aria-hidden="true">
            ${visible.map(t => `<span>${esc(t)}</span>`).join('')}
            ${overflow > 0 ? `<span class="card-tag-overflow">+${overflow}</span>` : ''}
        </div>
    `;
}

function createImageCard(img, idx) {
    const card = document.createElement('div');
    const isSelected = State.selectedImages.has(img.filename);
    card.className = `image-card ${img.is_favorite ? 'is-fav' : ''} ${isSelected ? 'selected' : ''}`;
    card.dataset.filename = img.filename;

    const baseName = getImageBaseName(img.filename);

    card.innerHTML = `
        <div class="card-fav-indicator">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#fbbf24" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
        </div>
        ${(img.tags && img.tags.length) ? `<div class="card-tag-count">${img.tags.length}</div>` : '<div class="card-no-tags"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="2" y1="22" x2="22" y2="2"/></svg></div>'}
        ${createCardTagPreview(img.tags || [])}
        <img src="${esc(img.thumbnail_url)}" alt="${esc(baseName)}" loading="lazy">
        ${isVideo(img.filename) ? '<div class="card-video-indicator"><svg width="32" height="32" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="8 5 19 12 8 19"></polygon></svg></div>' : ''}
        <div class="card-actions">
            <button class="card-action-btn delete-btn" title="Move to trash" aria-label="Move to trash">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
            <a href="${esc(img.url)}" download="${esc(getDisplayFilename(img.filename))}" class="card-action-btn" title="Download" aria-label="Download">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
            </a>
            <button class="card-action-btn star-btn" title="Toggle favorite" aria-label="Toggle favorite">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                </svg>
            </button>
            <span class="card-action-btn btn-add-tag" title="Edit tags" aria-label="Edit tags">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                    <line x1="7" y1="7" x2="7.01" y2="7"></line>
                </svg>
            </span>
        </div>
        <div class="image-filename">
            <div class="card-title"><span class="card-title-text">${esc(baseName)}</span></div>
        </div>
    `;

    card.querySelector('img').addEventListener('load', () => resizeMasonryItem(card));
    card.dataset.idx = idx;
    card.addEventListener('click', (e) => handleCardClick(e, img, idx, card));
    return card;
}

function createGroupContainer(groupId, members, filteredIndex) {
    const groupEl = document.createElement('div');
    groupEl.className = 'image-group';
    groupEl.dataset.groupId = groupId;

    const header = document.createElement('div');
    header.className = 'image-group-header';
    header.innerHTML = `
        <span class="image-group-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7"></rect>
                <rect x="14" y="3" width="7" height="7"></rect>
                <rect x="3" y="14" width="7" height="7"></rect>
                <rect x="14" y="14" width="7" height="7"></rect>
            </svg>
            ${members.length}
        </span>
        <button class="image-group-ungroup" title="Ungroup">Ungroup</button>
    `;
    header.querySelector('.image-group-ungroup').addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.delete(`/api/groups/${groupId}`);
        showToast('Group removed');
        await reloadDataPreservingScroll();
    });
    groupEl.appendChild(header);

    const innerGrid = document.createElement('div');
    innerGrid.className = 'image-group-grid';

    members.forEach(img => {
        const idx = filteredIndex ? (filteredIndex.get(img.filename) ?? -1) : State.filteredImages.indexOf(img);
        const card = createImageCard(img, idx);
        innerGrid.appendChild(card);
    });

    groupEl.appendChild(innerGrid);
    return groupEl;
}

function resizeGroupItem(groupEl) {
    if (!groupEl) return;
    const grid = Elements.imageGrid;
    const style = window.getComputedStyle(grid);
    const rowHeight = parseInt(style.getPropertyValue('grid-auto-rows')) || 10;
    const rect = groupEl.getBoundingClientRect();
    if (rect.height === 0) return;
    const margin = parseInt(window.getComputedStyle(groupEl).getPropertyValue('margin-bottom')) || 0;
    const rowSpan = Math.ceil((rect.height + margin) / rowHeight);
    groupEl.style.gridRowEnd = `span ${rowSpan}`;
}

export function renderImageGrid() {
    // Remember the keyboard-focused card so the rebuilt grid can focus it again
    const prevFocus = State.cardFocusActive
        ? { filename: getFocusedCard()?.dataset.filename, index: State.keepFocusPosition ? State.focusedCardIndex : -1 }
        : null;
    State.keepFocusPosition = false;
    State.focusedCardIndex = -1;
    Elements.imageGrid.innerHTML = '';
    if (!State.filteredImages.length) {
        let title = 'No files found';
        let detail = 'Upload images or videos to start organizing your library.';
        const showUploadCta = State.images.length === 0 && State.activeTags.size === 0 && State.excludeTags.size === 0 && !State.showFavoritesOnly && !State.showUntaggedOnly;
        if (State.activeTags.size > 0 || State.excludeTags.size > 0) {
            const parts = [];
            if (State.activeTags.size > 0) parts.push([...State.activeTags].map(t => `"${esc(t)}"`).join(' + '));
            if (State.excludeTags.size > 0) parts.push([...State.excludeTags].map(t => `&minus;"${esc(t)}"`).join(' '));
            title = `No files matching ${parts.join(' ')}`;
            detail = 'Remove a filter or try a different tag expression.';
        }
        else if (State.showFavoritesOnly) {
            title = 'No favorites yet';
            detail = 'Favorite files with the star action to collect them here.';
        }
        else if (State.showUntaggedOnly) {
            title = 'All files are tagged';
            detail = 'The untagged filter will show files again when one has no tags.';
        }
        Elements.imageGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-panel">
                    <p>${title}</p>
                    <span>${detail}</span>
                    ${showUploadCta ? '<button type="button" class="btn btn-primary btn-small" id="emptyUploadBtn">Upload files</button>' : ''}
                </div>
            </div>
        `;
        document.getElementById('emptyUploadBtn')?.addEventListener('click', () => Elements.imageInput.click());
        if (prevFocus) clearCardFocus();
        return;
    }

    const filteredIndex = new Map(State.filteredImages.map((img, i) => [img.filename, i]));

    // applyFilters keeps each group's visible members next to each other, so a run of
    // two or more cards from the same group becomes one group block
    const renderList = [];
    for (let i = 0; i < State.filteredImages.length;) {
        const img = State.filteredImages[i];
        const gid = State.filenameToGroup[img.filename];
        let end = i + 1;
        while (gid && end < State.filteredImages.length && State.filenameToGroup[State.filteredImages[end].filename] === gid) end++;
        if (end - i >= 2) {
            renderList.push({ type: 'group', groupId: gid, members: State.filteredImages.slice(i, end) });
        } else {
            renderList.push({ type: 'image', img });
        }
        i = end;
    }

    renderList.forEach(item => {
        if (item.type === 'image') {
            const idx = filteredIndex.get(item.img.filename) ?? -1;
            const card = createImageCard(item.img, idx);
            Elements.imageGrid.appendChild(card);
            resizeMasonryItem(card);
        } else {
            const groupEl = createGroupContainer(item.groupId, item.members, filteredIndex);
            Elements.imageGrid.appendChild(groupEl);
            // Defer resize to after images load
            const imgs = groupEl.querySelectorAll('img[loading="lazy"]');
            let loaded = 0;
            const onLoad = () => {
                loaded++;
                if (loaded >= imgs.length) resizeGroupItem(groupEl);
            };
            imgs.forEach(i => {
                if (i.complete) { loaded++; } else { i.addEventListener('load', onLoad, { once: true }); }
            });
            if (loaded >= imgs.length) resizeGroupItem(groupEl);
        }
    });
    if (prevFocus) restoreCardFocus(prevFocus.filename, prevFocus.index);
    llmQueueUpdateUI();
}

async function handleCardClick(e, img, idx, card) {
    if (State.selectionMode) {
        // Only toggle the selection; keep the hidden download link from firing
        e.preventDefault();
        toggleImageSelection(img.filename, card);
        return;
    }

    const star = e.target.closest('.star-btn');
    if (star) {
        const isFav = await toggleFavorite(img.filename);
        updateLocalState(img.filename, { is_favorite: isFav });
        return;
    }

    const titleText = e.target.closest('.card-title-text');
    if (titleText) {
        startInlineRename(img, titleText, card);
        return;
    }

    const addTagBtn = e.target.closest('.btn-add-tag');
    if (addTagBtn) { openGalleryTagFlyup(img); return; }

    if (e.target.closest('.delete-btn')) { deleteImage(idx); return; }
    if (!e.target.closest('.card-action-btn')) openLightbox(idx);
}

function resizeMasonryItem(item) {
    if (!item) return;
    const grid = Elements.imageGrid;
    const style = window.getComputedStyle(grid);
    const rowHeight = parseInt(style.getPropertyValue('grid-auto-rows')) || 10;
    const img = item.querySelector('img');
    
    if (img.getBoundingClientRect().height === 0) return;

    const contentHeight = img.getBoundingClientRect().height;
    const itemStyle = window.getComputedStyle(item);
    const margin = parseInt(itemStyle.getPropertyValue('margin-bottom')) || 0;

    const rowSpan = Math.ceil((contentHeight + margin) / rowHeight);
    item.style.gridRowEnd = `span ${rowSpan}`;
}

export function resizeAllMasonryItems() {
    document.querySelectorAll('.image-grid > .image-card').forEach(item => resizeMasonryItem(item));
    document.querySelectorAll('.image-group').forEach(item => resizeGroupItem(item));
}

export function initGrid() {
    // Re-flow the masonry layout whenever the grid's size changes
    new ResizeObserver(resizeAllMasonryItems).observe(Elements.imageGrid);
}
