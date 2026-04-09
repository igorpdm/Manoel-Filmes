import { dom } from './dom.js';
import { buildRoomHeaders, state, constants } from './state.js';
import {
    updateSyncStatus,
    updateHostUI,
    showPlayer,
    showUploadProgress,
    showAudioTrackSelection,
    showProcessingProgress,
    showRatingModal,
    showRatingProgress,
    handleSessionEnded,
    renderUserList,
    updatePlayPauseUI,
    showHostNotification,
    resetForNextEpisode,
    populateMovieModal
} from './ui.js';
import { fetchAvailableSubtitles, updateSettingsPanel } from './subtitles.js';

function log(...args) {
    if (location.hostname === 'localhost') {
        console.log('[ManoelPlayer]', ...args);
    }
}

function markRemote() {
    state.lastRemoteTimestamp = Date.now();
}

export function isFromRemote() {
    return Date.now() - state.lastRemoteTimestamp < constants.REMOTE_COOLDOWN;
}

function getSyncThreshold() {
    if (state.latency > 300) return 1.0;
    if (state.latency > 150) return 0.7;
    return constants.BASE_SYNC_THRESHOLD;
}

function getCompensatedTime(serverTime, baseTime, isPlaying) {
    if (!serverTime || baseTime == null) return baseTime || 0;

    const localNow = Date.now();
    const serverNow = localNow + state.clockOffset;
    const elapsedSinceServerUpdate = (serverNow - serverTime) / 1000;

    if (isPlaying && elapsedSinceServerUpdate > 0) {
        return baseTime + elapsedSinceServerUpdate;
    }
    return baseTime;
}

function applySync(data) {
    markRemote();

    const targetTime = getCompensatedTime(data.serverTime, data.currentTime, data.isPlaying);
    const diff = Math.abs(dom.video.currentTime - targetTime);

    const isBuffering = dom.video.readyState < 3;
    const shouldSkipSeek = isBuffering && diff < 3.0;

    if (diff > getSyncThreshold() && !shouldSkipSeek) {
        dom.video.currentTime = targetTime;
    }

    if (data.isPlaying && dom.video.paused) {
        dom.video.play().catch(() => {
            updateSyncStatus('loading', 'Sincronizando...');
            requestState();
            schedulePlayRetry();
        });
    } else if (!data.isPlaying && !dom.video.paused) {
        dom.video.pause();
    }

    updatePlayPauseUI();
}

export function sendCommand(type, currentTime) {
    if (state.ws?.readyState === WebSocket.OPEN && state.isHost) {
        state.commandSeq += 1;
        state.ws.send(JSON.stringify({ type, currentTime, timestamp: Date.now(), seq: state.commandSeq }));
    }
}

export function requestState() {
    if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'state' }));
    }
}

function schedulePlayRetry() {
    if (state.playRetryTimer) return;
    state.playRetryTimer = setTimeout(() => {
        state.playRetryTimer = null;
        if (state.ws?.readyState !== WebSocket.OPEN) return;
        if (!state.hasVideo) return;
        requestState();
        dom.video.play().catch(() => updateSyncStatus('loading', 'Sincronizando...'));
    }, 1000);
}

function startHeartbeat() {
    if (state.heartbeatTimer) return;
    state.heartbeatTimer = setInterval(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
    }, 5000);
}

function stopHeartbeat() {
    if (!state.heartbeatTimer) return;
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
}

function startHostHeartbeat() {
    if (state.hostHeartbeatTimer) return;
    state.hostHeartbeatTimer = setInterval(() => {
        if (state.ws?.readyState === WebSocket.OPEN && state.isHost) {
            state.ws.send(JSON.stringify({ type: 'host-heartbeat', timestamp: Date.now() }));
        }
    }, 4000);
}

function stopHostHeartbeat() {
    if (!state.hostHeartbeatTimer) return;
    clearInterval(state.hostHeartbeatTimer);
    state.hostHeartbeatTimer = null;
}

