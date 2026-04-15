import { closeWindowOrRedirect } from './utils.js';

const roomId = window.location.pathname.split('/')[2];
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

function createClientId() {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID();
    }

    return `client-${Math.random().toString(36).slice(2, 10)}`;
}

const clientId = createClientId();

export function buildRoomHeaders(extraHeaders = {}) {
    if (!state.userToken) {
        return { ...extraHeaders };
    }

    return {
        ...extraHeaders,
        'x-room-token': state.userToken
    };
}

export const constants = {
    REMOTE_COOLDOWN: 500,
    EWMA_ALPHA: 0.2,
    BASE_SYNC_THRESHOLD: 0.3,
    DRIFT_CHECK_INTERVAL: 10000,
    MAX_RECONNECT_DELAY: 16000,
    BASE_RECONNECT_DELAY: 1000,
    IDLE_HIDE_DELAY: 3000,
    CHUNK_SIZE: 2 * 1024 * 1024,
    UPLOAD_CONCURRENCY: 6,
    UPLOAD_TIMEOUT: 30000,
    PROGRESS_THROTTLE: 100
};

export const state = {
    roomId,
    wsProtocol,
    clientId,
    userToken: null,
    oauthUser: null,
    authInitialized: false,
    ws: null,
    hideControlsTimer: null,
    isDragging: false,
    hasVideo: false,
    roomStage: 'idle',
    audioTracks: [],
    selectedAudioStreamIndex: null,
    audioSelectionErrorMessage: '',
    pendingSync: null,
    videoReady: false,
    pendingPlayData: null,
    isHost: false,
    commandSeq: 0,
    hostHeartbeatTimer: null,
    playRetryTimer: null,
    heartbeatTimer: null,
    lastRemoteTimestamp: 0,
    latency: 0,
    clockOffset: 0,
    latencySamples: 0,
    reconnectAttempts: 0,
    isSlowConnection: false,
    currentDiscordId: null,
    currentMovieInfo: null,
    currentSelectedEpisode: null,
    lastMouseMove: Date.now(),
    controlsVisible: true,
    lastMouseX: 0,
    lastMouseY: 0,
    selectedRating: 0,
    ratingProgress: null,
    ratingCountdownTimer: null,
    pendingSessionEnd: false,
    estimatedFileSize: 0,
    lastBufferEnd: 0,
    lastBufferTime: Date.now(),
    availableSubtitles: [],
    pendingSubtitleFiles: [],
    seasons: [],
    nextEpisode: null,
    episodeHistory: [],
    isEpisodeTransition: false,
    isUploadingLocally: false,
};

/**
 * Inicializa a autenticação via OAuth.
 * Verifica se o usuário está logado e autoriza na sala.
 * Retorna true se autenticado, false se redirecionou para login.
 */
export async function initAuth() {
    try {
        const meRes = await fetch('/api/oauth/me', { credentials: 'include' });
        
        if (meRes.status === 401) {
            const currentPath = window.location.pathname + window.location.search;
            window.location.href = `/login.html?redirect=${encodeURIComponent(currentPath)}`;
            return false;
        }

        if (!meRes.ok) {
            console.error('[Auth] Erro ao verificar sessão:', meRes.status);
            window.location.href = `/login.html?error=server_error&redirect=${encodeURIComponent(window.location.pathname)}`;
            return false;
        }

        state.oauthUser = await meRes.json();

        const authRes = await fetch(`/api/oauth/authorize-room/${state.roomId}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        if (authRes.status === 404) {
            console.error('[Auth] Sessão não encontrada');
            document.body.innerHTML = `
                <div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;color:white;text-align:center;padding:2rem;">
                    <h1>Sessão não encontrada</h1>
                    <p style="margin-top:1rem;color:#9ca3af;">Esta sessão não existe ou já foi encerrada.</p>
                    <button id="btn-close-missing-session" class="btn-primary" style="margin-top:2rem;max-width:420px;">Fechar</button>
                </div>
            `;

            document.getElementById('btn-close-missing-session')?.addEventListener('click', () => {
                closeWindowOrRedirect('/');
            });

            return false;
        }

        if (!authRes.ok) {
            console.error('[Auth] Erro ao autorizar na sala:', authRes.status);
            window.location.href = `/login.html?error=auth_failed&redirect=${encodeURIComponent(window.location.pathname)}`;
            return false;
        }

        const authData = await authRes.json();
        state.userToken = authData.token;
        state.isHost = authData.isHost;
        state.currentDiscordId = authData.user.discordId;
        state.authInitialized = true;

        console.log('[Auth] Autenticado como:', authData.user.username, '(host:', authData.isHost, ')');
        return true;
    } catch (error) {
        console.error('[Auth] Erro na autenticação:', error);
        window.location.href = `/login.html?error=network_error&redirect=${encodeURIComponent(window.location.pathname)}`;
        return false;
    }
}
