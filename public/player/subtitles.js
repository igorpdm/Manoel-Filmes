import { dom } from './dom.js';
import { state } from './state.js';

const STORAGE_KEY = 'manoel_subtitle_settings';

const ASS_TAG_REGEX = /\{\\[^}]*\}/g;
const HTML_TAG_REGEX = /<\/?(?!(?:i|b|u)\b)[^>]+>/gi;

export const subtitleState = {
    cues: [],
    currentCueIndex: -1,
    settings: {
        enabled: false,
        selectedFile: null,
        fontSize: 28,
        fontFamily: "'Outfit', sans-serif",
        textColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.75,
        backgroundEnabled: true
    }
};

export function parseSRT(content) {
    const cues = [];
    const blocks = content.trim().replace(/\r\n/g, '\n').split('\n\n');

    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 3) continue;

        const timeLine = lines[1];
        const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (!timeMatch) continue;

        const start = parseTime(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
        const end = parseTime(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
        const text = lines.slice(2).join('\n')
            .replace(ASS_TAG_REGEX, '')
            .replace(HTML_TAG_REGEX, '')
            .trim();

        cues.push({ start, end, text });
    }

    return cues;
}

function parseTime(h, m, s, ms) {
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
}

const BASE_VIDEO_WIDTH = 1920;

function getScaledFontSize() {
    const videoWidth = dom.video?.clientWidth || BASE_VIDEO_WIDTH;
    const scale = videoWidth / BASE_VIDEO_WIDTH;
    return Math.round(subtitleState.settings.fontSize * scale);
}

export function renderSubtitle(currentTime) {
    if (!subtitleState.settings.enabled || subtitleState.cues.length === 0) {
        if (dom.subtitleDisplay) dom.subtitleDisplay.innerHTML = '';
        return;
    }

    let activeCue = null;
    for (let i = 0; i < subtitleState.cues.length; i++) {
        const cue = subtitleState.cues[i];
        if (currentTime >= cue.start && currentTime <= cue.end) {
            activeCue = cue;
            break;
        }
    }

    if (!dom.subtitleDisplay) return;

    if (activeCue) {
        const escapedText = activeCue.text
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        dom.subtitleDisplay.innerHTML = escapedText;
        dom.subtitleDisplay.style.opacity = '1';
    } else {
        dom.subtitleDisplay.innerHTML = '';
        dom.subtitleDisplay.style.opacity = '0';
    }
}

