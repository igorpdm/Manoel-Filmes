import { dom } from './dom.js';
import { state } from './state.js';
import { formatTime } from './utils.js';
import { clearSubtitleState } from './subtitles.js';

export function initSidebar() {
    dom.btnToggleUsers?.addEventListener('click', () => dom.usersSidebar?.classList.remove('hidden'));
    dom.btnCloseSidebar?.addEventListener('click', () => dom.usersSidebar?.classList.add('hidden'));
}

function setWaitingOverlayText(title, message) {
    const waitingTitle = dom.waitingOverlay.querySelector('h2');
    const waitingMessage = dom.waitingOverlay.querySelector('p');
    if (waitingTitle) waitingTitle.textContent = title;
    if (waitingMessage) waitingMessage.textContent = message;
}

function formatCountdown(remainingMs) {
    const safeRemainingMs = Math.max(0, remainingMs);
    const totalSeconds = Math.ceil(safeRemainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clearRatingCountdown() {
    if (!state.ratingCountdownTimer) {
        return;
    }

    clearInterval(state.ratingCountdownTimer);
    state.ratingCountdownTimer = null;
}

function updateRatingDeadline(ratingProgress) {
    if (!dom.ratingsDeadline) {
        return;
    }

    clearRatingCountdown();

    if (!ratingProgress || ratingProgress.isClosed) {
        dom.ratingsDeadline.classList.add('hidden');
        dom.ratingsDeadline.textContent = '';
        return;
    }

    const renderDeadline = () => {
        const remainingMs = ratingProgress.expiresAt - Date.now();
        dom.ratingsDeadline.textContent = `Tempo restante: ${formatCountdown(remainingMs)}`;

        if (remainingMs <= 0) {
            clearRatingCountdown();
        }
    };

    dom.ratingsDeadline.classList.remove('hidden');
    renderDeadline();
    state.ratingCountdownTimer = setInterval(renderDeadline, 1000);
}

function renderRatingParticipantStatus(participant) {
    if (participant.status === 'rated') {
        const score = document.createElement('span');
        score.className = 'rating-item-score';
        score.textContent = `${participant.rating}/10`;
        return score;
    }

    if (participant.status === 'timed_out') {
        const timeout = document.createElement('span');
        timeout.className = 'rating-item-timeout';
        timeout.textContent = 'Tempo esgotado';
        return timeout;
    }

    const loading = document.createElement('span');
    loading.className = 'rating-item-loading';

    const spinner = document.createElement('span');
    spinner.className = 'rating-item-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = 'Aguardando voto';

    loading.appendChild(spinner);
    loading.appendChild(label);
    return loading;
}

function formatAudioTrackLabel(track, index) {
    const language = track.language && track.language !== 'und'
        ? track.language.toUpperCase()
        : `Faixa ${index + 1}`;
    const codec = track.codec ? track.codec.toUpperCase() : 'DESCONHECIDO';
    const title = track.title ? ` - ${track.title}` : '';
    const channels = track.channels > 0 ? ` • ${track.channels}ch` : '';
    const defaultLabel = track.isDefault ? ' • padrão' : '';
    return `${language}${title} • ${codec}${channels}${defaultLabel}`;
}

function updateAudioTrackNote() {
    if (!dom.audioTrackSelect || !dom.audioTrackNote) return;

    const selectedStreamIndex = Number(dom.audioTrackSelect.value);
    const selectedTrack = state.audioTracks.find((track) => track.streamIndex === selectedStreamIndex);

    if (!selectedTrack) {
        dom.audioTrackNote.textContent = '';
        return;
    }

    if (selectedTrack.isCompatible) {
        dom.audioTrackNote.textContent = 'Essa faixa é compatível e será usada diretamente.';
    } else {
        dom.audioTrackNote.textContent = 'Essa faixa será convertida para AAC antes da reprodução.';
    }
}

export function showAudioTrackSelection(audioTracks = [], errorMessage) {
    if (Array.isArray(audioTracks) && audioTracks.length > 0) {
        state.audioTracks = audioTracks;
    }

    if (typeof errorMessage === 'string') {
        state.audioSelectionErrorMessage = errorMessage;
    }

    state.roomStage = 'audio-selection';
    state.hasVideo = false;

    if (!state.isHost) {
        dom.waitingOverlay.classList.remove('hidden');
        dom.uploadOverlayEl.classList.add('hidden');
        dom.uploadZone.classList.add('hidden');
        dom.audioTrackOverlay.classList.add('hidden');
        dom.playerOverlay.classList.add('hidden');
        setWaitingOverlayText('Aguardando seleção de áudio', 'O host está escolhendo a faixa de áudio...');
        return;
    }

    dom.uploadZone.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
    dom.uploadOverlayEl.classList.add('hidden');
    dom.playerOverlay.classList.add('hidden');
    dom.audioTrackOverlay.classList.remove('hidden');

    if (dom.audioTrackError) {
        const message = state.audioSelectionErrorMessage?.trim();
        if (message) {
            dom.audioTrackError.textContent = message;
            dom.audioTrackError.classList.remove('hidden');
        } else {
            dom.audioTrackError.textContent = '';
            dom.audioTrackError.classList.add('hidden');
        }
    }

    if (!dom.audioTrackSelect) return;

    dom.audioTrackSelect.innerHTML = '';
    state.audioTracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(track.streamIndex);
        option.textContent = formatAudioTrackLabel(track, index);
        dom.audioTrackSelect.appendChild(option);
    });

    const defaultTrack = state.audioTracks.find((track) => track.isDefault) || state.audioTracks[0];
    if (defaultTrack) {
        dom.audioTrackSelect.value = String(defaultTrack.streamIndex);
    }

    dom.audioTrackSelect.onchange = () => updateAudioTrackNote();
    updateAudioTrackNote();
}

