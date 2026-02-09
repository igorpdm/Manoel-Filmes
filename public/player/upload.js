import { dom } from './dom.js';
import { state, constants } from './state.js';
import { formatBytes, formatEta } from './utils.js';
import { showUploadProgress, showAudioTrackSelection, showProcessingProgress, updateUploadProgress } from './ui.js';

function log(...args) {
    if (location.hostname === 'localhost') {
        console.log('[ManoelPlayer]', ...args);
    }
}

function buildAuthHeaders() {
    const headers = {};
    if (state.userToken) headers['x-room-token'] = state.userToken;
    if (state.clientId) headers['x-host-id'] = state.clientId;
    return headers;
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getUploadStorageKey() {
    return `upload_${state.roomId}`;
}

function getStoredUpload(file) {
    const raw = localStorage.getItem(getUploadStorageKey());
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (data.size !== file.size) return null;
        if (data.name !== file.name) return null;
        return data;
    } catch {
        return null;
    }
}

function storeUpload(uploadId, file, totalChunks) {
    localStorage.setItem(getUploadStorageKey(), JSON.stringify({
        uploadId,
        name: file.name,
        size: file.size,
        totalChunks
    }));
}

function clearStoredUpload() {
    localStorage.removeItem(getUploadStorageKey());
}

async function fetchUploadStatus(uploadId) {
    const res = await fetch(`/api/upload/status/${state.roomId}/${uploadId}`, {
        method: 'GET',
        headers: { ...buildAuthHeaders() }
    });
    if (!res.ok) return null;
    return res.json();
}

async function abortUpload(uploadId) {
    try {
        await fetch(`/api/upload/abort/${state.roomId}/${uploadId}`, {
            method: 'POST',
            headers: { ...buildAuthHeaders() }
        });
    } catch {
        return;
    }
}

