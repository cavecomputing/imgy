/** Gallery grid: image cards, groups, the masonry layout, and the library count above it. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, getDisplayFilename, getExtension, getImageBaseName, isVideo } from './utils.js';
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

const BATCH = 60;         // files drawn at a time, so a big library opens as fast as a small one
const PRELOAD_PX = 1500;  // the next batch is drawn when the end of the grid is this close to the bottom of the window

const icon = (name, cls = 'i i-sm') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let renderedCount = 0; // the grid holds cards for the first renderedCount of State.filteredImages

function createCardTagPreview(tags = []) {
    if (!tags.length) return '';
    const visible = tags.slice(0, 3);
    const overflow = tags.length - visible.length;
    return `
        <div class="card-tag-preview" aria-hidden="true">
            ${visible.map(t => `<span>${esc(t)}</span>`).join('')}
            ${overflow > 0 ? `<span>+${overflow}</span>` : ''}
        </div>
    `;
}

function createCardFootMeta(tags = []) {
    if (!tags.length) return '<span class="cc-badge cc-badge--warn">Untagged</span>';
    const title = `${formatCount(tags.length, 'tag')}: ${tags.join(', ')}`;
    return `<span class="card-tag-count" title="${esc(title)}">${icon('tag', 'i i-xs')}${tags.length}<span class="sr-only"> ${tags.length === 1 ? 'tag' : 'tags'}</span></span>`;
}

function createImageCard(img, idx) {
    const card = document.createElement('div');
    const isSelected = State.selectedImages.has(img.filename);
    card.className = `image-card${img.is_favorite ? ' is-fav' : ''}${isSelected ? ' selected' : ''}`;
    card.dataset.filename = img.filename;
    card.dataset.idx = idx;

    const baseName = getImageBaseName(img.filename);
    const ext = getExtension(img.filename);
    const video = isVideo(img.filename);
    // Width and height let the browser reserve the thumbnail's shape before it loads,
    // so the masonry spans are right on the first pass
    const size = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : '';

    card.innerHTML = `
        <div class="card-media">
            <img src="${esc(img.thumbnail_url)}"${size} alt="${esc(baseName)}" loading="lazy" draggable="false">
            ${video ? `<span class="card-play">${icon('play', 'i')}${esc(ext.slice(1).toUpperCase())}</span>` : ''}
            <span class="card-check" aria-hidden="true">${icon('check', 'i')}</span>
            <div class="card-actions">
                <button class="card-action-btn star-btn" type="button" title="Favorite (F)" aria-label="Favorite" aria-pressed="${img.is_favorite ? 'true' : 'false'}">${icon('star')}</button>
                <button class="card-action-btn tag-btn" type="button" title="Edit tags (T)" aria-label="Edit tags">${icon('tag')}</button>
                <a class="card-action-btn" href="${esc(img.url)}" download="${esc(getDisplayFilename(img.filename))}" title="Download" aria-label="Download">${icon('download')}</a>
                <button class="card-action-btn delete-btn" type="button" title="Move to trash (D)" aria-label="Move to trash">${icon('trash')}</button>
            </div>
            ${createCardTagPreview(img.tags || [])}
        </div>
        <div class="card-foot">
            <span class="card-title"><span class="card-title-text" title="Rename (R)">${esc(baseName)}</span><span class="card-ext">${esc(ext)}</span></span>
            <svg class="card-star" role="img" aria-label="Favorite"><use href="#i-star"/></svg>
            ${createCardFootMeta(img.tags || [])}
        </div>
    `;

    // Re-measure once the thumbnail settles. A broken one draws at a different height than
    // the shape reserved for it, so it needs this as much as one that loads.
    const remeasure = () => setRowSpans([card.closest('.image-group') || card]);
    const thumb = card.querySelector('img');
    thumb.addEventListener('load', remeasure);
    thumb.addEventListener('error', remeasure);
    card.addEventListener('click', (e) => handleCardClick(e, img, card));
    return card;
}

function createGroupContainer(groupId, members, firstIndex) {
    const groupEl = document.createElement('div');
    groupEl.className = 'image-group';
    groupEl.dataset.groupId = groupId;

    const header = document.createElement('div');
    header.className = 'image-group-header';
    header.innerHTML = `
        <span class="image-group-badge">${icon('grid')}<strong>${formatCount(members.length, 'file')}</strong></span>
        <button class="link-btn image-group-ungroup" type="button" title="Keep the files, drop the group">Ungroup</button>
    `;
    header.querySelector('.image-group-ungroup').addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.delete(`/api/groups/${encodeURIComponent(groupId)}`);
        showToast('Group removed');
        await reloadDataPreservingScroll();
    });
    groupEl.appendChild(header);

    const innerGrid = document.createElement('div');
    innerGrid.className = 'image-group-grid';
    members.forEach((img, i) => innerGrid.appendChild(createImageCard(img, firstIndex + i)));
    groupEl.appendChild(innerGrid);
    return groupEl;
}

/**
 * Masonry: each top-level card or group spans as many 4px grid rows as its height plus its
 * bottom margin needs. All sizes are read before any span is written, so a full re-flow
 * costs one layout instead of one per card.
 */