export function updateHostUI() {
    const isTransitioning = state.roomStage === 'uploading'
        || state.roomStage === 'processing'
        || state.roomStage === 'audio-selection';

    if (state.isHost) {
        dom.btnCancelSession.classList.remove('hidden');
        dom.btnEndSession.classList.remove('hidden');
        updateNextEpisodeButton();

        if (state.hasVideo) return;

        dom.waitingOverlay.classList.add('hidden');
        dom.playerOverlay.classList.add('hidden');

        if (state.roomStage === 'audio-selection') {
            showAudioTrackSelection(state.audioTracks, state.audioSelectionErrorMessage);
            return;
        }

        if (state.roomStage === 'processing' || state.roomStage === 'uploading') {
            dom.uploadZone.classList.add('hidden');
            dom.uploadOverlayEl.classList.remove('hidden');
            dom.audioTrackOverlay.classList.add('hidden');
            return;
        }

        state.roomStage = 'idle';
        dom.uploadOverlayEl.classList.add('hidden');
        dom.audioTrackOverlay.classList.add('hidden');
        dom.uploadZone.classList.remove('hidden');
        return;
    } else {
        dom.btnCancelSession.classList.add('hidden');
        dom.btnEndSession.classList.add('hidden');
        dom.btnNextEpisode?.classList.add('hidden');
        if (state.hasVideo) return;

        dom.uploadZone.classList.add('hidden');
        dom.uploadOverlayEl.classList.add('hidden');
        dom.audioTrackOverlay.classList.add('hidden');
        dom.waitingOverlay.classList.remove('hidden');

        if (state.roomStage === 'audio-selection') {
            setWaitingOverlayText('Aguardando seleção de áudio', 'O host está escolhendo a faixa de áudio...');
            return;
        }

        if (!isTransitioning) {
            state.roomStage = 'idle';
            setWaitingOverlayText('Aguardando o Host', 'O dono da sala está selecionando o filme...');
        }
    }
}

export function showPlayer() {
    state.roomStage = 'ready';
    state.audioTracks = [];
    state.selectedAudioStreamIndex = null;
    dom.uploadZone.classList.add('hidden');
    dom.uploadOverlayEl.classList.add('hidden');
    dom.audioTrackOverlay.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
    state.hasVideo = true;

    if (!dom.video.src.includes(`/video/${state.roomId}`)) {
        dom.video.src = `/video/${state.roomId}?t=${Date.now()}`;
        dom.video.preload = 'auto';
        dom.video.load();
    }

    dom.playerOverlay.classList.remove('hidden');
    updateNextEpisodeButton();
}