async function confirmAudioTrackSelection() {
    if (!state.isHost || !dom.audioTrackSelect) return;

    const streamIndex = Number(dom.audioTrackSelect.value);
    if (!Number.isInteger(streamIndex)) {
        if (dom.audioTrackError) {
            dom.audioTrackError.textContent = 'Selecione uma faixa de áudio válida.';
            dom.audioTrackError.classList.remove('hidden');
        }
        return;
    }

    if (dom.audioTrackError) {
        dom.audioTrackError.textContent = '';
        dom.audioTrackError.classList.add('hidden');
    }

    if (dom.btnConfirmAudioTrack) {
        dom.btnConfirmAudioTrack.disabled = true;
        dom.btnConfirmAudioTrack.textContent = 'Processando...';
    }

    try {
        const response = await fetch(`/api/upload/audio-track/${state.roomId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
            body: JSON.stringify({ streamIndex })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || 'Erro ao confirmar faixa de áudio');
        }

        state.selectedAudioStreamIndex = streamIndex;
        showProcessingProgress('Processando vídeo... (Isso pode levar alguns minutos)');
    } catch (error) {
        if (dom.audioTrackError) {
            dom.audioTrackError.textContent = error?.message || 'Erro ao confirmar faixa de áudio';
            dom.audioTrackError.classList.remove('hidden');
        }
    } finally {
        if (dom.btnConfirmAudioTrack) {
            dom.btnConfirmAudioTrack.disabled = false;
            dom.btnConfirmAudioTrack.textContent = 'Confirmar faixa';
        }
    }
}

export async function uploadFile(file) {
    if (!state.isHost) return;

    showUploadProgress(0);
    dom.uploadStatus.textContent = `Preparando: ${file.name}`;

    const totalChunks = Math.ceil(file.size / constants.CHUNK_SIZE);
    const stored = getStoredUpload(file);

    let uploadId = null;
    let existingChunks = [];

    if (stored?.uploadId) {
        const status = await fetchUploadStatus(stored.uploadId);
        const safeName = sanitizeFilename(file.name);
        if (status && status.filename === safeName && status.totalChunks === totalChunks) {
            uploadId = stored.uploadId;
            existingChunks = status.existingChunks || [];
            dom.uploadStatus.textContent = 'Retomando upload...';
        } else {
            clearStoredUpload();
        }
    }

    try {
        if (!uploadId) {
            const initRes = await fetch(`/api/upload/init/${state.roomId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
                body: JSON.stringify({
                    filename: file.name,
                    totalChunks,
                    totalSize: file.size,
                    chunkSize: constants.CHUNK_SIZE
                })
            });

            if (!initRes.ok) throw new Error('Erro ao iniciar upload');

            const initData = await initRes.json();
            uploadId = initData.uploadId;
            existingChunks = [];
            storeUpload(uploadId, file, totalChunks);
        }

        const existingSet = new Set(existingChunks);
        let completedBytes = 0;
        let completedChunks = existingChunks.length;
        
        if (existingChunks.length) {
            completedBytes = existingChunks.reduce((acc, idx) => {
                const start = idx * constants.CHUNK_SIZE;
                const end = Math.min(start + constants.CHUNK_SIZE, file.size);
                return acc + (end - start);
            }, 0);
            updateUploadProgress(Math.min(99, Math.round((completedBytes / file.size) * 100)));
        }

        const startTimeGlobal = Date.now();

        const chunkQueue = [];
        for (let i = 0; i < totalChunks; i++) {
            if (!existingSet.has(i)) {
                chunkQueue.push(i);
            }
        }
        const totalToUpload = chunkQueue.length;

        const activeProgress = new Map();
        let lastProgressUpdate = 0;

        const updateGlobalProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastProgressUpdate < constants.PROGRESS_THROTTLE) return;
            lastProgressUpdate = now;

            let currentUploadBytes = 0;
            for (const bytes of activeProgress.values()) {
                currentUploadBytes += bytes;
            }
            const totalCurrent = completedBytes + currentUploadBytes;
            const globalPercent = Math.min(99, Math.round((totalCurrent / file.size) * 100));
            
            const elapsedGlobal = (now - startTimeGlobal) / 1000;
            const speed = elapsedGlobal > 0 ? totalCurrent / elapsedGlobal : 0;
            const remainingBytes = file.size - totalCurrent;
            const eta = speed > 0 ? remainingBytes / speed : 0;

            updateUploadProgress(globalPercent);
            if (dom.uploadSizeEl) dom.uploadSizeEl.textContent = `${formatBytes(totalCurrent)} / ${formatBytes(file.size)}`;
            if (dom.uploadSpeedEl) dom.uploadSpeedEl.textContent = `${formatBytes(speed)}/s`;
            if (dom.uploadEtaEl) dom.uploadEtaEl.textContent = formatEta(eta);
        };

        const uploadChunk = async (i) => {
            const start = i * constants.CHUNK_SIZE;
            const end = Math.min(start + constants.CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const chunkSize = end - start;

            const maxRetries = 3;
            let attempt = 0;
            let chunkSuccess = false;

            while (attempt < maxRetries && !chunkSuccess) {
                attempt++;
                try {
                    await new Promise((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.timeout = constants.UPLOAD_TIMEOUT;
                        xhr.open('POST', `/api/upload/chunk/${state.roomId}/${uploadId}/${i}`);

                        const headers = buildAuthHeaders();
                        Object.entries(headers).forEach(([key, value]) => {
                            xhr.setRequestHeader(key, value);
                        });

                        xhr.upload.onprogress = (e) => {
                            if (e.lengthComputable) {
                                activeProgress.set(i, e.loaded);
                                updateGlobalProgress();
                            }
                        };

                        xhr.onload = () => {
                            if (xhr.status === 200) {
                                resolve();
                            } else {
                                reject(new Error(`Erro no upload status ${xhr.status}`));
                            }
                        };
                        xhr.onerror = () => reject(new Error('Erro de rede'));
                        xhr.ontimeout = () => reject(new Error('Timeout'));
                        xhr.send(chunk);
                    });
                    chunkSuccess = true;
                    activeProgress.delete(i);
                    completedBytes += chunkSize;
                    completedChunks++;
                    updateGlobalProgress(true);
                } catch (err) {
                    activeProgress.delete(i);
                    if (attempt >= maxRetries) throw err;
                    await new Promise(r => setTimeout(r, 300 * attempt));
                }
            }
        };

        const worker = async () => {
            while (chunkQueue.length > 0) {
                const chunkIndex = chunkQueue.shift();
                if (chunkIndex === undefined) return;
                const remaining = chunkQueue.length + activeProgress.size;
                const uploading = activeProgress.size + 1;
                dom.uploadStatus.textContent = `Enviando ${uploading} chunk${uploading > 1 ? 's' : ''} (${remaining} restante${remaining !== 1 ? 's' : ''})`;
                await uploadChunk(chunkIndex);
            }
        };

        const concurrency = Math.min(constants.UPLOAD_CONCURRENCY, chunkQueue.length);

        const abortController = new AbortController();
        const onUnload = () => {
             abortController.abort();
        };
        window.addEventListener('beforeunload', onUnload);

        const workers = Array(concurrency).fill(0).map(() => worker());

        try {
            await Promise.all(workers);
        } finally {
            window.removeEventListener('beforeunload', onUnload);
        }

        dom.uploadStatus.textContent = 'Finalizando...';
        updateUploadProgress(100);

        const completeRes = await fetch(`/api/upload/complete/${state.roomId}/${uploadId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
            body: JSON.stringify({ filename: file.name, totalChunks })
        });
        
        const completeData = await completeRes.json().catch(() => ({}));
        if (!completeRes.ok) {
            throw new Error(completeData.error || 'Erro ao finalizar upload');
        }

        clearStoredUpload();

        if (completeData.requiresAudioSelection) {
            showAudioTrackSelection(completeData.audioTracks || []);
        } else if (completeData.processing) {
            showProcessingProgress('Processando vídeo... (Isso pode levar alguns minutos)');
        }

    } catch (err) {
        log('Erro:', err);
        // Evita loop de retomada quando a sessão já foi encerrada.
        const message = err?.message || '';
        if (message.includes('403')) {
            clearStoredUpload();
            dom.uploadStatus.textContent = 'Upload cancelado (Sessão encerrada)';
            return;
        }

        if (uploadId) {
            await abortUpload(uploadId);
        }
        clearStoredUpload();
        dom.uploadStatus.textContent = 'Erro no upload';
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    }
}

function renderPendingSubtitles() {
    if (!dom.subtitlesPendingList) return;
    dom.subtitlesPendingList.innerHTML = '';

    for (let i = 0; i < state.pendingSubtitleFiles.length; i++) {
        const file = state.pendingSubtitleFiles[i];
        const item = document.createElement('div');
        item.className = 'subtitle-pending-item';
        item.innerHTML = `
            <span class="subtitle-pending-name" title="${file.name}">${file.name}</span>
            <button type="button" class="subtitle-pending-remove" data-index="${i}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        `;
        dom.subtitlesPendingList.appendChild(item);
    }

    dom.subtitlesPendingList.querySelectorAll('.subtitle-pending-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.index);
            state.pendingSubtitleFiles.splice(idx, 1);
            renderPendingSubtitles();
        });
    });
}

