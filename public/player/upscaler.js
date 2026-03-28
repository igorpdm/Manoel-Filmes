import { dom } from './dom.js';
import { UpscalerRenderer } from './upscaler-renderer.js';

const STORAGE_KEY = 'manoel_player_upscaler_settings';

const algorithmConfigs = {
    fsr1: {
        intensityLabel: 'Sharpening',
        min: 0,
        max: 1,
        step: 0.1,
        defaultIntensity: 0.5,
    },
    cas: {
        intensityLabel: 'Intensity',
        min: 0,
        max: 1.2,
        step: 0.1,
        defaultIntensity: 1.0,
    },
};

const defaultSettings = {
    isEnabled: true,
    algorithm: 'fsr1',
    fsr1Intensity: algorithmConfigs.fsr1.defaultIntensity,
    casIntensity: algorithmConfigs.cas.defaultIntensity,
};

const upscalerState = {
    renderer: null,
    isSupported: false,
    frameRequestId: null,
    settings: { ...defaultSettings },
    resizeObserver: null,
};

function normalizeIntensityValue(value, algorithm) {
    const config = algorithmConfigs[algorithm];
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return config.defaultIntensity;
    }

    const clampedValue = Math.min(config.max, Math.max(config.min, numericValue));
    return Math.round(clampedValue * 10) / 10;
}

function normalizeSettings(settings) {
    const safeSettings = settings && typeof settings === 'object' ? settings : {};
    const algorithm = safeSettings.algorithm === 'cas' ? 'cas' : 'fsr1';

    return {
        isEnabled: typeof safeSettings.isEnabled === 'boolean'
            ? safeSettings.isEnabled
            : defaultSettings.isEnabled,
        algorithm,
        fsr1Intensity: normalizeIntensityValue(safeSettings.fsr1Intensity, 'fsr1'),
        casIntensity: normalizeIntensityValue(safeSettings.casIntensity, 'cas'),
    };
}

function loadSettings() {
    const rawSettings = localStorage.getItem(STORAGE_KEY);
    if (!rawSettings) {
        return;
    }

    try {
        const parsedSettings = JSON.parse(rawSettings);
        upscalerState.settings = normalizeSettings(parsedSettings);
    } catch {
        upscalerState.settings = { ...defaultSettings };
    }
}

function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(upscalerState.settings));
}

function stopRenderLoop() {
    if (upscalerState.frameRequestId !== null) {
        cancelAnimationFrame(upscalerState.frameRequestId);
        upscalerState.frameRequestId = null;
    }
}

function getCurrentAlgorithmConfig() {
    return algorithmConfigs[upscalerState.settings.algorithm];
}

function getCurrentIntensity() {
    return upscalerState.settings.algorithm === 'cas'
        ? upscalerState.settings.casIntensity
        : upscalerState.settings.fsr1Intensity;
}

function setCurrentIntensity(value) {
    const normalizedValue = normalizeIntensityValue(value, upscalerState.settings.algorithm);

    if (upscalerState.settings.algorithm === 'cas') {
        upscalerState.settings.casIntensity = normalizedValue;
        return;
    }

    upscalerState.settings.fsr1Intensity = normalizedValue;
}

function shouldRenderContinuously() {
    if (!upscalerState.isSupported || !upscalerState.settings.isEnabled) {
        return false;
    }

    if (!dom.video.currentSrc || dom.video.paused || dom.video.ended) {
        return false;
    }

    return dom.video.readyState >= dom.video.HAVE_CURRENT_DATA;
}

function updateCanvasVisibility() {
    if (!dom.videoCanvas) {
        return;
    }

    const shouldShow = upscalerState.isSupported
        && upscalerState.settings.isEnabled
        && Boolean(dom.video.currentSrc);

    dom.videoCanvas.classList.toggle('hidden', !shouldShow);
}

function updateControls() {
    const controlsAreInteractive = upscalerState.isSupported;
    const intensityIsInteractive = controlsAreInteractive && upscalerState.settings.isEnabled;
    const currentAlgorithmConfig = getCurrentAlgorithmConfig();
    const currentIntensity = getCurrentIntensity();

    if (dom.upscalerEnabledToggle) {
        dom.upscalerEnabledToggle.checked = upscalerState.settings.isEnabled;
        dom.upscalerEnabledToggle.disabled = !controlsAreInteractive;
        dom.upscalerEnabledToggle.closest('.toggle-label')?.setAttribute('aria-disabled', String(!controlsAreInteractive));
    }

    if (dom.upscalerAlgorithm) {
        dom.upscalerAlgorithm.value = upscalerState.settings.algorithm;
        dom.upscalerAlgorithm.disabled = !controlsAreInteractive;
    }

    if (dom.upscalerIntensityLabel) {
        dom.upscalerIntensityLabel.textContent = currentAlgorithmConfig.intensityLabel;
    }

    if (dom.upscalerIntensitySlider) {
        dom.upscalerIntensitySlider.min = String(currentAlgorithmConfig.min);
        dom.upscalerIntensitySlider.max = String(currentAlgorithmConfig.max);
        dom.upscalerIntensitySlider.step = String(currentAlgorithmConfig.step);
        dom.upscalerIntensitySlider.value = String(currentIntensity);
        dom.upscalerIntensitySlider.disabled = !intensityIsInteractive;
    }

    if (dom.upscalerIntensityValue) {
        dom.upscalerIntensityValue.textContent = currentIntensity.toFixed(1);
    }
}