export function showUploadProgress(progress = 0) {
    state.roomStage = 'uploading';

    if (!state.isHost) {
        dom.waitingOverlay.classList.remove('hidden');
        dom.uploadOverlayEl.classList.add('hidden');
        dom.uploadZone.classList.add('hidden');
        dom.audioTrackOverlay.classList.add('hidden');
        dom.playerOverlay.classList.add('hidden');

        setWaitingOverlayText('Aguardando envio', `O host está enviando o filme: ${Math.max(0, Math.round(progress))}%`);
        return;
    }

    dom.uploadZone.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
    dom.audioTrackOverlay.classList.add('hidden');
    dom.uploadOverlayEl.classList.remove('hidden');
    dom.playerOverlay.classList.add('hidden');
    updateUploadProgress(progress);
}

export function updateUploadProgress(progress) {
    const safeProgress = Number.isFinite(progress)
        ? Math.max(0, Math.min(100, Math.round(progress)))
        : 0;
    dom.uploadProgressFill.style.width = `${safeProgress}%`;
    dom.uploadProgressText.textContent = `${safeProgress}%`;
}

export function showProcessingProgress(message = 'Processando vídeo...') {
    state.roomStage = 'processing';

    if (!state.isHost) {
        dom.waitingOverlay.classList.remove('hidden');
        dom.uploadOverlayEl.classList.add('hidden');
        dom.uploadZone.classList.add('hidden');
        dom.audioTrackOverlay.classList.add('hidden');
        dom.playerOverlay.classList.add('hidden');

        setWaitingOverlayText('Processando', message);
        return;
    }

    dom.uploadZone.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
    dom.audioTrackOverlay.classList.add('hidden');
    dom.uploadOverlayEl.classList.remove('hidden');
    dom.playerOverlay.classList.add('hidden');
    updateUploadProgress(100);
    if (dom.uploadStatus) {
        dom.uploadStatus.textContent = message;
    }
}

export function updatePlayPauseUI() {
    const iconPlay = dom.btnPlay.querySelector('.icon-play');
    const iconPause = dom.btnPlay.querySelector('.icon-pause');
    if (dom.video.paused) {
        iconPlay.classList.remove('hidden');
        iconPause.classList.add('hidden');
    } else {
        iconPlay.classList.add('hidden');
        iconPause.classList.remove('hidden');
    }
}

export function updateProgress() {
    if (dom.video.duration) {
        const pct = (dom.video.currentTime / dom.video.duration) * 100;
        dom.progressFilled.style.width = pct + '%';
        dom.progressThumb.style.left = pct + '%';
        dom.timeCurrent.textContent = formatTime(dom.video.currentTime);
        dom.timeDuration.textContent = formatTime(dom.video.duration);
    }
}

export function updateSyncStatus(status, text) {
    dom.syncIndicator.querySelector('.sync-text').textContent = text;
    if (status === 'synced') dom.syncIndicator.style.opacity = '0';
    else dom.syncIndicator.style.opacity = '1';
}

export function showPlayOverlay() {
    dom.playerOverlay.classList.remove('hidden');
}

export function updateVolumeUI() {
    if (dom.video.muted || dom.video.volume === 0) {
        dom.btnVolume.querySelector('.icon-volume').classList.add('hidden');
        dom.btnVolume.querySelector('.icon-muted').classList.remove('hidden');
    } else {
        dom.btnVolume.querySelector('.icon-volume').classList.remove('hidden');
        dom.btnVolume.querySelector('.icon-muted').classList.add('hidden');
    }
}

export function renderUserList(users) {
    if (!dom.usersList) return;
    dom.usersList.innerHTML = '';

    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-item';

        const avatarWrapper = document.createElement('div');
        avatarWrapper.className = 'user-avatar';

        if (u.avatarUrl) {
            const avatarImage = document.createElement('img');
            avatarImage.className = 'user-avatar-img';
            avatarImage.src = u.avatarUrl;
            avatarImage.alt = u.username;
            avatarWrapper.appendChild(avatarImage);
        } else {
            const avatarInitials = document.createElement('div');
            avatarInitials.className = 'user-avatar-initials';
            avatarInitials.textContent = u.username.substring(0, 2).toUpperCase();
            avatarWrapper.appendChild(avatarInitials);
        }

        const userInfo = document.createElement('div');
        userInfo.className = 'user-info';

        const userName = document.createElement('span');
        userName.className = 'user-name';
        userName.textContent = u.username;
        userInfo.appendChild(userName);

        let pingClass = 'ping-good';
        if (u.ping > 150) pingClass = 'ping-fair';
        if (u.ping > 300) pingClass = 'ping-poor';
        if (!u.ping || u.ping < 0) pingClass = '';

        const pingBadge = document.createElement('div');
        pingBadge.className = `ping-badge ${pingClass}`.trim();

        const pingDot = document.createElement('span');
        pingDot.className = 'ping-dot';
        pingBadge.appendChild(pingDot);
        pingBadge.append(document.createTextNode(u.ping > 0 ? `${u.ping} ms` : '--'));

        div.appendChild(avatarWrapper);
        div.appendChild(userInfo);
        div.appendChild(pingBadge);
        dom.usersList.appendChild(div);
    });
}