export function applySettings() {
    if (!dom.subtitleDisplay) return;

    const s = subtitleState.settings;
    dom.subtitleDisplay.style.fontSize = `${getScaledFontSize()}px`;
    dom.subtitleDisplay.style.fontFamily = s.fontFamily;
    dom.subtitleDisplay.style.color = s.textColor;

    if (s.backgroundEnabled) {
        const r = parseInt(s.backgroundColor.slice(1, 3), 16);
        const g = parseInt(s.backgroundColor.slice(3, 5), 16);
        const b = parseInt(s.backgroundColor.slice(5, 7), 16);
        dom.subtitleDisplay.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${s.backgroundOpacity})`;
    } else {
        dom.subtitleDisplay.style.backgroundColor = 'transparent';
        dom.subtitleDisplay.style.textShadow = '2px 2px 4px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)';
    }

    saveSettingsToStorage();
}

export function saveSettingsToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subtitleState.settings));
}

export function loadSettingsFromStorage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            Object.assign(subtitleState.settings, parsed);
            subtitleState.settings.enabled = false;
            subtitleState.settings.selectedFile = null;
        } catch { }
    }
}

export async function loadSubtitle(filename) {
    if (!filename) {
        subtitleState.cues = [];
        subtitleState.settings.enabled = false;
        subtitleState.settings.selectedFile = null;
        if (dom.subtitleDisplay) dom.subtitleDisplay.innerHTML = '';
        return;
    }

    try {
        const res = await fetch(`/api/upload/subtitle/${state.roomId}/${filename}`);
        if (!res.ok) throw new Error('Failed to load subtitle');

        const content = await res.text();
        subtitleState.cues = parseSRT(content);
        subtitleState.settings.enabled = true;
        subtitleState.settings.selectedFile = filename;
        applySettings();
    } catch (e) {
        console.error('[Subtitles] Error loading subtitle:', e);
        subtitleState.cues = [];
        subtitleState.settings.enabled = false;
    }
}

export async function fetchAvailableSubtitles() {
    try {
        const res = await fetch(`/api/upload/subtitles/${state.roomId}`);
        if (!res.ok) return [];
        const data = await res.json();
        state.availableSubtitles = data.subtitles || [];
        return state.availableSubtitles;
    } catch {
        return [];
    }
}

export async function uploadSubtitleFile(file) {
    const headers = {};
    if (state.userToken) headers['x-room-token'] = state.userToken;
    if (state.clientId) headers['x-host-id'] = state.clientId;
    headers['x-filename'] = file.name;

    const res = await fetch(`/api/upload/subtitle/${state.roomId}`, {
        method: 'POST',
        headers,
        body: await file.arrayBuffer()
    });

    if (!res.ok) throw new Error('Upload failed');
    return res.json();
}

export function updateSettingsPanel() {
    if (!dom.settingsPanel) return;

    if (dom.subtitleSelect) {
        dom.subtitleSelect.innerHTML = '<option value="">Desativada</option>';
        for (const sub of state.availableSubtitles || []) {
            const opt = document.createElement('option');
            opt.value = sub.filename;
            opt.textContent = sub.displayName;
            opt.title = sub.displayName;
            if (subtitleState.settings.selectedFile === sub.filename) {
                opt.selected = true;
            }
            dom.subtitleSelect.appendChild(opt);
        }
    }

    if (dom.subtitleUploadZone) {
        dom.subtitleUploadZone.classList.toggle('hidden', !state.isHost);
    }

    if (dom.fontSizeSlider) dom.fontSizeSlider.value = subtitleState.settings.fontSize;
    if (dom.fontSizeValue) dom.fontSizeValue.textContent = `${subtitleState.settings.fontSize}px`;
    if (dom.fontFamilySelect) dom.fontFamilySelect.value = subtitleState.settings.fontFamily;
    if (dom.textColorPicker) dom.textColorPicker.value = subtitleState.settings.textColor;
    if (dom.bgEnabledToggle) dom.bgEnabledToggle.checked = subtitleState.settings.backgroundEnabled;
    if (dom.bgColorPicker) dom.bgColorPicker.value = subtitleState.settings.backgroundColor;
    if (dom.bgOpacitySlider) dom.bgOpacitySlider.value = subtitleState.settings.backgroundOpacity;
    if (dom.bgOpacityValue) dom.bgOpacityValue.textContent = `${Math.round(subtitleState.settings.backgroundOpacity * 100)}%`;
}

export function bindSettingsEvents() {
    dom.btnSettings?.addEventListener('click', async () => {
        await fetchAvailableSubtitles();
        updateSettingsPanel();
        dom.settingsPanel?.classList.toggle('open');
    });

    dom.btnCloseSettings?.addEventListener('click', () => {
        dom.settingsPanel?.classList.remove('open');
    });

    dom.subtitleSelect?.addEventListener('change', (e) => {
        const filename = e.target.value;
        loadSubtitle(filename || null);
    });

    dom.fontSizeSlider?.addEventListener('input', (e) => {
        subtitleState.settings.fontSize = parseInt(e.target.value);
        if (dom.fontSizeValue) dom.fontSizeValue.textContent = `${subtitleState.settings.fontSize}px`;
        applySettings();
    });

    dom.fontFamilySelect?.addEventListener('change', (e) => {
        subtitleState.settings.fontFamily = e.target.value;
        applySettings();
    });

    dom.textColorPicker?.addEventListener('input', (e) => {
        subtitleState.settings.textColor = e.target.value;
        applySettings();
    });

    dom.bgEnabledToggle?.addEventListener('change', (e) => {
        subtitleState.settings.backgroundEnabled = e.target.checked;
        applySettings();
    });

    dom.bgColorPicker?.addEventListener('input', (e) => {
        subtitleState.settings.backgroundColor = e.target.value;
        applySettings();
    });

    dom.bgOpacitySlider?.addEventListener('input', (e) => {
        subtitleState.settings.backgroundOpacity = parseFloat(e.target.value);
        if (dom.bgOpacityValue) dom.bgOpacityValue.textContent = `${Math.round(subtitleState.settings.backgroundOpacity * 100)}%`;
        applySettings();
    });

    dom.subtitlePreview?.addEventListener('click', () => { });

    dom.subtitleDropzone?.addEventListener('click', () => {
        dom.subtitleSessionInput?.click();
    });

    dom.subtitleDropzone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dom.subtitleDropzone.classList.add('dragover');
    });

    dom.subtitleDropzone?.addEventListener('dragleave', () => {
        dom.subtitleDropzone.classList.remove('dragover');
    });

    dom.subtitleDropzone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dom.subtitleDropzone.classList.remove('dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file && file.name.endsWith('.srt')) handleSubtitleUpload(file);
    });

    dom.subtitleSessionInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (file) await handleSubtitleUpload(file);
        e.target.value = '';
    });
}

async function handleSubtitleUpload(file) {
    const statusEl = dom.subtitleUploadStatus;
    if (statusEl) {
        statusEl.classList.remove('hidden', 'error');
        statusEl.textContent = `Enviando ${file.name}...`;
    }
    try {
        await uploadSubtitleFile(file);
        await fetchAvailableSubtitles();
        updateSettingsPanel();
        if (statusEl) {
            statusEl.textContent = `✓ ${file.name}`;
            setTimeout(() => statusEl.classList.add('hidden'), 3000);
        }
    } catch (err) {
        console.error('[Subtitles] Upload failed:', err);
        if (statusEl) {
            statusEl.classList.add('error');
            statusEl.textContent = 'Falha no envio';
            setTimeout(() => statusEl.classList.add('hidden'), 4000);
        }
    }
}

export function initSubtitles() {
    loadSettingsFromStorage();
    applySettings();
    bindSettingsEvents();

    if (dom.video) {
        new ResizeObserver(() => applySettings()).observe(dom.video);
    }
}
