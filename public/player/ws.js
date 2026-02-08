import { dom } from './dom.js';
import { state, constants } from './state.js';
import {
    updateSyncStatus,
    updateHostUI,
    showPlayer,
    showRatingModal,
    showRatingsResults,
    handleSessionEnded,
    renderUserList,
    updatePlayPauseUI,
    showHostNotification
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
        const res = await fetch(`/api/validate-token/${state.roomId}?token=${state.userToken}`);
        if (res.ok) {
            const data = await res.json();
            state.currentDiscordId = data.discordId;
        }
    } catch (e) {
        log('Erro ao obter discordId:', e);
    }
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
            if (!state.isHost) {
                dom.waitingOverlay.classList.remove('hidden');
                dom.uploadZone.classList.add('hidden');
                dom.waitingOverlay.querySelector('h2').textContent = 'Aguardando Envío';
                dom.waitingOverlay.querySelector('p').textContent = `O host iniciou o envio: ${data.filename}`;
            }
            break;
        case 'upload-progress':
            if (!state.isHost) {
                dom.waitingOverlay.classList.remove('hidden');
                dom.uploadZone.classList.add('hidden');
                dom.playerOverlay.classList.add('hidden');
                dom.waitingOverlay.querySelector('h2').textContent = 'Aguardando Envío';
                dom.waitingOverlay.querySelector('p').textContent = `O host está enviando o filme: ${data.progress}%`;
            }
            break;
        case 'processing-progress':
            const msg = data.processingMessage || 'Processando vídeo...';
            if (state.isHost) {
                 if (dom.uploadStatus) dom.uploadStatus.textContent = msg;
            } else {
                dom.waitingOverlay.classList.remove('hidden');
                dom.uploadZone.classList.add('hidden');
                dom.playerOverlay.classList.add('hidden');
                dom.waitingOverlay.querySelector('h2').textContent = 'Processando';
                dom.waitingOverlay.querySelector('p').textContent = msg;
            }
            break;
        case 'video-ready':
            showPlayer();
            break;
        case 'session-ending':
            dom.video.pause();
            showRatingModal();
            break;
        case 'session-ended':
            dom.modalRatingEl.classList.add('hidden');
            dom.modalRatingResults.classList.add('hidden');
            handleSessionEnded();
            break;
        case 'all-ratings-received':
            showRatingsResults(data.ratings, data.average);
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
    }
}

export function connectWebSocket() {
    const wsUrl = `${state.wsProtocol}//${window.location.host}/ws?room=${state.roomId}&clientId=${state.clientId}${state.userToken ? `&token=${state.userToken}` : ''}`;
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
