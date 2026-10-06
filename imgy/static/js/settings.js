/** Server-stored settings, the auto-tagging form, the tag list, and the settings dialog with its sections. */
import { CONFIG } from './config.js';
import { getCurrentLightboxImage, State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, formatFileSize } from './utils.js';
import { closeOnBackdropClick, showToast, withLoading } from './ui.js';
import { api } from './api.js';
import { applyTheme } from './appearance.js';
import { applyFilters, loadData } from './data.js';
import { renderLightboxTagBar } from './lightbox.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';

const PROVIDER_HELP = {
    custom: 'Any OpenAI-compatible chat completions API with vision, such as Ollama.',
    openrouter: 'Sends each image to openrouter.ai, which needs an API key from openrouter.ai/keys.'
};

function getProviderControl() {
    return document.querySelector('input[name="llmProvider"]:checked')?.value || LLM_DEFAULTS.llmProvider;
}

function setProviderControl(value) {
    document.querySelectorAll('input[name="llmProvider"]').forEach(radio => { radio.checked = radio.value === value; });
}

const LLM_DEFAULTS = {
    llmProvider: 'custom',
    llmApiUrl: 'http://localhost:11434/v1/chat/completions',
    llmModel: 'gemma3',
    llmDoRename: 'true',
    llmDoTags: 'true',
    llmApiSecret: ''
};

export async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        State.settings = data;
        if (data.theme) applyTheme(data.theme);
    } catch (err) {
        console.error('Failed to load settings:', err);
        State.settings = {};
    }
}

export function saveSetting(key, value) {
    State.settings[key] = String(value);
    putSettings({ [key]: String(value) }).catch(err => console.error('Failed to save setting:', err));
}

function putSettings(values) {
    return fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
    });
}

export function getLlmSettings() {
    const s = State.settings || {};
    const provider = s.llmProvider || LLM_DEFAULTS.llmProvider;
    const api_url = provider === 'openrouter' ? OPENROUTER_URL : (s.llmApiUrl || LLM_DEFAULTS.llmApiUrl);
    const savedModel = s.llmModel || LLM_DEFAULTS.llmModel;
    return {
        provider,
        api_url,
        model: provider === 'openrouter' && savedModel === LLM_DEFAULTS.llmModel ? OPENROUTER_DEFAULT_MODEL : savedModel,
        doRename: (s.llmDoRename ?? LLM_DEFAULTS.llmDoRename) !== 'false',
        doTags: (s.llmDoTags ?? LLM_DEFAULTS.llmDoTags) !== 'false',
        api_secret: s.llmApiSecret || ''
    };
}

/** True once an endpoint, model or key has been saved, or a connection test has passed. */
export function isLlmConfigured() {
    return ['llmProvider', 'llmApiUrl', 'llmModel', 'llmApiSecret'].some(key => State.settings[key]);
}

function getLlmSettingsFromControls() {
    const provider = getProviderControl();
    const apiUrlInput = document.getElementById('llmApiUrl');
    const modelInput = document.getElementById('llmModel');
    const secretInput = document.getElementById('llmApiSecret');
    const model = modelInput?.value.trim() || LLM_DEFAULTS.llmModel;
    return {
        provider,
        api_url: provider === 'openrouter' ? OPENROUTER_URL : (apiUrlInput?.value.trim() || LLM_DEFAULTS.llmApiUrl),
        model: provider === 'openrouter' && model === LLM_DEFAULTS.llmModel ? OPENROUTER_DEFAULT_MODEL : model,
        api_secret: secretInput?.value.trim() || ''
    };
}

// Set by initTagGroupsEditor; re-reads the tag groups from the server
let reloadTagGroups = async () => {};

