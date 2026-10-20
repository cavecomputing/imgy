/** Arrow-key focus movement between gallery cards, including into and out of groups. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { CONFIG } from './config.js';
import { deleteImage } from './actions.js';

let scrolledAt = 0; // when focusCard last started scrolling a card into view

/** The card nearest the top of the window, or null when none is drawn. */
function findNearestVisibleCard() {
    let best = null, bestDist = Infinity;
    for (const card of Elements.imageGrid.querySelectorAll('.image-card')) {
        const rect = card.getBoundingClientRect();
        if (rect.bottom < 0) continue;
        const dist = Math.abs(rect.top) + Math.abs(rect.left);
        if (dist < bestDist) { bestDist = dist; best = card; }
    }
    return best;
}

/**
 * Focus the file at `index` in State.filteredImages. State.focusedCardIndex keeps that index, not
 * a card: the grid takes cards far from the window out of the page and draws them again later.
 */
function focusIndex(index, { scroll = true } = {}) {
    clearCardFocus();
    State.focusedCardIndex = index;
    State.cardFocusActive = true;
    const card = getFocusedCard();
    if (!card) return;
    card.classList.add('keyboard-focused');
    if (scroll) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        scrolledAt = performance.now();
    }
}

function focusCard(card) {
    if (card) focusIndex(Number(card.dataset.idx));
}

/**
 * After a re-render, focus the card showing `filename`. If that file is gone, focus the card now
 * at `fallbackIndex` (used after deleting the focused card), or clear focus when it is -1.
 */
export function restoreCardFocus(filename, fallbackIndex = -1) {
    const files = State.filteredImages;
    const match = files.findIndex(img => img.filename === filename);
    if (match !== -1) focusIndex(match, { scroll: false });
    else if (fallbackIndex >= 0 && files.length) focusIndex(Math.min(fallbackIndex, files.length - 1));
    else clearCardFocus();
}

export function clearCardFocus() {
    State.focusedCardIndex = -1;
    State.cardFocusActive = false;
    Elements.imageGrid.querySelectorAll('.keyboard-focused').forEach(c => c.classList.remove('keyboard-focused'));
}

/** The focused file's card, or null when it isn't drawn. */
export function getFocusedCard() {
    if (State.focusedCardIndex < 0) return null;
    return Elements.imageGrid.querySelector(`.image-card[data-idx="${State.focusedCardIndex}"]:not(.drag-ghost)`);
}

export function getFocusedFilteredIndex() {
    return State.focusedCardIndex < State.filteredImages.length ? State.focusedCardIndex : -1;
}

export function getFocusedImage() {
    const idx = getFocusedFilteredIndex();
    return idx >= 0 ? State.filteredImages[idx] : null;
}

function getRectMetrics(el) {
    const rect = el.getBoundingClientRect();
    return {
        rect,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2
    };
}

