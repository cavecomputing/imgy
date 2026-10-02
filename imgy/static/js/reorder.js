/** Drag a card, or a whole group, to a new place in the gallery while the others slide out of the way. */
import { State } from './state.js';
import { Elements } from './dom.js';
import { saveImageOrder } from './data.js';
import { clearCardFocus } from './navigation.js';

const DRAG_DISTANCE = 5;    // px a mouse travels before a press becomes a drag
const HOLD_MS = 300;        // how long a finger rests on a card to pick it up
const HOLD_DRIFT = 10;      // px a resting finger may drift; further than that it is scrolling
const SWAP_PAUSE_MS = 100;  // least time between moves, so a fast drag doesn't restart every slide on every frame
const SLIDE_MS = 200;
const EDGE_TOP = 120;       // px from the top of the window (the sticky bars cover it) where dragging scrolls up
const EDGE_BOTTOM = 90;
const SCROLL_SPEED = 18;    // px per frame at the very edge
const PLACEABLE = ':is(.image-card, .image-group):not(.drag-ghost)';

let press = null; // a pointer is down on a card or group and may become a drag
let drag = null;  // a card or group is being moved

const placeable = (container) => [...container.children].filter(el => el.matches(PLACEABLE));
const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** An element's box in page coordinates, which stay valid while the page scrolls. */
const pageBox = (el, rect) => ({ el, left: rect.left + scrollX, top: rect.top + scrollY, right: rect.right + scrollX, bottom: rect.bottom + scrollY });

/**
 * Run `move`, which rearranges `items` in the DOM, and slide each one from where it was drawn to
 * where it now sits. Returns where each sits now, which is where the pointer is tested.
 */
function slide(items, move) {
    const drawn = items.map(el => el.getBoundingClientRect()); // includes slides still running
    document.getAnimations().filter(a => a.id === 'slide').forEach(a => a.cancel());
    move();
    const laid = items.map(el => el.getBoundingClientRect());
    if (!prefersReducedMotion()) {
        items.forEach((el, i) => {
            const dx = drawn[i].left - laid[i].left;
            const dy = drawn[i].top - laid[i].top;
            const onScreen = [drawn[i], laid[i]].some(rect => rect.bottom > 0 && rect.top < innerHeight);
            if ((dx || dy) && onScreen) {
                el.animate({ transform: [`translate(${dx}px, ${dy}px)`, 'none'] }, { id: 'slide', duration: SLIDE_MS, easing: 'ease' });
            }
        });
    }
    return items.map((el, i) => pageBox(el, laid[i]));
}

/** Let the ghost land in the dashed slot, then swap it for the real card. */
function settle(ghost, item, slot) {
    const done = () => { ghost.remove(); item.classList.remove('drag-slot'); };
    if (prefersReducedMotion()) return done();
    ghost.animate({
        translate: [ghost.style.translate, `${slot.left - scrollX}px ${slot.top - scrollY}px`],
        scale: [1.03, 1],
    }, { duration: 180, easing: 'ease-out', fill: 'forwards' }).onfinish = done;
}

/** The middle of the floating copy in window coordinates. The item goes to the open place nearest to it. */
const copyCenter = () => ({ x: press.x - drag.grabX + drag.width / 2, y: press.y - drag.grabY + drag.height / 2 });

/** Whether the copy's middle is at a spot not tried yet and outside the slot, with the pointer on the gallery. */
function copyLeftSlot({ x, y }) {
    // Over a sticky bar or off the page, the pointer isn't pointing at the gallery
    if (!document.elementFromPoint(press.x, press.y)?.closest('.gallery')) return false;
    const pageX = x + scrollX;
    const pageY = y + scrollY;
    if (pageX === drag.triedX && pageY === drag.triedY) return false;
    const slot = drag.layout.find(box => box.el === drag.item);
    return !(pageX >= slot.left && pageX < slot.right && pageY >= slot.top && pageY < slot.bottom);
}

/**
 * Move the dragged item to the open place nearest `aim`. The grid puts each item in the shortest
 * column, so where an item lands depends only on the items before it: with the slot last, it moves
 * no other item, and the place it would take before an item is that item's corner. Choosing among
 * those places by `aim` alone, never by where the slot is now, means a copy held still can't make
 * the slot bounce around.
 */
function placeSlot(aim) {
    const { item, container } = drag;
    const others = placeable(container).filter(el => el !== item);
    container.style.minHeight = `${container.offsetHeight}px`; // so moving the slot can't shrink the page under the scroll position
    others.at(-1).after(item);
    const places = [...others, item].map(el => el.getBoundingClientRect());
    container.style.minHeight = '';
    const { width, height } = places.at(-1);
    const score = ({ left, top }) => {
        const dx = aim.x - left - width / 2;
        const dy = aim.y - top - height / 2;
        const under = aim.x >= left && aim.x < left + width && aim.y >= top && aim.y < top + height;
        return dx * dx + dy * dy + (under ? 0 : 1e9); // a place under `aim` beats any that isn't
    };
    const scores = places.map(score);
    const nearest = scores.indexOf(Math.min(...scores));
    if (nearest < others.length) others[nearest].before(item);
}

/** Put the slot where the floating copy is now, and note where everything sits for `copyLeftSlot`. */
function moveSlot(aim) {
    drag.layout = slide(drag.items, () => placeSlot(aim));
    drag.items = placeable(drag.container);
    drag.triedX = aim.x + scrollX;
    drag.triedY = aim.y + scrollY;
}