export function populateMovieModal(movie, episode) {
    dom.modalPoster.src = movie.posterUrl || '/logo.jpg';
    dom.modalTitle.textContent = movie.title;
    dom.modalRatingValue.textContent = movie.voteAverage?.toFixed(1) || 'N/A';
    dom.modalYear.textContent = movie.releaseDate ? movie.releaseDate.substring(0, 4) : 'N/A';
    dom.modalGenres.textContent = movie.genres?.join(', ') || 'Não especificado';
    dom.modalOverview.textContent = movie.overview || 'Sinopse não disponível.';

    if (episode) {
        dom.modalEpisodeTitle.textContent = `Temporada ${episode.seasonNumber}, Episódio ${episode.episodeNumber}: ${episode.name}`;
        dom.modalEpisodeSection.classList.remove('hidden');
    } else {
        dom.modalEpisodeSection.classList.add('hidden');
    }
}

export function showRatingModal() {
    if (state.ratingProgress?.isClosed) {
        state.ratingProgress = null;
    }
    state.pendingSessionEnd = false;

    if (state.currentMovieInfo) {
        dom.ratingPoster.src = state.currentMovieInfo.posterUrl || '/logo.jpg';
        dom.ratingMovieTitle.textContent = state.currentMovieInfo.title;

        if (state.currentSelectedEpisode) {
            dom.ratingEpisodeInfo.textContent = `S${state.currentSelectedEpisode.seasonNumber}E${state.currentSelectedEpisode.episodeNumber}`;
            dom.ratingEpisodeInfo.classList.remove('hidden');
        } else {
            dom.ratingEpisodeInfo.classList.add('hidden');
        }
    } else {
        dom.ratingEpisodeInfo.classList.add('hidden');
    }

    clearRatingCountdown();
    state.selectedRating = 0;
    if (dom.starsFg) dom.starsFg.style.width = '0%';
    if (dom.ratingValueDisplay) dom.ratingValueDisplay.textContent = '0';
    if (dom.btnSubmitRating) dom.btnSubmitRating.disabled = true;
    if (dom.ratingStatus) {
        dom.ratingStatus.textContent = '';
        dom.ratingStatus.classList.add('hidden');
    }

    dom.modalRatingResults.classList.add('hidden');
    dom.modalRatingEl.classList.remove('hidden');
}

