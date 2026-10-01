/** Cached DOM lookups. ActiveFlyup points at whichever tag flyup (gallery or lightbox) is open. */
export const Elements = {
    imageGrid: document.getElementById('imageGrid'),
    tagSearch: document.getElementById('tagSearch'),
    tagSuggestions: document.getElementById('tagSuggestions'),
    activeTagsContainer: document.getElementById('activeTags'),
    uploadBtn: document.getElementById('uploadBtn'),
    imageInput: document.getElementById('imageInput'),
    lightbox: document.getElementById('lightbox'),
    lightboxHeaderDeleteBtn: document.getElementById('lightboxHeaderDeleteBtn'),
    lightboxContent: document.getElementById('lightboxContent'),
    lightboxImage: document.getElementById('lightboxImage'),
    resetZoomBtn: document.getElementById('resetZoom'),
    closeLightboxBtn: document.getElementById('closeLightbox'),
    prevImageBtn: document.getElementById('prevImage'),
    nextImageBtn: document.getElementById('nextImage'),
    untaggedFilterBtn: document.getElementById('untaggedFilterBtn'),
    favoriteFilterBtn: document.getElementById('favoriteFilterBtn'),
    loadingEl: document.getElementById('loading'),
    errorEl: document.getElementById('error'),
    toastEl: document.getElementById('toast'),
    galleryTagFlyup: document.getElementById('galleryTagFlyup'),
    quickTagCurrent: document.getElementById('galleryTagCurrent'),
    quickTagInput: document.getElementById('galleryTagInput'),
    quickTagHint: document.getElementById('galleryTagHint'),
    quickTagSuggestions: document.getElementById('galleryTagSuggestions'),
    trashBtn: document.getElementById('trashBtn'),
    trashModal: document.getElementById('trashModal'),
    closeTrashModal: document.getElementById('closeTrashModal'),
    trashList: document.getElementById('trashList'),
    emptyTrashBtn: document.getElementById('emptyTrashBtn'),
    cleanupOrphansBtn: document.getElementById('cleanupOrphansBtn'),
    lightboxTagFlyup: document.getElementById('lightboxTagFlyup'),
    lightboxTagInput: document.getElementById('lightboxTagInput'),
    lightboxTagBtn: document.getElementById('lightboxTagBtn'),
    lightboxFavoriteBtn: document.getElementById('lightboxFavoriteBtn'),
    lightboxDownloadBtn: document.getElementById('lightboxDownloadBtn'),
    
    // Selection Elements
    selectModeBtn: document.getElementById('selectModeBtn'),
    selectionBar: document.getElementById('selectionBar'),
    selectedCountEl: document.getElementById('selectedCount'),
    deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
    downloadSelectedBtn: document.getElementById('downloadSelectedBtn'),
    clearSelectionBtn: document.getElementById('clearSelectionBtn'),
    bulkFavoriteBtn: document.getElementById('bulkFavoriteBtn'),
    bulkTagBtn: document.getElementById('bulkTagBtn'),
    groupSelectedBtn: document.getElementById('groupSelectedBtn'),
    shortcutsModal: document.getElementById('shortcutsModal'),
    closeShortcutsModalBtn: document.getElementById('closeShortcutsModal'),
    shortcutsBtn: document.getElementById('shortcutsBtn'),
    gallerySizeSlider: document.getElementById('gallerySizeSlider'),
    llmAnalyzeBtn: document.getElementById('llmAnalyzeBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    uploadProgress: document.getElementById('uploadProgress'),
    uploadProgressBar: document.getElementById('uploadProgressBar'),
    uploadProgressText: document.getElementById('uploadProgressText'),
};

export const ActiveFlyup = {
    input: Elements.quickTagInput,
    suggestions: Elements.quickTagSuggestions,
    current: Elements.quickTagCurrent,
    hint: Elements.quickTagHint,
    setGallery() {
        this.input = Elements.quickTagInput;
        this.suggestions = Elements.quickTagSuggestions;
        this.current = Elements.quickTagCurrent;
        this.hint = Elements.quickTagHint;
    },
    setLightbox() {
        this.input = Elements.lightboxTagInput;
        this.suggestions = document.getElementById('lightboxTagSuggestions');
        this.current = null;
        this.hint = document.getElementById('lightboxTagHint');
    }
};