function setRowSpans(items) {
    if (!items.length) return;
    const rowHeight = parseFloat(window.getComputedStyle(Elements.imageGrid).getPropertyValue('grid-auto-rows')) || 4;
    const sizes = items.map(item => ({
        height: item.getBoundingClientRect().height,
        margin: parseFloat(window.getComputedStyle(item).getPropertyValue('margin-bottom')) || 0
    }));
    items.forEach((item, i) => {
        const { height, margin } = sizes[i];
        if (height > 0) item.style.gridRowEnd = `span ${Math.ceil((height + margin) / rowHeight)}`;
    });
}

export function resizeAllMasonryItems() {
    setRowSpans([...Elements.imageGrid.querySelectorAll(':scope > .image-card, :scope > .image-group')]);
}

function hasActiveFilters() {
    return State.activeTags.size > 0 || State.excludeTags.size > 0 || State.nameTerms.size > 0 || State.showFavoritesOnly || State.showUntaggedOnly;
}

/** The line above the grid: library totals, how many files the filters leave, or the selection. */
export function renderLibraryCount() {
    const el = Elements.libraryCount;
    if (!el) return;
    const total = State.images.length;
    const shown = State.filteredImages.length;
    // Phones hide the .lib-count-* parts to fit next to the toggles
    if (State.selectionMode) {
        el.innerHTML = `<strong>${State.selectedImages.size}</strong><span class="lib-count-total"> of ${shown}</span> selected`;
    } else if (hasActiveFilters()) {
        el.innerHTML = `<strong>${shown}</strong> of ${total}<span class="lib-count-unit"> ${total === 1 ? 'file' : 'files'}</span>`;
    } else {
        const untagged = State.images.filter(img => !img.tags?.length).length;
        const favorites = State.images.filter(img => img.is_favorite).length;
        const extra = [];
        if (untagged) extra.push(`${untagged} untagged`);
        if (favorites) extra.push(formatCount(favorites, 'favorite'));
        el.innerHTML = `<strong>${total}</strong> ${total === 1 ? 'file' : 'files'}`
            + (extra.length ? `<span class="lib-count-extra"> · ${extra.join(' · ')}</span>` : '');
    }
}