function scrollNearEdge() {
    const above = EDGE_TOP - press.y;
    const below = press.y - (innerHeight - EDGE_BOTTOM);
    if (above > 0) scrollBy(0, -SCROLL_SPEED * Math.min(1, above / EDGE_TOP));
    else if (below > 0) scrollBy(0, SCROLL_SPEED * Math.min(1, below / EDGE_BOTTOM));
}

function tick(now) {
    const { item, ghost } = drag;
    if (!item.isConnected) return end(true); // the gallery was redrawn under the drag
    scrollNearEdge();
    ghost.style.translate = `${press.x - drag.grabX}px ${press.y - drag.grabY}px`;
    const aim = copyCenter();
    if (now - drag.swappedAt > drag.pause && copyLeftSlot(aim)) {
        moveSlot(aim);
        drag.swappedAt = now;
        // A move costs a layout of the whole grid, so a big gallery gets longer pauses to stay responsive
        drag.pause = Math.max(SWAP_PAUSE_MS, 3 * (performance.now() - now));
    }
    drag.frame = requestAnimationFrame(tick);
}

/**
 * Lift the pressed item. A floating copy follows the pointer while the item itself stays in the
 * grid as a dashed slot that moves to wherever the copy is held.
 */
function begin() {
    const { item } = press;
    const container = item.parentElement;
    const items = container ? placeable(container) : [];
    if (items.length < 2) return endPress();
    clearTimeout(press.timer);
    press.began = true;
    clearCardFocus();
    getSelection().removeAllRanges();

    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.inert = true;
    Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px`, translate: `${rect.left}px ${rect.top}px` });
    drag = {
        item, container, ghost, items,
        startItems: items,
        next: item.nextElementSibling,
        layout: items.map(el => pageBox(el, el.getBoundingClientRect())),
        width: rect.width,
        height: rect.height,
        grabX: press.x - rect.left,
        grabY: press.y - rect.top,
        swappedAt: -Infinity,
        pause: SWAP_PAUSE_MS,
    };
    container.append(ghost);
    item.classList.add('drag-slot');
    document.body.classList.add('is-reordering');
    Elements.imageGrid.setPointerCapture(press.id);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('click', swallowClick, true);
    if (!prefersReducedMotion()) ghost.animate({ scale: [1, 1.03] }, { duration: 120, easing: 'ease-out' });
    drag.frame = requestAnimationFrame(tick);
}

/** Drop the item where its slot is, or put it back where it started when `cancelled`. */
function end(cancelled) {
    if (!drag) return;
    const { item, container, ghost, startItems, next } = drag;
    cancelAnimationFrame(drag.frame);
    window.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('is-reordering');
    if (!cancelled && item.isConnected && copyLeftSlot(copyCenter())) moveSlot(copyCenter()); // released within the pause
    const moved = !cancelled && drag.items.some((el, i) => el !== startItems[i]);
    let layout = drag.layout;
    if (cancelled && item.isConnected) layout = slide(drag.items, () => container.insertBefore(item, next));
    drag = null;
    if (!item.isConnected) return ghost.remove();
    settle(ghost, item, layout.find(box => box.el === item));
    if (!moved) return;
    // The grid already shows the new order: keep it, and renumber the cards to match
    const cards = [...Elements.imageGrid.querySelectorAll('.image-card:not(.drag-ghost)')];
    saveImageOrder(cards.map(card => card.dataset.filename));
    cards.forEach((card, i) => { card.dataset.idx = i; });
}

function onKey(e) {
    e.stopPropagation(); // the gallery's shortcuts stay quiet while dragging
    if (e.key === 'Escape') end(true);
}

// The click that ends a drag belongs to the drag, not to the card the pointer lands on
const swallowClick = (e) => { e.stopPropagation(); e.preventDefault(); };

function endPress() {
    clearTimeout(press.timer);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerEnd);
    window.removeEventListener('pointercancel', onPointerEnd);
    setTimeout(() => window.removeEventListener('click', swallowClick, true), 100);
    press = null;
}

function onPointerDown(e) {
    if (e.button !== 0 || !e.isPrimary || State.selectionMode || e.target.closest('a, button, input')) return;
    // A press that is still around means its release went missing: put everything back
    if (drag) end(true);
    if (press) endPress();
    // A card is dragged by itself, a group by its header or frame
    const item = e.target.closest('.image-card') ?? e.target.closest('.image-group');
    if (!item) return;
    press = { item, id: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, hold: e.pointerType === 'touch', began: false };
    if (press.hold) press.timer = setTimeout(begin, HOLD_MS);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
}

function onPointerMove(e) {
    if (e.pointerId !== press.id) return;
    if (e.pointerType === 'mouse' && !e.buttons) { // the release happened out of sight (another window had it)
        end(true);
        return endPress();
    }
    press.x = e.clientX;
    press.y = e.clientY;
    if (press.began) return;
    const travelled = Math.hypot(press.x - press.startX, press.y - press.startY);
    if (!press.hold && travelled > DRAG_DISTANCE) begin();
    else if (press.hold && travelled > HOLD_DRIFT) endPress(); // the finger is scrolling
}

function onPointerEnd(e) {
    if (e.pointerId !== press.id) return;
    end(e.type === 'pointercancel');
    endPress();
}

export function initReorder() {
    const grid = Elements.imageGrid;
    grid.addEventListener('pointerdown', onPointerDown);
    grid.addEventListener('lostpointercapture', () => end(true));
    // A finger held on a card would open the browser's context menu, which cancels the drag
    grid.addEventListener('contextmenu', (e) => { if (press?.hold) e.preventDefault(); });
    // Once an item is lifted, the finger moves it instead of scrolling the page
    window.addEventListener('touchmove', (e) => { if (drag && e.cancelable) e.preventDefault(); }, { passive: false });
}