function applySettings() {
    if (upscalerState.renderer) {
        upscalerState.renderer.setSettings({
            isEnabled: upscalerState.settings.isEnabled,
            algorithm: upscalerState.settings.algorithm,
            intensity: getCurrentIntensity(),
        });
    }

    updateControls();
    updateCanvasVisibility();
    saveSettings();
    renderCurrentFrame();

    if (shouldRenderContinuously()) {
        startRenderLoop();
        return;
    }

    stopRenderLoop();
}

function disableUpscaler(message) {
    upscalerState.isSupported = false;
    stopRenderLoop();
    updateControls();
    updateCanvasVisibility();
    console.error('[Upscaler]', message);
}

function renderCurrentFrame() {
    if (!upscalerState.isSupported || !upscalerState.settings.isEnabled || !upscalerState.renderer) {
        return;
    }

    updateCanvasVisibility();

    if (dom.videoCanvas?.classList.contains('hidden')) {
        return;
    }

    try {
        upscalerState.renderer.resize();
        upscalerState.renderer.render();
    } catch (error) {
        disableUpscaler('Falha ao inicializar o WebGL. O player usará o vídeo original.');
        console.error('[Upscaler] Render failed:', error);
    }
}

function queueNextFrame() {
    if (!shouldRenderContinuously()) {
        stopRenderLoop();
        return;
    }

    upscalerState.frameRequestId = requestAnimationFrame(() => {
        upscalerState.frameRequestId = null;
        renderCurrentFrame();
        queueNextFrame();
    });
}

function startRenderLoop() {
    if (upscalerState.frameRequestId !== null) {
        return;
    }

    queueNextFrame();
}

function bindControls() {
    dom.upscalerEnabledToggle?.addEventListener('change', (event) => {
        upscalerState.settings.isEnabled = event.target.checked;
        applySettings();
    });

    dom.upscalerAlgorithm?.addEventListener('change', (event) => {
        upscalerState.settings.algorithm = event.target.value === 'cas' ? 'cas' : 'fsr1';
        applySettings();
    });

    dom.upscalerIntensitySlider?.addEventListener('input', (event) => {
        setCurrentIntensity(event.target.value);
        applySettings();
    });
}

function bindVideoEvents() {
    dom.video.addEventListener('loadedmetadata', renderCurrentFrame);
    dom.video.addEventListener('loadeddata', renderCurrentFrame);
    dom.video.addEventListener('canplay', renderCurrentFrame);
    dom.video.addEventListener('seeked', renderCurrentFrame);
    dom.video.addEventListener('pause', () => {
        stopRenderLoop();
        renderCurrentFrame();
    });
    dom.video.addEventListener('play', startRenderLoop);
    dom.video.addEventListener('playing', startRenderLoop);
    dom.video.addEventListener('waiting', stopRenderLoop);
    dom.video.addEventListener('ended', stopRenderLoop);
    dom.video.addEventListener('emptied', () => {
        stopRenderLoop();
        updateCanvasVisibility();
    });
}

function bindResizeEvents() {
    if ('ResizeObserver' in window) {
        upscalerState.resizeObserver = new ResizeObserver(() => {
            if (!upscalerState.renderer) {
                return;
            }

            upscalerState.renderer.resize();
            renderCurrentFrame();
        });

        upscalerState.resizeObserver.observe(dom.playerContainer);
    }

    document.addEventListener('fullscreenchange', renderCurrentFrame);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopRenderLoop();
            return;
        }

        renderCurrentFrame();

        if (shouldRenderContinuously()) {
            startRenderLoop();
        }
    });
    window.addEventListener('resize', renderCurrentFrame);
}

function createRenderer() {
    if (!dom.videoCanvas || !dom.video) {
        disableUpscaler('Canvas do upscaler não encontrado.');
        return;
    }

    try {
        upscalerState.renderer = new UpscalerRenderer(dom.videoCanvas, dom.video);
        upscalerState.isSupported = true;
    } catch (error) {
        disableUpscaler('WebGL indisponível. O player usará o vídeo original.');
        console.error('[Upscaler] Initialization failed:', error);
    }
}

export function initUpscaler() {
    loadSettings();
    createRenderer();
    bindControls();
    bindVideoEvents();
    bindResizeEvents();
    applySettings();
}