async function initTagGroupsEditor() {
    const container = document.getElementById('tagGroupsEditor');
    const addBtn = document.getElementById('addTagGroupBtn');
    if (!container || !addBtn) return;

    let groups = [];

    function render() {
        if (!groups.length) {
            container.innerHTML = '<div class="tag-groups-empty">No groups yet. A group needs at least two existing tags, for example day and night.</div>';
        } else {
            container.innerHTML = groups.map((g, gi) => `
                <div class="tag-group-row" data-idx="${gi}">
                    <div class="tag-group-header">
                        <input type="text" class="tag-group-name" value="${esc(g.name)}" placeholder="Group name" aria-label="Group name">
                        <button class="tag-group-delete" type="button" title="Delete group" aria-label="Delete group">&times;</button>
                    </div>
                    <div class="tag-group-tags">
                        ${g.tags.map(t => `<span class="tag-group-pill">${esc(t)}<button class="tag-group-pill-x" type="button" data-tag="${esc(t)}" aria-label="Remove ${esc(t)} from the group">&times;</button></span>`).join('')}
                        <div class="tag-group-add-wrap">
                            <input type="text" class="tag-group-add-input" placeholder="add existing tag" autocomplete="off">
                            <div class="tag-group-suggestions"></div>
                        </div>
                    </div>
                    ${g.tags.length < 2 ? '<div class="tag-group-validation">Add at least two existing tags to turn this group on.</div>' : ''}
                </div>
            `).join('');
        }
        bindEvents();
    }

    function usedTags() {
        const s = new Set();
        groups.forEach(g => g.tags.forEach(t => s.add(t)));
        return s;
    }

    async function save() {
        try {
            const resp = await fetch('/api/tag-groups', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(groups)
            });
            const data = await resp.json();
            if (!resp.ok) showToast(data.error || 'Failed to save tag groups');
        } catch { showToast('Failed to save tag groups'); }
    }

    function bindEvents() {
        container.querySelectorAll('.tag-group-delete').forEach(btn => {
            btn.onclick = () => {
                const row = btn.closest('.tag-group-row');
                groups.splice(parseInt(row.dataset.idx), 1);
                save();
                render();
            };
        });

        container.querySelectorAll('.tag-group-name').forEach(input => {
            input.onchange = () => {
                const row = input.closest('.tag-group-row');
                groups[parseInt(row.dataset.idx)].name = input.value.trim();
                save();
            };
        });

        container.querySelectorAll('.tag-group-pill-x').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const row = btn.closest('.tag-group-row');
                const gi = parseInt(row.dataset.idx);
                const tag = btn.dataset.tag;
                groups[gi].tags = groups[gi].tags.filter(t => t !== tag);
                if (groups[gi].tags.length < 2) {
                    groups.splice(gi, 1);
                }
                save();
                render();
            };
        });

        container.querySelectorAll('.tag-group-add-input').forEach(input => {
            const sugBox = input.nextElementSibling;
            const row = input.closest('.tag-group-row');
            const gi = parseInt(row.dataset.idx);

            input.oninput = () => {
                const q = input.value.trim().toLowerCase();
                if (!q) { sugBox.innerHTML = ''; sugBox.classList.remove('visible'); return; }
                const used = usedTags();
                const matches = State.allTags.filter(t => t.includes(q) && !used.has(t)).slice(0, 8);
                if (!matches.length) {
                    sugBox.innerHTML = '<div class="tag-group-sug-empty">No existing tags match</div>';
                    sugBox.classList.add('visible');
                    return;
                }
                sugBox.innerHTML = matches.map(t => `<div class="tag-group-sug-item"><span>${esc(t)}</span><span class="tag-count-badge">${State.tagCounts[t] || 0}</span></div>`).join('');
                sugBox.classList.add('visible');
                sugBox.querySelectorAll('.tag-group-sug-item').forEach(item => {
                    item.onmousedown = (e) => {
                        e.preventDefault();
                        groups[gi].tags.push(item.querySelector('span').textContent);
                        input.value = '';
                        sugBox.innerHTML = '';
                        sugBox.classList.remove('visible');
                        save();
                        render();
                    };
                });
            };

            input.onblur = () => {
                setTimeout(() => { sugBox.innerHTML = ''; sugBox.classList.remove('visible'); }, 150);
            };
        });
    }

    addBtn.onclick = () => {
        groups.push({ name: '', tags: [] });
        render();
        const nameInputs = container.querySelectorAll('.tag-group-name');
        if (nameInputs.length) nameInputs[nameInputs.length - 1].focus();
    };

    // Global tag renames and deletes also edit the groups on the server, so the dialog
    // reloads them each time it opens instead of saving a stale copy over them
    reloadTagGroups = async () => {
        try {
            const data = await (await fetch('/api/tag-groups')).json();
            if (Array.isArray(data)) groups = data;
        } catch { /* keep the groups already shown */ }
        render();
    };
    await reloadTagGroups();
}

