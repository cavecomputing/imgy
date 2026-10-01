/** Arrow-key focus movement between gallery cards, including into and out of groups. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { deleteImage } from './actions.js';

function findNearestVisibleCardIndex() {
    const cards = Elements.imageGrid.querySelectorAll('.image-card');
    if (!cards.length) return -1;
    const viewTop = window.scrollY;
    const viewLeft = window.scrollX;
    let bestIdx = 0, bestDist = Infinity;
    cards.forEach((card, i) => {
        const rect = card.getBoundingClientRect();
        const absTop = rect.top + window.scrollY;
        const absLeft = rect.left + window.scrollX;
        if (absTop + rect.height < viewTop) return;
        const dist = Math.abs(absTop - viewTop) + Math.abs(absLeft - viewLeft);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    return bestIdx;
}

function focusCard(index, { scroll = true } = {}) {
    const cards = Elements.imageGrid.querySelectorAll('.image-card');
    if (index < 0 || index >= cards.length) return;
    cards.forEach(c => c.classList.remove('keyboard-focused'));
    State.focusedCardIndex = index;
    State.cardFocusActive = true;
    cards[index].classList.add('keyboard-focused');
    if (scroll) cards[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * After a re-render, focus the card showing `filename`. If that file is gone, focus the card now
 * at `fallbackIndex` (used after deleting the focused card), or clear focus when it is -1.
 */
export function restoreCardFocus(filename, fallbackIndex = -1) {
    const cards = [...Elements.imageGrid.querySelectorAll('.image-card')];
    const match = cards.findIndex(c => c.dataset.filename === filename);
    if (match !== -1) focusCard(match, { scroll: false });
    else if (fallbackIndex >= 0 && cards.length) focusCard(Math.min(fallbackIndex, cards.length - 1));
    else clearCardFocus();
}

export function clearCardFocus() {
    State.focusedCardIndex = -1;
    State.cardFocusActive = false;
    Elements.imageGrid.querySelectorAll('.keyboard-focused').forEach(c => c.classList.remove('keyboard-focused'));
}

export function getFocusedCard() {
    const cards = Elements.imageGrid.querySelectorAll('.image-card');
    return cards[State.focusedCardIndex] || null;
}

export function getFocusedFilteredIndex() {
    const card = getFocusedCard();
    return card ? parseInt(card.dataset.idx, 10) : -1;
}

export function getFocusedImage() {
    const idx = getFocusedFilteredIndex();
    return idx >= 0 ? State.filteredImages[idx] : null;
}

function focusCardElement(targetCard) {
    const allCards = Elements.imageGrid.querySelectorAll('.image-card');
    const targetIdx = Array.from(allCards).indexOf(targetCard);
    if (targetIdx !== -1) focusCard(targetIdx);
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
    const allCards = Elements.imageGrid.querySelectorAll('.image-card');
    if (!allCards.length) return;

    // If no focus or focused card is off-screen, start from nearest visible card
    if (State.focusedCardIndex === -1 || State.focusedCardIndex >= allCards.length) {
        focusCard(findNearestVisibleCardIndex());
        return;
    }
    const focusedRect = allCards[State.focusedCardIndex].getBoundingClientRect();
    const viewH = window.innerHeight;
    if (focusedRect.bottom < -100 || focusedRect.top > viewH + 100) {
        focusCard(findNearestVisibleCardIndex());
        return;
    }

    const currentCard = allCards[State.focusedCardIndex];
    const group = currentCard.closest('.image-group');
    const groupTarget = group ? findDirectionalElement(currentCard, direction, {
        scope: group,
        requireHorizontalOverlap: true
    }) : null;
    if (groupTarget) {
        focusCardElement(groupTarget);
        return;
    }

    const target = findDirectionalTopLevelTarget(currentCard, direction, group);
    if (!target) return;
    if (target.classList.contains('image-group')) {
        const entryCard = findGroupEntryCard(target, direction, currentCard);
        if (entryCard) focusCardElement(entryCard);
        return;
    }
    focusCardElement(target);
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