async function fetchUserDiscordId() {
    if (!state.userToken || state.currentDiscordId) return;
    try {
        const res = await fetch(`/api/validate-token/${state.roomId}`, {
            headers: buildRoomHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            state.currentDiscordId = data.discordId;
        }
    } catch (e) {
        log('Erro ao obter discordId:', e);
    }
}

function getCurrentRatingParticipant(ratingProgress) {
    if (!ratingProgress?.participants?.length || !state.currentDiscordId) {
        return null;
    }

    return ratingProgress.participants.find((participant) => participant.discordId === state.currentDiscordId) || null;
}

function shouldRevealRatingProgress(ratingProgress) {
    if (!ratingProgress) {
        return false;
    }

    if (ratingProgress.isClosed) {
        return true;
    }

    return getCurrentRatingParticipant(ratingProgress)?.status === 'rated';
}

function handleMessage(data) {
    switch (data.type) {
        case 'pong':
            const now = Date.now();
            const rtt = now - data.timestamp;
            const newLatency = rtt / 2;

            if (state.latencySamples === 0) {
                state.latency = newLatency;
            } else {
                state.latency = constants.EWMA_ALPHA * newLatency + (1 - constants.EWMA_ALPHA) * state.latency;
            }
            state.latencySamples += 1;

            const wasSlowConnection = state.isSlowConnection;
            state.isSlowConnection = state.latency > 200;
            if (state.isSlowConnection && !wasSlowConnection) {
                updateSyncStatus('loading', 'Conexão lenta detectada');
                setTimeout(() => dom.syncIndicator.style.opacity = '0', 3000);
            }

            if (data.serverTime) {
                const estimatedServerTimeNow = data.serverTime + newLatency;
                state.clockOffset = estimatedServerTimeNow - now;
            }

            const pVal = Math.round(newLatency);
            if (dom.selfPingValue) dom.selfPingValue.textContent = pVal + ' ms';
            if (dom.selfPingDot) {
                dom.selfPingDot.parentElement.className = 'ping-display ' +
                    (pVal < 150 ? 'ping-good' : pVal < 300 ? 'ping-fair' : 'ping-poor');
            }

            if (dom.networkSpeedBadge && dom.networkSpeedEl) {
                dom.networkSpeedBadge.style.display = 'flex';
                dom.networkSpeedEl.textContent = pVal + ' ms';
                dom.networkSpeedBadge.style.color =
                    pVal < 150 ? '#22c55e' : pVal < 300 ? '#f59e0b' : '#ef4444';
            }

            if (state.ws?.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'update-metrics',
                    metrics: { lastPing: pVal }
                }));
            }
            break;
        case 'sync':
            if (data.isHost !== undefined) {
                const wasHost = state.isHost;
                state.isHost = data.isHost;
                updateHostUI();
                if (state.isHost && !wasHost) startHostHeartbeat();
                if (!state.isHost && wasHost) stopHostHeartbeat();
            }
            if (state.hasVideo) applySync(data);
            break;
        case 'viewers':
            dom.viewerCount.textContent = data.count || 0;
            if (data.viewers) {
                renderUserList(data.viewers);
            }
            if (data.viewers && state.userToken && !state.currentDiscordId) {
                fetchUserDiscordId();
            }
            break;
        case 'upload-start':
            showUploadProgress(0);
            if (!state.isHost) {
                const filename = data.filename || 'arquivo';
                dom.waitingOverlay.querySelector('p').textContent = `O host iniciou o envio: ${filename}`;
            }
            break;
        case 'upload-progress':
            showUploadProgress(data.progress || 0);
            break;
        case 'audio-track-selection-required':
            showAudioTrackSelection(data.audioTracks || [], data.errorMessage || '');
            break;
        case 'pending-upload-cancelled':
            state.roomStage = 'idle';
            state.hasVideo = false;
            state.audioTracks = [];
            state.selectedAudioStreamIndex = null;
            state.audioSelectionErrorMessage = '';
            updateHostUI();
            break;
        case 'processing-progress':
            const msg = data.processingMessage || 'Processando vídeo...';
            showProcessingProgress(msg);
            break;
        case 'video-ready':
            showPlayer();
            break;
        case 'session-ending':
            dom.video.pause();
            showRatingModal();
            break;
        case 'rating-progress':
            if (data.ratingProgress) {
                state.ratingProgress = data.ratingProgress;

                const currentParticipant = getCurrentRatingParticipant(data.ratingProgress);

                if (
                    currentParticipant?.status === 'pending' &&
                    dom.modalRatingEl.classList.contains('hidden') &&
                    dom.modalRatingResults.classList.contains('hidden')
                ) {
                    showRatingModal();
                }

                if (shouldRevealRatingProgress(data.ratingProgress)) {
                    showRatingProgress(data.ratingProgress);
                }
            }
            break;
        case 'session-ended':
            if (state.ratingProgress?.isClosed) {
                state.pendingSessionEnd = true;

                if (dom.modalRatingResults.classList.contains('hidden')) {
                    showRatingProgress(state.ratingProgress);
                }

                break;
            }

            dom.modalRatingEl.classList.add('hidden');
            dom.modalRatingResults.classList.add('hidden');
            handleSessionEnded();
            break;
        case 'session-cancelled':
            dom.modalRatingEl?.classList.add('hidden');
            dom.modalRatingResults?.classList.add('hidden');
            handleSessionEnded();
            break;
        case 'all-ratings-received':
            if (data.ratingProgress) {
                state.ratingProgress = data.ratingProgress;
                showRatingProgress(data.ratingProgress);
            }
            break;
        case 'host-changed':
            const wasHost = state.isHost;
            state.isHost = (state.userToken && data.newHostId === state.currentDiscordId);
            if (state.isHost && !wasHost) {
                startHostHeartbeat();
                showHostNotification();
            }
            if (!state.isHost && wasHost) {
                stopHostHeartbeat();
            }
            updateHostUI();
            break;
        case 'subtitle-added':
            fetchAvailableSubtitles().then(() => updateSettingsPanel());
            break;
        case 'subtitles-ready':
            fetchAvailableSubtitles().then(() => updateSettingsPanel());
            break;
        case 'episode-ending':
            dom.video.pause();
            state.isEpisodeTransition = true;
            showRatingModal();
            break;
        case 'next-episode':
            resetForNextEpisode(data.selectedEpisode, data.movieName);
            if (data.episodeHistory) state.episodeHistory = data.episodeHistory;
            if (data.selectedEpisode) {
                populateMovieModal(state.currentMovieInfo, data.selectedEpisode);
            }
            break;
        case 'episode-ratings-received':
            if (data.ratingProgress) {
                state.ratingProgress = data.ratingProgress;
                showRatingProgress(data.ratingProgress);
            }
            break;
    }
}

export function connectWebSocket() {
    if (!state.userToken) {
        updateSyncStatus('error', 'Token de acesso ausente');
        return;
    }

    const wsUrl = `${state.wsProtocol}//${window.location.host}/ws?room=${state.roomId}&clientId=${state.clientId}`;
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
        updateSyncStatus('synced', 'Conectado');
        state.reconnectAttempts = 0;
        startHeartbeat();
        if (state.isHost) startHostHeartbeat();
    };

    state.ws.onclose = () => {
        updateSyncStatus('error', 'Reconectando...');
        stopHeartbeat();
        stopHostHeartbeat();
        const delay = Math.min(constants.BASE_RECONNECT_DELAY * Math.pow(2, state.reconnectAttempts), constants.MAX_RECONNECT_DELAY);
        state.reconnectAttempts += 1;
        setTimeout(connectWebSocket, delay);
    };

    state.ws.onerror = () => updateSyncStatus('error', 'Erro na conexão');
    state.ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

export function startDriftCorrection() {
    setInterval(() => {
        if (state.ws?.readyState === WebSocket.OPEN && state.hasVideo) {
            state.ws.send(JSON.stringify({ type: 'state' }));
        }
    }, constants.DRIFT_CHECK_INTERVAL);
}
