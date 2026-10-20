/** Gallery grid: image cards, groups, the masonry layout, and the library count above it. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, getDisplayFilename, getExtension, getImageBaseName, isVideo } from './utils.js';
import { showToast } from './ui.js';
import { api } from './api.js';
import { reloadDataPreservingScroll } from './data.js';
import { startInlineRename } from './rename.js';
import { clearCardFocus, restoreCardFocus } from './navigation.js';
import { toggleImageSelection } from './selection.js';
import { deleteImage, toggleFavorite, updateLocalState } from './actions.js';
import { openGalleryTagFlyup } from './flyup.js';
import { openLightbox } from './lightbox.js';
import { llmQueueUpdateUI } from './llm.js';

const BATCH = 60;         // files drawn at a time, so a big library opens as fast as a small one
const PRELOAD_PX = 1500;  // the next batch is drawn when the end of the grid is this close to the bottom of the window
const KEEP_PX = 1500;     // cards further than this above or below the window are taken out of the page
const ROW_PX = 4;         // block heights round up to whole rows of this, so equal cards tie and the leftmost column wins

const icon = (name, cls = 'i i-sm') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let renderedCount = 0; // the blocks hold the first renderedCount of State.filteredImages
// Each top-level card or group, in display order: { files, first (index in State.filteredImages),
// height (margin included), col, top, el }. Only those near the window have an element (el); the rest keep their
// place, so a deep gallery costs no more to scroll, hover or redraw than a short one.
let blocks = [];
let gridHeight = 0;         // the blocks' height, which layoutBlocks() gives the grid
const heights = new Map();  // measured block heights, margin included, by blockKey(), for the current column width
let columnTracks = '';      // the grid's column sizes the heights were measured at

const blockKey = (block) => block.files.map(img => img.thumbnail_url).join('\n');
const cardsOf = (el) => el.matches('.image-card') ? [el] : [...el.querySelectorAll('.image-card')];
/** The height an element takes up in its column, its bottom margin included (cards and groups differ on phones). */
const outerHeight = (el) => el.getBoundingClientRect().height + (parseFloat(window.getComputedStyle(el).marginBottom) || 0);

function createCardFootMeta(tags = []) {
    if (!tags.length) return `<button class="card-tag-btn tag-btn card-untagged" type="button" aria-label="Edit tags">${icon('tag-off', 'i i-xs')}<span class="cc-badge cc-badge--warn">Untagged</span></button>`;
    return `<button class="card-tag-btn tag-btn" type="button" aria-label="Edit tags, ${formatCount(tags.length, 'tag')}">${icon('tag', 'i i-xs')}${tags.length}</button>`;
}