function getAxisOverlap(a, b, axis) {
    if (axis === 'x') return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function scoreDirectionalCandidate(origin, candidate, direction) {
    const o = origin.rect;
    const c = candidate.rect;
    const EPSILON = 1;
    let primary = 0;
    let perpendicular = 0;
    let overlap = 0;

    if (direction === 'left') {
        if (candidate.centerX >= origin.centerX - EPSILON) return null;
        primary = Math.max(0, o.left - c.right);
        perpendicular = Math.abs(candidate.centerY - origin.centerY);
        overlap = getAxisOverlap(o, c, 'y');
    } else if (direction === 'right') {
        if (candidate.centerX <= origin.centerX + EPSILON) return null;
        primary = Math.max(0, c.left - o.right);
        perpendicular = Math.abs(candidate.centerY - origin.centerY);
        overlap = getAxisOverlap(o, c, 'y');
    } else if (direction === 'up') {
        if (candidate.centerY >= origin.centerY - EPSILON) return null;
        primary = Math.max(0, o.top - c.bottom);
        perpendicular = Math.abs(candidate.centerX - origin.centerX);
        overlap = getAxisOverlap(o, c, 'x');
    } else if (direction === 'down') {
        if (candidate.centerY <= origin.centerY + EPSILON) return null;
        primary = Math.max(0, c.top - o.bottom);
        perpendicular = Math.abs(candidate.centerX - origin.centerX);
        overlap = getAxisOverlap(o, c, 'x');
    } else {
        return null;
    }

    const overlapBonus = overlap > 0 ? Math.min(overlap, 80) : 0;
    return (primary * 8) + perpendicular - overlapBonus;
}

function findDirectionalElement(originEl, direction, options = {}) {
    const scope = options.scope || Elements.imageGrid;
    const selector = options.selector || '.image-card';
    const candidates = Array.from(scope.querySelectorAll(selector))
        .filter(el => {
            if (el === originEl) return false;
            if (options.excludeGroup && (el === options.excludeGroup || el.closest('.image-group') === options.excludeGroup)) return false;
            return true;
        });
    if (!candidates.length) return null;

    const origin = getRectMetrics(originEl);
    let best = null;
    let bestScore = Infinity;

    candidates.forEach(el => {
        const candidate = getRectMetrics(el);
        if (candidate.rect.width === 0 || candidate.rect.height === 0) return;
        if (options.requireHorizontalOverlap && ['left', 'right'].includes(direction)) {
            if (getAxisOverlap(origin.rect, candidate.rect, 'y') === 0) return;
        }
        const score = scoreDirectionalCandidate(origin, candidate, direction);
        if (score === null) return;
        if (score < bestScore) {
            best = el;
            bestScore = score;
        }
    });

    return best;
}

function findDirectionalTopLevelTarget(originCard, direction, excludeGroup) {
    return findDirectionalElement(originCard, direction, {
        excludeGroup,
        selector: ':scope > .image-card, :scope > .image-group'
    });
}

function findGroupEntryCard(group, direction, originCard) {
    const directional = findDirectionalElement(originCard, direction, { scope: group });
    if (directional) return directional;

    const origin = getRectMetrics(originCard);
    const groupCards = Array.from(group.querySelectorAll('.image-card'));
    let best = null;
    let bestDist = Infinity;
    groupCards.forEach(card => {
        const candidate = getRectMetrics(card);
        const dist = Math.abs(candidate.centerX - origin.centerX) + Math.abs(candidate.centerY - origin.centerY);
        if (dist < bestDist) {
            best = card;
            bestDist = dist;
        }
    });
    return best;
}

export function navigateGrid(direction) {
    // If no focus or the focused card is off-screen, start from the nearest visible card
    const currentCard = getFocusedCard();
    if (!currentCard) {
        focusCard(findNearestVisibleCard());
        return;
    }
    // Unless it was focused a moment ago, and is off-screen only until the smooth scroll arrives
    const focusedRect = currentCard.getBoundingClientRect();
    const viewH = window.innerHeight;
    const scrollSettled = performance.now() - scrolledAt > CONFIG.FOCUS_SCROLL_MS;
    if (scrollSettled && (focusedRect.bottom < -100 || focusedRect.top > viewH + 100)) {
        focusCard(findNearestVisibleCard());
        return;
    }

    const group = currentCard.closest('.image-group');
    const groupTarget = group ? findDirectionalElement(currentCard, direction, {
        scope: group,
        requireHorizontalOverlap: true
    }) : null;
    if (groupTarget) {
        focusCard(groupTarget);
        return;
    }

    const target = findDirectionalTopLevelTarget(currentCard, direction, group);
    if (!target) return;
    if (target.classList.contains('image-group')) {
        const entryCard = findGroupEntryCard(target, direction, currentCard);
        if (entryCard) focusCard(entryCard);
        return;
    }
    focusCard(target);
}

export function deleteSelectedOrFocusedImage() {
    if (State.selectedImages.size > 0) {
        Elements.deleteSelectedBtn.click();
        return;
    }
    if (!State.cardFocusActive) return;
    const fi = getFocusedFilteredIndex();
    if (fi >= 0) deleteImage(fi);
}
