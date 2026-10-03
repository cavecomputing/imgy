/** Mutable app state shared by every module, plus small helpers that read it. */
export const State = {
    images: [],
    imagesByFilename: new Map(),
    filteredImages: [],
    allTags: [],
    tagCounts: {},
    currentImageIndex: 0,
    activeTags: new Set(),
    excludeTags: new Set(),
    nameTerms: new Set(), // from @text in the filter bar: a file's name must contain each one
    showUntaggedOnly: false,
    showFavoritesOnly: false,
    selectionMode: false,
    selectedImages: new Set(),
    currentQuickTagImage: null,
    settings: {},
    trashCount: 0,

    // Search Suggestions State
    suggestionIndex: -1,
    suggestionMatches: [],
    showOrphanedOnly: false,
    confirmInProgress: false,

    // Quick Tag State
    quickTagIndex: -1,
    quickTagMatches: [],

    // Bulk Tag State
    bulkTagFlyupMode: false,
    
    // Gallery Keyboard Navigation
    focusedCardIndex: -1,
    cardFocusActive: false,
    keepFocusPosition: false, // set before a re-render that removes the focused card on purpose

    // Grouping
    filenameToGroup: {},

    zoom: { scale: 1, translateX: 0, translateY: 0, isDragging: false, startX: 0, startY: 0 },
    dimensions: { imgWidth: 0, imgHeight: 0, contWidth: 0, contHeight: 0 },
    transformPending: false,
    lightboxScrollY: null
};

export function incrementTagCount(tag) {
    State.tagCounts[tag] = (State.tagCounts[tag] || 0) + 1;
}

export function decrementTagCount(tag) {
    if (State.tagCounts[tag]) State.tagCounts[tag]--;
}

export const LlmQueue = {
    items: [],        // { filename, status: 'queued'|'processing'|'done'|'error' }
    processing: false
};

export function getSelectedFilenames() {
    return Array.from(State.selectedImages);
}

export function getImagesByFilenames(filenames) {
    return filenames.map(f => State.imagesByFilename.get(f)).filter(Boolean);
}

export function refreshBulkVirtualTags(img) {
    const filenames = img?._bulkFilenames || [];
    const selectedImgs = getImagesByFilenames(filenames);
    const tags = [...new Set(selectedImgs.flatMap(si => si.tags || []))].sort();
    if (img) img.tags = tags;
    return tags;
}

export function getCurrentLightboxImage() {
    return State.filteredImages[State.currentImageIndex];
}