function createImageCard(img, idx) {
    const card = document.createElement('div');
    const isSelected = State.selectedImages.has(img.filename);
    const isFocused = State.cardFocusActive && idx === State.focusedCardIndex;
    card.className = `image-card${img.is_favorite ? ' is-fav' : ''}${isSelected ? ' selected' : ''}${isFocused ? ' keyboard-focused' : ''}`;
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
                <a class="card-action-btn" href="${esc(img.url)}" download="${esc(getDisplayFilename(img.filename))}" title="Download" aria-label="Download">${icon('download')}</a>
                <button class="card-action-btn delete-btn" type="button" title="Move to trash (D)" aria-label="Move to trash">${icon('trash')}</button>
            </div>
        </div>
        <div class="card-foot">
            <span class="card-title"><span class="card-title-text" title="Rename (R)">${esc(baseName)}</span><span class="card-ext">${esc(ext)}</span></span>
            <svg class="card-star" role="img" aria-label="Favorite"><use href="#i-star"/></svg>
            ${createCardFootMeta(img.tags || [])}
        </div>
    `;

    // Re-measure once the thumbnail settles. A broken one draws at a different height than
    // the shape reserved for it, so it needs this as much as one that loads.
    const remeasure = () => remeasureSoon(card.closest('.image-group') || card);
    const thumb = card.querySelector('img');
    thumb.addEventListener('load', remeasure);
    thumb.addEventListener('error', remeasure);
    card.addEventListener('click', (e) => handleCardClick(e, img, card));
    card.drawnTags = (img.tags || []).join('\n');
    return card;
}

/** Redraw the part of a card that shows its tags. */
function refreshCardTags(card, tags) {
    card.drawnTags = tags.join('\n');
    const foot = card.querySelector('.card-foot');
    foot.lastElementChild.remove();
    foot.insertAdjacentHTML('beforeend', createCardFootMeta(tags));
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

/** Give a block its element, placed where layoutBlocks() put it. */
function createBlock(block) {
    const { files, first } = block;
    block.el = files.length > 1 ? createGroupContainer(State.filenameToGroup[files[0].filename], files, first) : createImageCard(files[0], first);
    block.el.block = block;
    placeElement(block);
    return block.el;
}

function placeElement({ el, col, top }) {
    el.style.gridColumn = `${col + 1} / span 1`; // an absolutely placed item's auto end would be the grid's edge
    el.style.top = `${top}px`;
}

/** Draw the blocks whose height is not known yet and measure them, all sizes read before any is stored. */
function measureBlocks(fresh) {
    if (!fresh.length) return;
    Elements.imageGrid.append(...fresh.map(block => block.el ?? createBlock(block)));
    const sizes = fresh.map(block => outerHeight(block.el));
    fresh.forEach((block, i) => heights.set(blockKey(block), sizes[i]));
}

/**
 * Masonry: each block goes to the top of the shortest column, the leftmost of equals. Its place
 * depends only on the blocks before it, and tops never decrease along the list.
 */
function layoutBlocks() {
    const grid = Elements.imageGrid;
    const columns = Math.max(1, window.getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    const bottoms = new Array(columns).fill(0);
    for (const block of blocks) {
        block.col = bottoms.indexOf(Math.min(...bottoms));
        block.top = bottoms[block.col];
        bottoms[block.col] += Math.ceil(block.height / ROW_PX) * ROW_PX;
        if (block.el) placeElement(block);
    }
    gridHeight = blocks.length ? Math.max(...bottoms) : 0;
    grid.style.height = blocks.length ? `${gridHeight}px` : '';
}

/**
 * Put the blocks within KEEP_PX of the window, or of the keyboard-focused card (arrow keys can
 * outrun the smooth scroll to it), into the page in display order, and take the others out.
 * While a card is dragged nothing is taken out, and neither is a block holding focus.
 */
function updateWindow() {
    if (!blocks.length) return;
    const grid = Elements.imageGrid;
    const gridTop = grid.getBoundingClientRect().top;
    const spans = [[-gridTop - KEEP_PX, -gridTop + window.innerHeight + KEEP_PX]];
    const index = State.cardFocusActive ? State.focusedCardIndex : -1;
    const focused = blocks.find(block => block.first <= index && index < block.first + block.files.length);
    if (focused) spans.push([focused.top - KEEP_PX, focused.top + focused.height + KEEP_PX]);
    const keepAll = document.body.classList.contains('is-reordering');
    let previous = null;
    let added = false;
    for (const block of blocks) {
        if (spans.some(([from, to]) => block.top < to && block.top + block.height > from)) {
            if (!block.el) {
                createBlock(block);
                previous ? previous.after(block.el) : grid.prepend(block.el);
                added = true;
            }
        } else if (block.el && !keepAll && !block.el.contains(document.activeElement)) {
            block.el.remove();
            block.el = null;
        }
        if (block.el) previous = block.el;
    }
    if (added) llmQueueUpdateUI();
}

let windowFrame = 0;
function updateWindowSoon() {
    if (!windowFrame) windowFrame = requestAnimationFrame(() => { windowFrame = 0; updateWindow(); });
}

// Blocks whose thumbnails settled, measured together before the next frame. A thumbnail without
// a known size (some videos) changes its card's height when it arrives.
const settled = new Set();
function remeasureSoon(el) {
    if (!settled.size) requestAnimationFrame(() => {
        const drawn = [...settled].filter(el => el.block?.el === el);
        settled.clear();
        const sizes = drawn.map(outerHeight);
        const changed = drawn.filter((el, i) => sizes[i] && sizes[i] !== el.block.height);
        drawn.forEach((el, i) => {
            if (!sizes[i]) return;
            el.block.height = sizes[i];
            heights.set(blockKey(el.block), sizes[i]);
        });
        if (changed.length) { layoutBlocks(); updateWindow(); }
    });
    settled.add(el);
}

/** Lay the gallery out again when its columns change size: every height is measured again. */
export function resizeAllMasonryItems() {
    const tracks = window.getComputedStyle(Elements.imageGrid).gridTemplateColumns;
    if (tracks === columnTracks) return;
    columnTracks = tracks;
    heights.clear();
    if (blocks.length) renderImageGrid();
}

/** Number each drawn card by its place in the blocks, which is its place in State.filteredImages. */
function renumberCards() {
    let first = 0;
    for (const block of blocks) {
        block.first = first;
        if (block.el) cardsOf(block.el).forEach((card, i) => { card.dataset.idx = first + i; });
        first += block.files.length;
    }
}

/** After reorder.js moved drawn blocks in the page, give them that order in the layout too. */
export function syncGridOrder() {
    const order = [...Elements.imageGrid.children].map(el => el.block).filter(Boolean);
    let i = 0;
    blocks = blocks.map(block => block.el ? order[i++] : block);
    layoutBlocks();
}

/**
 * The names of every file the blocks hold, in the order the user dragged them into (a group's
 * members in the order its drawn cards now have), with the drawn cards renumbered to match.
 */
export function drawnOrder() {
    for (const block of blocks) {
        if (block.el && block.files.length > 1) block.files = cardsOf(block.el).map(card => State.imagesByFilename.get(card.dataset.filename));
    }
    renumberCards();
    return blocks.flatMap(block => block.files.map(img => img.filename));
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
    } else if (State.showFavoritesOnly && State.showUntaggedOnly && State.images.some(img => img.is_favorite)) {
        title = 'No untagged favorites';
        detail = 'Every favorite has tags. Turn off Untagged to see them.';
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
    const added = [];
    for (let i = renderedCount; i < end;) {
        const gid = groupOf(i);
        let next = i + 1;
        while (gid && next < end && groupOf(next) === gid) next++;
        added.push({ files: files.slice(i, next), first: i, height: 0, col: 0, top: 0, el: null });
        i = next;
    }
    renderedCount = end;
    blocks.push(...added);
    measureBlocks(added.filter(block => !heights.has(blockKey(block))));
    added.forEach(block => { block.height = heights.get(blockKey(block)); });
    layoutBlocks();
    updateWindow();
    // observe() reports the end's position right away, so a batch that leaves it in reach brings the next
    gridEndObserver.unobserve(Elements.gridEnd);
    gridEndObserver.observe(Elements.gridEnd);
}

/**
 * Bring the blocks up to date without rebuilding them, when the files shown are the same as
 * `previous` or the same minus some top-level cards (a trashed file, a tag edit that moves a file
 * out of the filter). Only a card's tags can have changed then. Returns false when the grid needs
 * a rebuild: files were added or moved, or a removed card sits in a group.
 */
function updateInPlace(previous) {
    const next = State.filteredImages;
    if (!next.length || !previous.length || !blocks.length) return false;
    const shown = new Set(next);
    const kept = blocks.filter(block => block.files.length > 1 || shown.has(block.files[0]));
    let i = 0;
    for (const block of kept) {
        for (const img of block.files) if (img !== next[i++]) return false;
    }

    const keptSet = new Set(kept);
    blocks.forEach(block => { if (!keptSet.has(block)) block.el?.remove(); });
    blocks = kept;
    renderedCount = i;
    renumberCards();
    layoutBlocks();
    updateWindow();
    for (const card of Elements.imageGrid.querySelectorAll('.image-card')) {
        const tags = State.imagesByFilename.get(card.dataset.filename)?.tags || [];
        if (card.drawnTags !== tags.join('\n')) refreshCardTags(card, tags);
    }
    return true;
}

/** Draw State.filteredImages. `previous` is what the grid was drawn from, so a small change can skip the rebuild. */
export function renderImageGrid(previous = []) {
    // The redraw has to reach down to where the page is scrolled, or the scroll would be clamped
    const reach = window.scrollY + window.innerHeight + PRELOAD_PX;
    // Remember the keyboard-focused card so the rebuilt grid can focus it again
    const prevFocus = State.cardFocusActive
        ? { filename: (previous.length ? previous : State.filteredImages)[State.focusedCardIndex]?.filename, index: State.keepFocusPosition ? State.focusedCardIndex : -1 }
        : null;
    State.keepFocusPosition = false;
    State.focusedCardIndex = -1;
    renderLibraryCount();
    const grid = Elements.imageGrid;
    if (!updateInPlace(previous)) {
        // Keep the page as tall as it was while the blocks come back, so the scroll position, which
        // decides which blocks go into the page, stays where it is
        grid.style.minHeight = grid.style.height;
        grid.innerHTML = '';
        blocks = [];
        renderedCount = 0;
        layoutBlocks();
        if (!State.filteredImages.length) {
            grid.style.minHeight = '';
            renderEmptyState();
            if (prevFocus) clearCardFocus();
            return;
        }
        renderNextBatch();
    }
    while (renderedCount < State.filteredImages.length
        && grid.getBoundingClientRect().top + window.scrollY + gridHeight < reach) renderNextBatch();
    grid.style.minHeight = '';
    updateWindow();

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
    // A card's buttons show for keyboard focus on one of them. This class does what
    // :has(.card-action-btn:focus-visible) did, which slowed every redraw down.
    Elements.imageGrid.addEventListener('focusin', (e) => {
        e.target.closest('.card-actions')?.classList.toggle('shown', e.target.matches(':focus-visible'));
    });
    Elements.imageGrid.addEventListener('focusout', (e) => e.target.closest('.card-actions')?.classList.remove('shown'));

    // Lay the blocks out again whenever the grid's width changes, and follow the window with them
    new ResizeObserver(resizeAllMasonryItems).observe(Elements.imageGrid);
    window.addEventListener('scroll', updateWindowSoon, { passive: true });
    window.addEventListener('resize', updateWindowSoon);
}