function renderEmptyState() {
    let title = 'No files yet';
    let detail = 'Upload images or videos, or copy them into the library folder, to start organizing.';
    const showUploadCta = State.images.length === 0 && !hasActiveFilters();
    if (State.activeTags.size > 0 || State.excludeTags.size > 0 || State.nameTerms.size > 0) {
        const parts = [];
        if (State.activeTags.size > 0) parts.push([...State.activeTags].map(t => `“${esc(t)}”`).join(' and '));
        if (State.excludeTags.size > 0) parts.push([...State.excludeTags].map(t => `not “${esc(t)}”`).join(', '));
        if (State.nameTerms.size > 0) parts.push([...State.nameTerms].map(t => `name “${esc(t)}”`).join(', '));
        title = `No files match ${parts.join(', ')}`;
        detail = 'Remove a filter or try a different tag.';
    } else if (State.showFavoritesOnly) {
        title = 'No favorites yet';
        detail = 'Star a file to collect it here.';
    } else if (State.showUntaggedOnly) {
        title = 'Every file has tags';
        detail = 'Files show up here again when one has no tags.';
    } else if (State.images.length > 0) {
        title = 'No files to show';
        detail = 'Turn off the filters above to see your library.';
    }
    Elements.imageGrid.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-panel">
                <p>${title}</p>
                <span>${detail}</span>
                ${showUploadCta ? `<button type="button" class="cc-btn cc-btn--primary" id="emptyUploadBtn">${icon('upload')}Upload files</button>` : ''}
            </div>
        </div>
    `;
    document.getElementById('emptyUploadBtn')?.addEventListener('click', () => Elements.imageInput.click());
}

// Draws the next batch once the end of the grid is within PRELOAD_PX of the bottom of the window
const gridEndObserver = new IntersectionObserver(
    (entries) => { if (entries.at(-1).isIntersecting) renderNextBatch(); },
    { rootMargin: `0px 0px ${PRELOAD_PX}px 0px` }
);

/**
 * Draw the next BATCH of State.filteredImages at the end of the grid. A group is always drawn
 * whole, so a batch that would end inside one takes the rest of it along.
 */
function renderNextBatch() {
    const files = State.filteredImages;
    if (renderedCount >= files.length) return;
    const groupOf = (i) => State.filenameToGroup[files[i].filename];
    let end = Math.min(renderedCount + BATCH, files.length);
    while (end < files.length && groupOf(end) && groupOf(end) === groupOf(end - 1)) end++;

    // applyFilters keeps each group's visible members next to each other, so a run of
    // two or more cards from the same group becomes one group block
    const blocks = [];
    for (let i = renderedCount; i < end;) {
        const gid = groupOf(i);
        let next = i + 1;
        while (gid && next < end && groupOf(next) === gid) next++;
        blocks.push(next - i >= 2 ? createGroupContainer(gid, files.slice(i, next), i) : createImageCard(files[i], i));
        i = next;
    }
    renderedCount = end;
    Elements.imageGrid.append(...blocks);
    setRowSpans(blocks);
    llmQueueUpdateUI();
    // observe() reports the end's position right away, so a batch that leaves it in reach brings the next
    gridEndObserver.unobserve(Elements.gridEnd);
    gridEndObserver.observe(Elements.gridEnd);
}

export function renderImageGrid() {
    // The redraw has to reach down to where the page is scrolled, or the scroll would be clamped
    const reach = window.scrollY + window.innerHeight + PRELOAD_PX;
    // Remember the keyboard-focused card so the rebuilt grid can focus it again
    const prevFocus = State.cardFocusActive
        ? { filename: getFocusedCard()?.dataset.filename, index: State.keepFocusPosition ? State.focusedCardIndex : -1 }
        : null;
    State.keepFocusPosition = false;
    State.focusedCardIndex = -1;
    Elements.imageGrid.innerHTML = '';
    renderedCount = 0;
    renderLibraryCount();
    if (!State.filteredImages.length) {
        renderEmptyState();
        if (prevFocus) clearCardFocus();
        return;
    }

    renderNextBatch();
    while (renderedCount < State.filteredImages.length
        && Elements.imageGrid.getBoundingClientRect().bottom + window.scrollY < reach) renderNextBatch();

    if (prevFocus) restoreCardFocus(prevFocus.filename, prevFocus.index);
}

async function handleCardClick(e, img, card) {
    if (e.target.closest('.inline-rename-input')) return;
    const idx = Number(card.dataset.idx); // read now: dragging a card to a new place renumbers them
    // A clicked button keeps focus, and the next key press (an arrow key, say) would make
    // :focus-visible match it and bring the card's buttons back with the pointer elsewhere.
    // Keyboard activations (detail 0) keep focus so Tab carries on from there.
    if (e.detail) e.target.closest('.card-action-btn')?.blur();
    if (State.selectionMode) {
        // Only toggle the selection; keep the download link from firing
        e.preventDefault();
        toggleImageSelection(img.filename, card);
        return;
    }

    if (e.target.closest('.star-btn')) {
        const isFav = await toggleFavorite(img.filename);
        updateLocalState(img.filename, { is_favorite: isFav });
        return;
    }

    const titleText = e.target.closest('.card-title-text');
    if (titleText) {
        startInlineRename(img, titleText, card);
        return;
    }

    if (e.target.closest('.tag-btn')) { openGalleryTagFlyup(img); return; }
    if (e.target.closest('.delete-btn')) { deleteImage(idx); return; }
    if (!e.target.closest('.card-action-btn')) openLightbox(idx);
}

export function initGrid() {
    // Re-flow the masonry layout whenever the grid's width changes. Drawing more cards only makes
    // it taller, and measuring every card again after each batch would slow a deep scroll down.
    let width = 0;
    new ResizeObserver(([entry]) => {
        if (entry.contentRect.width === width) return;
        width = entry.contentRect.width;
        resizeAllMasonryItems();
    }).observe(Elements.imageGrid);
}