export function initLlmSettings() {
    const s = getLlmSettings();
    const providerRadios = document.querySelectorAll('input[name="llmProvider"]');
    const providerHelp = document.getElementById('llmProviderHelp');
    const urlGroup = document.getElementById('llmApiUrlGroup');
    const urlInput = document.getElementById('llmApiUrl');
    const modelInput = document.getElementById('llmModel');
    const secretInput = document.getElementById('llmApiSecret');
    const renameCheck = document.getElementById('llmDoRename');
    const tagsCheck = document.getElementById('llmDoTags');
    const resetBtn = document.getElementById('llmSettingsReset');
    const testBtn = document.getElementById('llmTestBtn');
    const testStatus = document.getElementById('llmTestStatus');
    if (!urlInput) return;

    function updateProviderVisibility(provider) {
        providerHelp.textContent = PROVIDER_HELP[provider] || PROVIDER_HELP.custom;
        if (provider === 'openrouter') {
            urlGroup.classList.add('hidden-provider');
            urlInput.value = OPENROUTER_URL;
            modelInput.placeholder = 'openrouter/auto or provider/model';
            if (!modelInput.value.trim() || modelInput.value.trim() === LLM_DEFAULTS.llmModel) {
                modelInput.value = OPENROUTER_DEFAULT_MODEL;
            }
        } else {
            urlGroup.classList.remove('hidden-provider');
            urlInput.value = State.settings.llmApiUrl || LLM_DEFAULTS.llmApiUrl;
            modelInput.placeholder = LLM_DEFAULTS.llmModel;
        }
    }

    setProviderControl(s.provider);
    updateProviderVisibility(s.provider);
    urlInput.value = s.api_url;
    modelInput.value = s.model;
    if (secretInput) secretInput.value = s.api_secret;
    renameCheck.checked = s.doRename;
    tagsCheck.checked = s.doTags;

    providerRadios.forEach(radio => {
        radio.onchange = () => {
            if (!radio.checked) return;
            saveSetting('llmProvider', radio.value);
            updateProviderVisibility(radio.value);
            if (radio.value === 'openrouter') saveSetting('llmModel', modelInput.value.trim());
            clearTestStatus();
        };
    });
    urlInput.onchange = () => saveSetting('llmApiUrl', urlInput.value.trim());
    modelInput.onchange = () => saveSetting('llmModel', modelInput.value.trim());
    if (secretInput) secretInput.onchange = () => saveSetting('llmApiSecret', secretInput.value);
    renameCheck.onchange = () => saveSetting('llmDoRename', renameCheck.checked);
    tagsCheck.onchange = () => saveSetting('llmDoTags', tagsCheck.checked);
    resetBtn.onclick = () => {
        Object.assign(State.settings, LLM_DEFAULTS);
        putSettings(LLM_DEFAULTS);
        const defaults = getLlmSettings();
        setProviderControl(defaults.provider);
        updateProviderVisibility(defaults.provider);
        urlInput.value = defaults.api_url;
        modelInput.value = defaults.model;
        if (secretInput) secretInput.value = '';
        renameCheck.checked = defaults.doRename;
        tagsCheck.checked = defaults.doTags;
        clearTestStatus();
        showToast('Auto-tagging settings reset to defaults');
    };

    function clearTestStatus() {
        testStatus.textContent = '';
        testStatus.className = 'llm-test-status';
    }
    function showTestError(message) {
        testStatus.textContent = message;
        testStatus.className = 'llm-test-status is-error';
    }
    function showTestSuccess(model) {
        testStatus.innerHTML = `<span class="cc-badge cc-badge--done">Connected</span><span>${esc(model)}</span>`;
        testStatus.className = 'llm-test-status';
    }

    testBtn.onclick = async () => {
        testBtn.disabled = true;
        testBtn.textContent = 'Testing…';
        clearTestStatus();
        const testSettings = getLlmSettingsFromControls();
        if (testSettings.provider === 'openrouter' && !testSettings.api_secret) {
            showTestError('OpenRouter needs an API key');
            testBtn.disabled = false;
            testBtn.textContent = 'Test connection';
            return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.LLM_TEST_TIMEOUT_MS);
        try {
            const resp = await fetch('/api/llm/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_url: testSettings.api_url,
                    model: testSettings.model,
                    api_secret: testSettings.api_secret
                }),
                signal: controller.signal
            });
            clearTimeout(timeout);
            const data = await resp.json();
            if (resp.ok) {
                showTestSuccess(data.model || testSettings.model);
                saveSetting('llmProvider', testSettings.provider); // counts as set up, even on the defaults
            } else {
                showTestError(data.error || 'Connection failed');
            }
        } catch (err) {
            clearTimeout(timeout);
            showTestError(err.name === 'AbortError' ? `No answer after ${CONFIG.LLM_TEST_TIMEOUT_MS / 1000} seconds` : err.message);
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = 'Test connection';
        }
    };

    initTagGroupsEditor();
}