export function showRatingProgress(ratingProgress) {
    if (!ratingProgress) {
        return;
    }

    state.ratingProgress = ratingProgress;
    updateRatingDeadline(ratingProgress);

    if (dom.ratingsModalTitle) {
        dom.ratingsModalTitle.textContent = state.isEpisodeTransition
            ? '⭐ Avaliações do Episódio'
            : '⭐ Avaliações da Sessão';
    }

    if (dom.ratingsSummary) {
        if (ratingProgress.isClosed) {
            dom.ratingsSummary.textContent = ratingProgress.completionReason === 'timeout'
                ? 'Tempo de votação encerrado. Os votos pendentes foram desconsiderados.'
                : 'Todos os votos foram recebidos.';
        } else {
            dom.ratingsSummary.textContent = 'Notas atualizadas em tempo real. Aguarde os participantes restantes.';
        }
    }

    const participants = ratingProgress.participants || [];
    if (!participants.length) {
        dom.ratingsList.innerHTML = '';
        const emptyItem = document.createElement('div');
        emptyItem.className = 'rating-item rating-item-empty';
        emptyItem.textContent = 'Nenhum participante disponível.';
        dom.ratingsList.appendChild(emptyItem);
    } else {
        dom.ratingsList.innerHTML = '';

        participants.forEach((participant) => {
            const item = document.createElement('div');
            item.className = 'rating-item';

            const name = document.createElement('span');
            name.className = 'rating-item-name';
            name.textContent = participant.username;

            const status = document.createElement('div');
            status.className = 'rating-item-status';
            status.appendChild(renderRatingParticipantStatus(participant));

            item.appendChild(name);
            item.appendChild(status);
            dom.ratingsList.appendChild(item);
        });
    }

    const averageLabel = ratingProgress.isClosed ? 'Média final' : 'Média atual';
    const averageValue = Number.isFinite(ratingProgress.average) ? ratingProgress.average.toFixed(1) : '0.0';

    dom.ratingsAverage.innerHTML = `
        <div class="ratings-average-label">${averageLabel}</div>
        <div class="ratings-average-value">
            <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ${averageValue}/10
        </div>
    `;

    if (dom.btnCloseResults) {
        dom.btnCloseResults.classList.toggle('hidden', !ratingProgress.isClosed);
        dom.btnCloseResults.textContent = state.isEpisodeTransition ? 'Continuar' : 'Fechar';
    }

    dom.modalRatingEl.classList.add('hidden');
    dom.modalRatingResults.classList.remove('hidden');
}

export function handleSessionEnded() {
    clearRatingCountdown();
    dom.video.pause();
    dom.video.src = '';
    state.hasVideo = false;
    state.roomStage = 'idle';
    state.audioTracks = [];
    state.ratingProgress = null;
    state.pendingSessionEnd = false;
    dom.audioTrackOverlay.classList.add('hidden');
    dom.modalRatingEl.classList.add('hidden');
    dom.modalRatingResults.classList.add('hidden');
    dom.modalSessionEnded.classList.remove('hidden');
}

export function showHostNotification() {
    const notif = document.createElement('div');
    notif.className = 'host-notification';
    notif.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
        </svg>
        <span>Você agora é o host!</span>
    `;
    notif.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: linear-gradient(135deg, #fca311, #e89005);
        color: #000; padding: 12px 24px; border-radius: 8px;
        display: flex; align-items: center; gap: 10px;
        font-weight: 600; z-index: 9999; animation: slideDown 0.3s ease;
        box-shadow: 0 4px 20px rgba(252, 163, 17, 0.4);
    `;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 4000);
}

export function updateNextEpisodeButton() {
    if (!dom.btnNextEpisode) return;

    const isSeries = state.currentMovieInfo?.mediaType === 'tv';
    const shouldShow = state.isHost && isSeries && state.hasVideo;

    if (shouldShow) {
        dom.btnNextEpisode.classList.remove('hidden');
    } else {
        dom.btnNextEpisode.classList.add('hidden');
    }
}

export function resetForNextEpisode(selectedEpisode, movieName) {
    clearRatingCountdown();
    dom.video.pause();
    dom.video.removeAttribute('src');
    dom.video.load();
    state.hasVideo = false;
    state.roomStage = 'idle';
    state.audioTracks = [];
    state.selectedAudioStreamIndex = null;
    state.audioSelectionErrorMessage = '';
    state.selectedRating = 0;
    state.ratingProgress = null;
    state.pendingSessionEnd = false;
    state.isEpisodeTransition = false;

    if (selectedEpisode) {
        state.currentSelectedEpisode = selectedEpisode;
    }

    if (movieName) {
        dom.movieNameDisplayEl.textContent = movieName;
    }

    clearSubtitleState();

    dom.modalRatingEl.classList.add('hidden');
    dom.modalRatingResults.classList.add('hidden');
    dom.audioTrackOverlay.classList.add('hidden');
    dom.playerOverlay.classList.add('hidden');

    if (dom.starsFg) dom.starsFg.style.width = '0%';
    if (dom.ratingValueDisplay) dom.ratingValueDisplay.textContent = '0';
    if (dom.btnSubmitRating) dom.btnSubmitRating.disabled = true;
    if (dom.ratingStatus) {
        dom.ratingStatus.textContent = '';
        dom.ratingStatus.classList.add('hidden');
    }

    updateHostUI();
}
