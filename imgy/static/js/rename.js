/** Inline rename for gallery cards and the lightbox header. */
import { showToast, withLoading } from './ui.js';
import { api } from './api.js';
import { applyRenameLocally } from './actions.js';

async function doInlineRename(img, opts) {
    const { input, sizer, originalName, blurSaves, onCleanup } = opts;
    let finished = false;
    let blurTimer;
    const finish = async (doSave) => {
        if (finished) return;
        finished = true;
        clearTimeout(blurTimer);
        sizer?.remove();
        const newName = input.value.trim();
        if (doSave && newName && newName !== originalName) {
            try {
                await withLoading(async () => {
                    const oldFilename = img.filename;
                    const data = await api.post('/api/images/rename', { old_filename: oldFilename, new_name: newName });
                    applyRenameLocally(oldFilename, data);
                });
            } catch (err) {
                console.error("[rename] API failed:", err);
            }
        } else if (doSave && newName && newName === originalName) {
            showToast('Name unchanged');
        }
        onCleanup();
    };
    input.onkeydown = (e) => {
        clearTimeout(blurTimer);
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    };
    input.onblur = () => {
        blurTimer = setTimeout(() => { if (!finished) finish(blurSaves); }, 0);
    };
}

export async function startInlineRename(img, titleEl, card) {
    if (titleEl.style.display === 'none') return; // already renaming
    if (!titleEl.getClientRects().length) return; // hidden (a grouped card): the input couldn't take focus
    const originalName = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = originalName;
    input.setAttribute('aria-label', 'File name');
    input.spellcheck = false;

    // The input fills the space the name used; the extension stays visible after it
    card.classList.add('renaming');
    titleEl.style.display = 'none';
    titleEl.parentNode.insertBefore(input, titleEl);
    input.focus();
    input.select();

    await doInlineRename(img, {
        input, sizer: null, originalName, blurSaves: false,
        onCleanup() {
            input.remove();
            titleEl.style.display = '';
            titleEl.parentNode.scrollLeft = 0;
            card.classList.remove('renaming');
        }
    });
}

export async function startHeaderInlineRename(img, titleEl) {
    if (titleEl.style.display === 'none') return; // already renaming
    const originalName = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'header-rename-input';
    input.value = originalName;
    input.style.width = titleEl.offsetWidth + 'px';

    // Grow the input with the name, measured in the title's own font
    const sizer = document.createElement('span');
    sizer.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none';
    sizer.style.font = window.getComputedStyle(titleEl).font;
    document.body.appendChild(sizer);
    const fit = () => {
        sizer.textContent = input.value || ' ';
        input.style.width = (sizer.offsetWidth + 8) + 'px';
    };
    input.addEventListener('input', fit);
    input.setAttribute('aria-label', 'File name');
    input.spellcheck = false;

    // Hide the label rather than replacing it, so updateLightboxContent and applyRenameLocally
    // keep it showing the current image's name while the rename is in flight
    titleEl.style.display = 'none';
    titleEl.parentNode.insertBefore(input, titleEl);
    fit();
    input.focus();
    input.select();

    await doInlineRename(img, {
        input, sizer, originalName, blurSaves: true,
        onCleanup() {
            input.remove();
            titleEl.style.display = '';
        }
    });
}