// Set by initTagsEditor; shows the Tags section fresh from State
let showTags = () => {};

const tagCount = (tag) => State.tagCounts[tag] || 0;

const TAG_ORDERS = {
    name: (a, b) => a.localeCompare(b),
    most: (a, b) => tagCount(b) - tagCount(a) || a.localeCompare(b),
    least: (a, b) => tagCount(a) - tagCount(b) || a.localeCompare(b)
};

function initTagsEditor() {
    const filterInput = document.getElementById('tagsFilter');
    const selectAll = document.getElementById('tagsSelectAll');
    const list = document.getElementById('tagsList');
    const selectionNote = document.getElementById('tagsSelectionNote');
    const deleteBtn = document.getElementById('deleteTagsBtn');
    const selectedTags = new Set();

    function visibleTags() {
        const query = filterInput.value.trim().toLowerCase();
        const order = document.querySelector('input[name="tagSort"]:checked').value;
        return State.allTags.filter(t => t.includes(query)).sort(TAG_ORDERS[order]);
    }

    function tagRow(tag) {
        const count = tagCount(tag);
        return `
            <tr>
                <td><label class="check"><input type="checkbox" data-tag="${esc(tag)}" aria-label="Select ${esc(tag)}"${selectedTags.has(tag) ? ' checked' : ''}></label></td>
                <td class="tags-name" title="${esc(tag)}">${esc(tag)}</td>
                <td class="tags-count"><span class="tag-count-badge${count ? '' : ' orphaned'}">${count}</span></td>
                <td class="tags-actions"><button class="icon-btn icon-btn--warn icon-btn--sm" type="button" data-tag="${esc(tag)}" title="Delete tag" aria-label="Delete ${esc(tag)}"><svg class="i i-sm" aria-hidden="true"><use href="#i-trash"/></svg></button></td>
            </tr>`;
    }

    // Ticking a row only updates this, so the rows stay put and keyboard focus stays on the box
    function updateSelection() {
        const rows = list.querySelectorAll('input[type="checkbox"]').length;
        selectAll.disabled = rows === 0;
        selectAll.checked = rows > 0 && selectedTags.size === rows;
        deleteBtn.disabled = selectedTags.size === 0;
        selectionNote.textContent = selectedTags.size ? `${selectedTags.size} selected` : 'Tick tags to delete several at once.';
    }

    function renderTags() {
        const tags = visibleTags();
        document.getElementById('tagsSummary').textContent = formatCount(State.allTags.length, 'tag');
        list.innerHTML = tags.length
            ? tags.map(tagRow).join('')
            : `<tr><td colspan="4" class="cc-note">${State.allTags.length ? 'No tag matches the filter.' : 'No tags yet. Add one to a file with T, or create one with +tag in the filter bar.'}</td></tr>`;
        updateSelection();
    }

    async function deleteTags(tags) {
        const what = tags.length === 1 ? `"${tags[0]}"` : formatCount(tags.length, 'tag');
        if (!confirm(`Remove ${what} from every file? This cannot be undone.`)) return;
        try {
            for (const tag of tags) {
                await api.delete(`/api/tags/remove-all?tag=${encodeURIComponent(tag)}`);
                State.activeTags.delete(tag);
                State.excludeTags.delete(tag);
            }
            showToast(`Deleted ${what}`);
        } finally {
            selectedTags.clear();
            await loadData();
            // ? opens the dialog over the lightbox too, which would keep showing the deleted tags
            const lightboxImage = Elements.lightbox.classList.contains('active') ? getCurrentLightboxImage() : null;
            if (lightboxImage) renderLightboxTagBar(lightboxImage.tags || [], lightboxImage.filename);
            // The server also took the tags out of the exclusive groups the Auto-tagging section shows
            await reloadTagGroups();
            renderTags();
        }
    }

    // A filter change drops the selection, so a bulk delete only ever touches tags you can see
    filterInput.addEventListener('input', () => { selectedTags.clear(); renderTags(); });
    document.querySelectorAll('input[name="tagSort"]').forEach(radio => radio.addEventListener('change', renderTags));
    selectAll.addEventListener('change', () => {
        selectedTags.clear();
        if (selectAll.checked) visibleTags().forEach(t => selectedTags.add(t));
        renderTags();
    });
    list.addEventListener('change', (e) => {
        if (e.target.checked) selectedTags.add(e.target.dataset.tag);
        else selectedTags.delete(e.target.dataset.tag);
        updateSelection();
    });
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn) deleteTags([btn.dataset.tag]);
    });
    deleteBtn.addEventListener('click', () => deleteTags([...selectedTags]));

    showTags = () => {
        filterInput.value = '';
        selectedTags.clear();
        renderTags();
    };
}

