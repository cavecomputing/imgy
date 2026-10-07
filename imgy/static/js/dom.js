/** Cached DOM lookups. ActiveFlyup points at whichever tag flyup (gallery or lightbox) is open. */
const byId = (id) => document.getElementById(id);

export const Elements = {
    imageGrid: byId('imageGrid'),
    gridEnd: byId('gridEnd'),
    libraryCount: byId('libraryCount'),
    tagSearch: byId('tagSearch'),
    tagSuggestions: byId('tagSuggestions'),
    tagSuggestionList: byId('tagSuggestionList'),
    activeTagsContainer: byId('activeTags'),
    moreFiltersBtn: byId('moreFilters'),
    filterPopChips: byId('filterPopChips'),
    uploadBtn: byId('uploadBtn'),
    imageInput: byId('imageInput'),
    untaggedFilterBtn: byId('untaggedFilterBtn'),
    favoriteFilterBtn: byId('favoriteFilterBtn'),
    loadingEl: byId('loading'),
    errorEl: byId('error'),
    toastEl: byId('toast'),
    themeToggleBtn: byId('themeToggleBtn'),
    themeIcon: byId('themeIcon'),
    gallerySizeSlider: byId('gallerySizeSlider'),
    gallerySizeDown: byId('gallerySizeDown'),
    gallerySizeUp: byId('gallerySizeUp'),
    uploadProgress: byId('uploadProgress'),
    uploadProgressBar: byId('uploadProgressBar'),
    uploadProgressText: byId('uploadProgressText'),

    // Lightbox
    lightbox: byId('lightbox'),
    lightboxContent: byId('lightboxContent'),
    lightboxImage: byId('lightboxImage'),
    lightboxHeaderFilename: byId('lightboxHeaderFilename'),
    lightboxHeaderExt: byId('lightboxHeaderExt'),
    lightboxPosition: byId('lightboxPosition'),
    lightboxBackBtn: byId('lightboxBackBtn'),
    lightboxHeaderDeleteBtn: byId('lightboxHeaderDeleteBtn'),
    lightboxTagBtn: byId('lightboxTagBtn'),
    lightboxFavoriteBtn: byId('lightboxFavoriteBtn'),
    lightboxDownloadBtn: byId('lightboxDownloadBtn'),
    llmAnalyzeBtn: byId('llmAnalyzeBtn'),
    resetZoomBtn: byId('resetZoom'),
    closeLightboxBtn: byId('closeLightbox'),
    prevImageBtn: byId('prevImage'),
    nextImageBtn: byId('nextImage'),
    lightboxTagBarTags: byId('lightboxTagBarTags'),
    lightboxTagFlyup: byId('lightboxTagFlyup'),
    lightboxTagInput: byId('lightboxTagInput'),
    lightboxMetaLine: byId('lightboxMetaLine'),
    lightboxLlmSection: byId('lightboxLlmSection'),
    lightboxLlmText: byId('lightboxLlmText'),
    llmPanelBtn: byId('llmPanelBtn'),
    lightboxMeta: byId('lightboxMeta'),
    lightboxExif: byId('lightboxExif'),
    lightboxFavoriteTab: byId('lightboxFavoriteTab'),
    lightboxTagTab: byId('lightboxTagTab'),
    lightboxLlmTab: byId('lightboxLlmTab'),
    lightboxDownloadTab: byId('lightboxDownloadTab'),
    lightboxDeleteTab: byId('lightboxDeleteTab'),

    // Gallery tag editor (one file or the bulk selection)
    galleryTagFlyup: byId('galleryTagFlyup'),
    galleryTagThumb: byId('galleryTagThumb'),
    galleryTagEyebrow: byId('galleryTagEyebrow'),
    galleryTagTitle: byId('galleryTagTitle'),
    closeGalleryTagFlyupBtn: byId('closeGalleryTagFlyup'),
    quickTagCurrent: byId('galleryTagCurrent'),
    quickTagInput: byId('galleryTagInput'),
    quickTagHint: byId('galleryTagHint'),
    quickTagSuggestions: byId('galleryTagSuggestions'),

    // Trash
    trashBtn: byId('trashBtn'),
    trashCount: byId('trashCount'),
    trashModal: byId('trashModal'),
    trashSummary: byId('trashSummary'),
    closeTrashModal: byId('closeTrashModal'),
    trashList: byId('trashList'),
    emptyTrashBtn: byId('emptyTrashBtn'),
    cleanupOrphansBtn: byId('cleanupOrphansBtn'),

    // Selection
    selectModeBtn: byId('selectModeBtn'),
    selectionBar: byId('selectionBar'),
    selectedCountEl: byId('selectedCount'),
    deleteSelectedBtn: byId('deleteSelectedBtn'),
    downloadSelectedBtn: byId('downloadSelectedBtn'),
    clearSelectionBtn: byId('clearSelectionBtn'),
    bulkFavoriteBtn: byId('bulkFavoriteBtn'),
    bulkTagBtn: byId('bulkTagBtn'),
    groupSelectedBtn: byId('groupSelectedBtn'),

    // Settings
    shortcutsModal: byId('shortcutsModal'),
    closeShortcutsModalBtn: byId('closeShortcutsModal'),
    shortcutsBtn: byId('shortcutsBtn'),
    gallerySizeSetting: byId('gallerySizeSetting'),
    gallerySizeValue: byId('gallerySizeValue'),
    gallerySizeReset: byId('gallerySizeReset'),
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
        // The file's tags already show as chips above the lightbox editor
        this.input = Elements.lightboxTagInput;
        this.suggestions = byId('lightboxTagSuggestions');
        this.current = null;
        this.hint = byId('lightboxTagHint');
    }
};
