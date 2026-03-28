const roomId = window.location.pathname.split('/')[2];
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const userToken = new URLSearchParams(window.location.search).get('token') || '';

function createClientId() {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID();
    }

    return `client-${Math.random().toString(36).slice(2, 10)}`;
}

const clientId = createClientId();

export function buildRoomHeaders(extraHeaders = {}) {
    if (!userToken) {
        return { ...extraHeaders };
    }

    return {
        ...extraHeaders,
        'x-room-token': userToken
    };
}

export function buildRoomUrl(path) {
    if (!userToken) {
        return path;
    }

    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}token=${encodeURIComponent(userToken)}`;
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
    userToken,
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
    estimatedFileSize: 0,
    lastBufferEnd: 0,
    lastBufferTime: Date.now(),
    availableSubtitles: [],
    pendingSubtitleFiles: [],
    seasons: [],
    nextEpisode: null,
    episodeHistory: [],
    isEpisodeTransition: false,
};
