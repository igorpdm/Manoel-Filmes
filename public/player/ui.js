import { dom } from './dom.js';
import { state } from './state.js';
import { formatTime } from './utils.js';

export function initSidebar() {
    dom.btnToggleUsers?.addEventListener('click', () => dom.usersSidebar?.classList.remove('hidden'));
    dom.btnCloseSidebar?.addEventListener('click', () => dom.usersSidebar?.classList.add('hidden'));
}

export function updateHostUI() {
    const isTransitioning = state.roomStage === 'uploading' || state.roomStage === 'processing';

    if (state.isHost) {
        dom.btnEndSession.classList.remove('hidden');

        if (state.hasVideo) return;

        dom.waitingOverlay.classList.add('hidden');

        if (state.roomStage === 'processing' || state.roomStage === 'uploading') {
            dom.uploadZone.classList.add('hidden');
            dom.uploadOverlayEl.classList.remove('hidden');
            return;
        }

        state.roomStage = 'idle';
        dom.uploadOverlayEl.classList.add('hidden');
        dom.uploadZone.classList.remove('hidden');
        return;
    } else {
        dom.btnEndSession.classList.add('hidden');
        if (state.hasVideo) return;

        dom.uploadZone.classList.add('hidden');
        dom.uploadOverlayEl.classList.add('hidden');
        dom.waitingOverlay.classList.remove('hidden');

        if (!isTransitioning) {
            state.roomStage = 'idle';
            const waitingTitle = dom.waitingOverlay.querySelector('h2');
            const waitingMessage = dom.waitingOverlay.querySelector('p');
            if (waitingTitle) waitingTitle.textContent = 'Aguardando o Host';
            if (waitingMessage) waitingMessage.textContent = 'O dono da sala está selecionando o filme...';
        }
    }
}

export function showPlayer() {
    state.roomStage = 'ready';
    dom.uploadZone.classList.add('hidden');
    dom.uploadOverlayEl.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
    state.hasVideo = true;

    if (!dom.video.src.includes(`/video/${state.roomId}`)) {
        dom.video.src = `/video/${state.roomId}?t=${Date.now()}`;
        dom.video.preload = 'auto';
        dom.video.load();
    }

    dom.playerOverlay.classList.remove('hidden');
}

export function showUploadProgress(progress = 0) {
    state.roomStage = 'uploading';

    if (!state.isHost) {
        dom.waitingOverlay.classList.remove('hidden');
        dom.uploadOverlayEl.classList.add('hidden');
        dom.uploadZone.classList.add('hidden');
        dom.playerOverlay.classList.add('hidden');

        const waitingTitle = dom.waitingOverlay.querySelector('h2');
        const waitingMessage = dom.waitingOverlay.querySelector('p');
        if (waitingTitle) waitingTitle.textContent = 'Aguardando Envío';
        if (waitingMessage) waitingMessage.textContent = `O host está enviando o filme: ${Math.max(0, Math.round(progress))}%`;
        return;
    }

    dom.uploadZone.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
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
        dom.playerOverlay.classList.add('hidden');

        const waitingTitle = dom.waitingOverlay.querySelector('h2');
        const waitingMessage = dom.waitingOverlay.querySelector('p');
        if (waitingTitle) waitingTitle.textContent = 'Processando';
        if (waitingMessage) waitingMessage.textContent = message;
        return;
    }

    dom.uploadZone.classList.add('hidden');
    dom.waitingOverlay.classList.add('hidden');
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

        const initials = u.username.substring(0, 2).toUpperCase();

        let pingClass = 'ping-good';
        if (u.ping > 150) pingClass = 'ping-fair';
        if (u.ping > 300) pingClass = 'ping-poor';
        if (!u.ping || u.ping < 0) pingClass = '';

        div.innerHTML = `
            <div class="user-avatar">${initials}</div>
            <div class="user-info">
                <span class="user-name">${u.username}</span>
            </div>
            <div class="ping-badge ${pingClass}">
                <span class="ping-dot"></span>
                ${u.ping > 0 ? u.ping + ' ms' : '--'}
            </div>
        `;
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
    if (state.currentMovieInfo) {
        dom.ratingPoster.src = state.currentMovieInfo.posterUrl || '/logo.jpg';
        dom.ratingMovieTitle.textContent = state.currentMovieInfo.title;

        if (state.currentSelectedEpisode) {
            dom.ratingEpisodeInfo.textContent = `S${state.currentSelectedEpisode.seasonNumber}E${state.currentSelectedEpisode.episodeNumber}`;
            dom.ratingEpisodeInfo.classList.remove('hidden');
        }
    }

    dom.modalRatingEl.classList.remove('hidden');
}

export function showRatingsResults(ratings, average) {
    dom.ratingsList.innerHTML = ratings.map(r => {
        const stars = Array(10).fill(0).map((_, i) =>
            i < r.rating
                ? '<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:#fca311"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
                : '<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:#e2e8f0"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
        ).join('');

        return `
            <div class="rating-item">
                <span class="rating-item-name">${r.username}</span>
                <div class="rating-item-stars" style="color: #fca311; display:flex;">${stars}</div>
            </div>
        `;
    }).join('');

    dom.ratingsAverage.innerHTML = `
        <div class="ratings-average-label">Média do Grupo</div>
        <div class="ratings-average-value">
            <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            ${average.toFixed(1)}/10
        </div>
    `;

    dom.modalRatingEl.classList.add('hidden');
    dom.modalRatingResults.classList.remove('hidden');
}

export function handleSessionEnded() {
    dom.video.pause();
    dom.video.src = '';
    state.hasVideo = false;
    state.roomStage = 'idle';
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
