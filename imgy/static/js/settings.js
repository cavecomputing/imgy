/** Server-stored settings, the LLM settings form, and the About/settings dialog. */
import { CONFIG } from './config.js';
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatFileSize } from './utils.js';
import { closeOnBackdropClick, showToast } from './ui.js';
import { api } from './api.js';
import { applyTheme } from './appearance.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';

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
        // One-time migration from localStorage
        if (Object.keys(data).length === 0) {
            const migrated = {};
            for (const key of Object.keys(LLM_DEFAULTS)) {
                const val = localStorage.getItem(key);
                if (val !== null) {
                    migrated[key] = val;
                    localStorage.removeItem(key);
                }
            }
            if (Object.keys(migrated).length > 0) {
                State.settings = migrated;
                putSettings(migrated);
            }
        }
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

function getLlmSettingsFromControls() {
    const provider = document.getElementById('llmProvider')?.value || LLM_DEFAULTS.llmProvider;
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
            container.innerHTML = '<div class="tag-groups-empty">Exclusive groups keep LLM tagging to one tag from a set. Add a group with at least two existing tags.</div>';
        } else {
            container.innerHTML = groups.map((g, gi) => `
                <div class="tag-group-row" data-idx="${gi}">
                    <div class="tag-group-header">
                        <input type="text" class="tag-group-name" value="${esc(g.name)}" placeholder="Group name">
                        <button class="tag-group-delete" title="Delete group">&times;</button>
                    </div>
                    <div class="tag-group-tags">
                        ${g.tags.map(t => `<span class="tag-group-pill">${esc(t)}<button class="tag-group-pill-x" data-tag="${esc(t)}">&times;</button></span>`).join('')}
                        <div class="tag-group-add-wrap">
                            <input type="text" class="tag-group-add-input" placeholder="add existing tag" autocomplete="off">
                            <div class="tag-group-suggestions"></div>
                        </div>
                    </div>
                    ${g.tags.length < 2 ? '<div class="tag-group-validation">Add at least two existing tags to enable this exclusive group.</div>' : ''}
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
    const providerSelect = document.getElementById('llmProvider');
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

    providerSelect.value = s.provider;
    updateProviderVisibility(s.provider);
    urlInput.value = s.api_url;
    modelInput.value = s.model;
    if (secretInput) secretInput.value = s.api_secret;
    renameCheck.checked = s.doRename;
    tagsCheck.checked = s.doTags;

    providerSelect.onchange = () => {
        saveSetting('llmProvider', providerSelect.value);
        updateProviderVisibility(providerSelect.value);
        if (providerSelect.value === 'openrouter') saveSetting('llmModel', modelInput.value.trim());
    };
    urlInput.onchange = () => saveSetting('llmApiUrl', urlInput.value.trim());
    modelInput.onchange = () => saveSetting('llmModel', modelInput.value.trim());
    if (secretInput) secretInput.onchange = () => saveSetting('llmApiSecret', secretInput.value);
    renameCheck.onchange = () => saveSetting('llmDoRename', renameCheck.checked);
    tagsCheck.onchange = () => saveSetting('llmDoTags', tagsCheck.checked);
    resetBtn.onclick = () => {
        State.settings = {...LLM_DEFAULTS};
        putSettings(LLM_DEFAULTS);
        const defaults = getLlmSettings();
        providerSelect.value = defaults.provider;
        updateProviderVisibility(defaults.provider);
        urlInput.value = defaults.api_url;
        modelInput.value = defaults.model;
        if (secretInput) secretInput.value = '';
        renameCheck.checked = defaults.doRename;
        tagsCheck.checked = defaults.doTags;
        testStatus.textContent = '';
        testStatus.className = 'llm-test-status';
        showToast('LLM settings reset to defaults');
    };
    testBtn.onclick = async () => {
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
        testStatus.textContent = '';
        testStatus.className = 'llm-test-status';
        const testSettings = getLlmSettingsFromControls();
        if (testSettings.provider === 'openrouter' && !testSettings.api_secret) {
            testStatus.textContent = 'OpenRouter requires an API key';
            testStatus.className = 'llm-test-status error';
            testBtn.disabled = false;
            testBtn.textContent = 'Test Connection';
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
                testStatus.textContent = `Connected — ${data.model}`;
                testStatus.className = 'llm-test-status success';
            } else {
                testStatus.textContent = data.error || 'Connection failed';
                testStatus.className = 'llm-test-status error';
            }
        } catch (err) {
            clearTimeout(timeout);
            testStatus.textContent = err.name === 'AbortError' ? 'Timed out (20s)' : err.message;
            testStatus.className = 'llm-test-status error';
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = 'Test Connection';
        }
    };

    initTagGroupsEditor();
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
        ].map(s => `<span class="storage-stat ${s.total ? 'storage-stat-total' : ''}"><span class="storage-stat-value">${formatFileSize(s.value) || '0 B'}</span> ${s.label}</span>`).join('');
    } catch (e) {
        el.textContent = '';
    }
}

export function toggleShortcutsModal() {
    if (Elements.shortcutsModal.open) {
        closeShortcutsModal();
    } else {
        Elements.shortcutsModal.showModal();
        loadStorageStats();
        reloadTagGroups();
    }
}

export function closeShortcutsModal() {
    if (Elements.shortcutsModal.open) Elements.shortcutsModal.close();
}

export function initSettingsModal() {
    closeOnBackdropClick(Elements.shortcutsModal);
    Elements.shortcutsBtn.addEventListener('click', toggleShortcutsModal);
    Elements.closeShortcutsModalBtn.addEventListener('click', closeShortcutsModal);
}