async function uploadPendingSubtitles() {
    const { uploadSubtitleFile } = await import('./subtitles.js');
    for (const file of state.pendingSubtitleFiles) {
        try {
            await uploadSubtitleFile(file);
        } catch (e) {
            console.error('[Upload] Failed to upload subtitle:', file.name, e);
        }
    }
    state.pendingSubtitleFiles = [];
    renderPendingSubtitles();
}

export function bindUploadEvents() {
    dom.btnConfirmAudioTrack?.addEventListener('click', confirmAudioTrackSelection);

    dom.btnSelectFile?.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            await uploadFile(file);
            await uploadPendingSubtitles();
        }
    });

    dom.btnAddSubtitles?.addEventListener('click', () => dom.subtitleInput?.click());
    dom.subtitleInput?.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.srt')) {
                state.pendingSubtitleFiles.push(file);
            }
        }
        renderPendingSubtitles();
        dom.subtitleInput.value = '';
    });

    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    if (dom.uploadZone) {
        dom.uploadZone.addEventListener('dragover', (e) => {
            if (!state.isHost) return;
            e.preventDefault();
            dom.uploadZone.classList.add('dragover');
        });
        dom.uploadZone.addEventListener('dragleave', () => dom.uploadZone.classList.remove('dragover'));
        dom.uploadZone.addEventListener('drop', async (e) => {
            if (!state.isHost) return;
            e.preventDefault();
            dom.uploadZone.classList.remove('dragover');

            const files = Array.from(e.dataTransfer.files);
            let videoFile = null;

            for (const file of files) {
                if (file.name.toLowerCase().endsWith('.srt')) {
                    state.pendingSubtitleFiles.push(file);
                } else if (file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mkv')) {
                    videoFile = file;
                }
            }

            renderPendingSubtitles();

            if (videoFile) {
                await uploadFile(videoFile);
                await uploadPendingSubtitles();
            }
        });
    }
}
