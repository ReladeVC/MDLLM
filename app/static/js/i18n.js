// i18n.js - Simple localization module
(function() {
    'use strict';

    const STORAGE_KEY = 'md_llm_lang';
    const DEFAULT_LANG = 'ru';
    
    let currentLang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
    let translations = {};

    // Load translations from JSON file
    async function loadTranslations(lang) {
        try {
            const response = await fetch(`/static/locales/${lang}.json`);
            if (!response.ok) throw new Error(`Failed to load ${lang}.json`);
            translations = await response.json();
            return true;
        } catch (e) {
            console.error('i18n load error:', e);
            return false;
        }
    }

    // Get translated string by dot-notation key
    function t(key) {
        const keys = key.split('.');
        let value = translations;
        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return key; // Return key if translation not found
            }
        }
        return typeof value === 'string' ? value : key;
    }

    // Apply translations to all elements with data-i18n attribute
    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translated = t(key);
            
            // Handle different element types
            if (el.hasAttribute('placeholder')) {
                el.placeholder = translated;
            } else if (el.hasAttribute('title')) {
                el.title = translated;
            } else if (el.children.length === 0) {
                // Simple element with no children - replace textContent directly
                el.textContent = translated;
            } else {
                // Element has children - find first text node and replace it
                const textNode = Array.from(el.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
                if (textNode) {
                    // Preserve surrounding whitespace
                    const original = textNode.textContent;
                    const match = original.match(/^(\s*)(.*?)(\s*)$/);
                    if (match) {
                        textNode.textContent = match[1] + translated + match[3];
                    } else {
                        textNode.textContent = translated;
                    }
                }
            }
        });
    }

    // Set up MutationObserver to re-apply translations when new content is added
    function setupObserver() {
        const observer = new MutationObserver((mutations) => {
            let shouldReapply = false;
            mutations.forEach(mutation => {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.hasAttribute && node.hasAttribute('data-i18n')) {
                                shouldReapply = true;
                            } else if (node.querySelectorAll) {
                                const i18nElements = node.querySelectorAll('[data-i18n]');
                                if (i18nElements.length > 0) {
                                    shouldReapply = true;
                                }
                            }
                        }
                    });
                }
            });
            if (shouldReapply) {
                // Debounce to avoid excessive re-applications
                clearTimeout(applyTimeout);
                applyTimeout = setTimeout(applyTranslations, 100);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    let applyTimeout;

    // Switch language
    async function setLanguage(lang) {
        if (lang === currentLang) return;
        
        const loaded = await loadTranslations(lang);
        if (loaded) {
            currentLang = lang;
            localStorage.setItem(STORAGE_KEY, lang);
            applyTranslations();
            updateLanguageButton();
            // Dispatch event for dynamic content updates
            window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
        }
    }

    // Update language button text
    function updateLanguageButton() {
        const btn = document.getElementById('langToggleBtn');
        if (btn) {
            btn.textContent = currentLang === 'ru' ? 'EN' : 'RU';
            btn.title = currentLang === 'ru' ? 'Switch to English' : 'Переключить на русский';
        }
    }

    // Toggle between ru and en
    function toggleLanguage() {
        const newLang = currentLang === 'ru' ? 'en' : 'ru';
        setLanguage(newLang);
    }

    // Initialize i18n
    async function init() {
        await loadTranslations(currentLang);
        applyTranslations();
        
        // Set up language toggle button
        function setupLangBtn() {
            const btn = document.getElementById('langToggleBtn');
            if (btn) {
                btn.addEventListener('click', toggleLanguage);
                updateLanguageButton();
            }
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupLangBtn);
        } else {
            setupLangBtn();
        }
        // Set up MutationObserver for dynamic content
        setupObserver();
    }

    // Export to global scope
    window.i18n = { t, setLanguage, toggleLanguage, init, getLang: () => currentLang, applyTranslations };
    
    // Auto-initialize
    init();
})();