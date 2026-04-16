import { dom } from './dom.js';
import { UpscalerRenderer } from './upscaler-renderer.js';
import { UpscalerRendererWebGPU } from './upscaler-renderer-webgpu.js';

const STORAGE_KEY = 'manoel_player_upscaler_settings';

const defaultSettings = {
    isEnabled: true,
    intensity: 0.5,
};

const upscalerState = {
    renderer: null,
    isSupported: false,
    animationFrameRequestId: null,
    videoFrameRequestId: null,
    settings: { ...defaultSettings },
    resizeObserver: null,
};

function normalizeIntensityValue(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return defaultSettings.intensity;
    }

    const clampedValue = Math.min(1.2, Math.max(0, numericValue));
    return Math.round(clampedValue * 10) / 10;
}

function normalizeSettings(settings) {
    const safeSettings = settings && typeof settings === 'object' ? settings : {};
    const persistedIntensity = safeSettings.intensity ?? safeSettings.fsr1Intensity ?? safeSettings.casIntensity;

    return {
        isEnabled: typeof safeSettings.isEnabled === 'boolean'
            ? safeSettings.isEnabled
            : defaultSettings.isEnabled,
        intensity: normalizeIntensityValue(persistedIntensity),
    };
}

function loadSettings() {
    const rawSettings = localStorage.getItem(STORAGE_KEY);
    if (!rawSettings) {
        return;
    }

    try {
        upscalerState.settings = normalizeSettings(JSON.parse(rawSettings));
    } catch {
        upscalerState.settings = { ...defaultSettings };
    }
}

function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(upscalerState.settings));
}

function stopRenderLoop() {
    if (
        upscalerState.videoFrameRequestId !== null
        && typeof dom.video?.cancelVideoFrameCallback === 'function'
    ) {
        dom.video.cancelVideoFrameCallback(upscalerState.videoFrameRequestId);
        upscalerState.videoFrameRequestId = null;
    }

    if (upscalerState.animationFrameRequestId !== null) {
        cancelAnimationFrame(upscalerState.animationFrameRequestId);
        upscalerState.animationFrameRequestId = null;
    }
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

function mountCanvas() {
    if (dom.videoCanvas) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'video-canvas';
    canvas.className = 'video-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    dom.video.insertAdjacentElement('afterend', canvas);
    dom.videoCanvas = canvas;
}

function unmountCanvas() {
    dom.videoCanvas?.remove();
    dom.videoCanvas = null;
}

function updateControls() {
    const controlsAreInteractive = upscalerState.isSupported;
    const intensityIsInteractive = controlsAreInteractive && upscalerState.settings.isEnabled;

    if (dom.upscalerEnabledToggle) {
        dom.upscalerEnabledToggle.checked = upscalerState.settings.isEnabled;
        dom.upscalerEnabledToggle.disabled = !controlsAreInteractive;
        dom.upscalerEnabledToggle.closest('.toggle-label')?.setAttribute('aria-disabled', String(!controlsAreInteractive));
    }

    if (dom.upscalerIntensityLabel) {
        dom.upscalerIntensityLabel.textContent = 'Sharpening';
    }

    if (dom.upscalerIntensityGroup) {
        dom.upscalerIntensityGroup.classList.toggle('hidden', !upscalerState.settings.isEnabled || !upscalerState.isSupported);
    }

    if (dom.upscalerIntensitySlider) {
        dom.upscalerIntensitySlider.value = String(upscalerState.settings.intensity);
        dom.upscalerIntensitySlider.max = '1.2';
        dom.upscalerIntensitySlider.disabled = !intensityIsInteractive;
    }

    if (dom.upscalerIntensityValue) {
        dom.upscalerIntensityValue.textContent = upscalerState.settings.intensity.toFixed(1);
    }
}

async function applySettings() {
    if (!upscalerState.settings.isEnabled) {
        stopRenderLoop();
        upscalerState.renderer?.dispose();
        upscalerState.renderer = null;
        unmountCanvas();
        updateControls();
        saveSettings();
        return;
    }

    // isEnabled é true — garante que canvas e renderer existem
    if (!dom.videoCanvas) {
        await createRenderer();
    }

    if (upscalerState.renderer) {
        upscalerState.renderer.setSettings({
            isEnabled: upscalerState.settings.isEnabled,
            intensity: upscalerState.settings.intensity,
        });
    }

    updateControls();
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
    upscalerState.renderer?.dispose();
    upscalerState.renderer = null;
    updateControls();
    unmountCanvas();
    console.error('[Upscaler]', message);
}

function renderCurrentFrame() {
    if (!upscalerState.isSupported || !upscalerState.settings.isEnabled || !upscalerState.renderer) {
        return;
    }

    try {
        upscalerState.renderer.render();
    } catch (error) {
        disableUpscaler('Falha ao renderizar. O player usará o vídeo original.');
        console.error('[Upscaler] Render failed:', error);
    }
}

function scheduleNextFrame() {
    if (!shouldRenderContinuously()) {
        stopRenderLoop();
        return;
    }

    if (
        typeof dom.video?.requestVideoFrameCallback === 'function'
        && typeof dom.video?.cancelVideoFrameCallback === 'function'
    ) {
        if (upscalerState.videoFrameRequestId !== null) {
            return;
        }

        upscalerState.videoFrameRequestId = dom.video.requestVideoFrameCallback(() => {
            upscalerState.videoFrameRequestId = null;
            renderCurrentFrame();
            scheduleNextFrame();
        });
        return;
    }

    if (upscalerState.animationFrameRequestId !== null) {
        return;
    }

    upscalerState.animationFrameRequestId = requestAnimationFrame(() => {
        upscalerState.animationFrameRequestId = null;
        renderCurrentFrame();
        scheduleNextFrame();
    });
}

function startRenderLoop() {
    scheduleNextFrame();
}

function bindControls() {
    dom.upscalerEnabledToggle?.addEventListener('change', (event) => {
        upscalerState.settings.isEnabled = event.target.checked;
        applySettings();
    });

    dom.upscalerIntensitySlider?.addEventListener('input', (event) => {
        upscalerState.settings.intensity = normalizeIntensityValue(event.target.value);
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

async function createRenderer() {
    mountCanvas();

    if (!dom.videoCanvas || !dom.video) {
        disableUpscaler('Canvas do upscaler não encontrado.');
        return;
    }

    if (navigator.gpu) {
        try {
            upscalerState.renderer = await UpscalerRendererWebGPU.create(dom.videoCanvas, dom.video);
            upscalerState.isSupported = true;
            console.log('[Upscaler] Usando WebGPU.');
            return;
        } catch (error) {
            console.warn('[Upscaler] WebGPU falhou, tentando WebGL2:', error);
        }
    }

    try {
        upscalerState.renderer = new UpscalerRenderer(dom.videoCanvas, dom.video);
        upscalerState.isSupported = true;
        console.log('[Upscaler] Usando WebGL2.');
    } catch (error) {
        disableUpscaler('WebGL2 indisponível. O player usará o vídeo original.');
        console.error('[Upscaler] Initialization failed:', error);
    }
}

export async function initUpscaler() {
    loadSettings();
    await createRenderer();
    bindControls();
    bindVideoEvents();
    bindResizeEvents();
    applySettings();
}