async function loadStorageStats() {
    const el = document.getElementById('storageStats');
    if (!el) return;
    try {
        const stats = await api.get('/api/storage');
        el.innerHTML = [
            { label: 'Media', value: stats.images },
            { label: 'Thumbnails', value: stats.thumbnails },
            { label: 'Trash', value: stats.trash },
            { label: 'Database', value: stats.database },
            { label: 'Total', value: stats.total, total: true }
        ].map(s => `<tr${s.total ? ' class="total"' : ''}><td>${s.label}</td><td>${formatFileSize(s.value) || '0 B'}</td></tr>`).join('');
    } catch (e) {
        el.innerHTML = '';
    }
}

async function resetThumbnails() {
    if (!confirm('Delete every thumbnail? Imgy makes them again from your files as you browse.')) return;
    const btn = document.getElementById('resetThumbnailsBtn');
    btn.disabled = true;
    try {
        await withLoading(async () => {
            const res = await api.post('/api/maintenance/reset-thumbnails');
            await loadData();
            await loadStorageStats();
            showToast(`Deleted ${formatCount(res.thumbnails_purged || 0, 'thumbnail')}`);
        });
    } finally {
        btn.disabled = false;
    }
}

/** Tick the gallery order in effect: newest first until files have been dragged into a custom order. */
function showGalleryOrder() {
    const order = State.settings.galleryOrder === 'custom' ? 'custom' : 'newest';
    document.querySelectorAll('input[name="galleryOrder"]').forEach(radio => { radio.checked = radio.value === order; });
}

let currentSection = 'about';

function showSettingsSection(section) {
    const sections = Elements.shortcutsModal.querySelectorAll('.settings-section');
    if (![...sections].some(s => s.dataset.section === section)) section = 'about';
    currentSection = section;
    sections.forEach(s => { s.hidden = s.dataset.section !== section; });
    Elements.shortcutsModal.querySelectorAll('.settings-tab[data-section]').forEach(tab => {
        const active = tab.dataset.section === section;
        tab.classList.toggle('active', active);
        if (active) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    });
    if (section === 'storage') loadStorageStats();
    if (section === 'tags') showTags();
}

/** Open the settings dialog at a section (the last one shown by default), or close it. */
export function toggleShortcutsModal(section) {
    if (Elements.shortcutsModal.open) {
        closeShortcutsModal();
        return;
    }
    showSettingsSection(typeof section === 'string' ? section : currentSection);
    showGalleryOrder(); // dragging files in the gallery can switch it while the dialog is closed
    Elements.shortcutsModal.showModal();
    reloadTagGroups();
}

export function closeShortcutsModal() {
    if (Elements.shortcutsModal.open) Elements.shortcutsModal.close();
}

export function initSettingsModal() {
    closeOnBackdropClick(Elements.shortcutsModal);
    Elements.shortcutsBtn.addEventListener('click', () => toggleShortcutsModal());
    Elements.closeShortcutsModalBtn.addEventListener('click', closeShortcutsModal);
    Elements.shortcutsModal.querySelectorAll('.settings-tab[data-section]').forEach(tab => {
        tab.addEventListener('click', () => showSettingsSection(tab.dataset.section));
    });
    document.getElementById('resetThumbnailsBtn').addEventListener('click', resetThumbnails);
    document.getElementById('extensionAddress').textContent = location.origin;
    document.querySelectorAll('input[name="galleryOrder"]').forEach(radio => {
        radio.addEventListener('change', () => {
            saveSetting('galleryOrder', radio.value);
            applyFilters();
        });
    });
    initTagsEditor();
    showSettingsSection(currentSection);
}
