import { dom } from './dom.js';
import { buildRoomHeaders, state, constants, initAuth } from './state.js';
import {
    initSidebar,
    updateHostUI,
    showPlayer,
    showUploadProgress,
    showAudioTrackSelection,
    showProcessingProgress,
    updatePlayPauseUI,
    updateProgress,
    updateSyncStatus,
    updateVolumeUI,
    populateMovieModal,
    showRatingProgress,
    updateNextEpisodeButton
} from './ui.js';
import { connectWebSocket, startDriftCorrection, sendCommand, requestState, isFromRemote } from './ws.js';
import { bindUploadEvents } from './upload.js';
import { initSubtitles, renderSubtitle, fetchAvailableSubtitles } from './subtitles.js';
import { initUpscaler } from './upscaler.js';
import { closeWindowOrRedirect } from './utils.js';

function log(...args) {
    if (location.hostname === 'localhost') {
        console.log('[ManoelPlayer]', ...args);
    }
}

async function fetchRoomInfo() {
    try {
        const res = await fetch(`/api/room-info/${state.roomId}`, {
            headers: buildRoomHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            dom.roomTitleEl.textContent = data.title;

            if (data.movieInfo) {
                state.currentMovieInfo = data.movieInfo;
                state.currentSelectedEpisode = data.selectedEpisode;
                state.seasons = data.movieInfo.seasons || [];
                state.nextEpisode = data.nextEpisode || null;
                state.episodeHistory = data.episodeHistory || [];

                let displayTitle = data.movieInfo.title;
                if (data.selectedEpisode) {
                    displayTitle += ` - T${data.selectedEpisode.seasonNumber}E${data.selectedEpisode.episodeNumber}`;
                }
                dom.movieNameDisplayEl.textContent = displayTitle;

                if (data.movieInfo.posterUrl) {
                    dom.headerMoviePoster.src = data.movieInfo.posterUrl;
                    dom.headerMoviePoster.classList.remove('hidden');
                }

                if (data.movieInfo.voteAverage) {
                    dom.headerRatingValue.textContent = data.movieInfo.voteAverage.toFixed(1);
                    dom.headerMovieRating.classList.remove('hidden');
                }

                if (data.selectedEpisode) {
                    dom.headerEpisodeBadge.classList.remove('hidden');
                }

                populateMovieModal(data.movieInfo, data.selectedEpisode);
            } else {
                dom.movieNameDisplayEl.textContent = data.movieName;
            }

            updateNextEpisodeButton();
        }
    } catch (e) {
        log('Erro ao buscar info da sala:', e);
    }
}

async function checkRoomStatus() {
    try {
        const res = await fetch(`/api/room-status/${state.roomId}`, {
            headers: buildRoomHeaders()
        });
        const data = await res.json();

        if (data.hasVideo) {
            showPlayer();
            return;
        }

        if (data.isProcessing) {
            const message = data.processingMessage || 'Processando vídeo...';
            showProcessingProgress(message);
            return;
        }

        if (data.isAwaitingAudioSelection) {
            showAudioTrackSelection(data.audioTracks || [], data.audioSelectionErrorMessage || '');
            return;
        }

        if (data.isUploading) {
            showUploadProgress(data.uploadProgress || 0);
            return;
        }

        state.roomStage = 'idle';
        updateHostUI();
    } catch (e) {
        log('Erro ao verificar status:', e);
    }
}

function togglePlay() {
    if (!state.hasVideo) return;
    if (dom.video.paused) dom.video.play();
    else dom.video.pause();
}

function seekTo(e) {
    const rect = dom.progressWrapper.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    if (dom.video.duration) {
        const t = pos * dom.video.duration;
        dom.video.currentTime = t;
        sendCommand('seek', t);
    }
}

function hideControls() {
    if (!state.controlsVisible) return;
    dom.playerControls.classList.remove('visible');
    dom.playerContainer.style.cursor = 'none';
    state.controlsVisible = false;
}

function scheduleHideControls() {
    if (state.hideControlsTimer) clearTimeout(state.hideControlsTimer);
    state.hideControlsTimer = setTimeout(() => {
        if (Date.now() - state.lastMouseMove >= constants.IDLE_HIDE_DELAY && !state.isDragging) {
            hideControls();
        }
    }, constants.IDLE_HIDE_DELAY);
}

function showControls(e) {
    if (e && Math.abs(e.clientX - state.lastMouseX) < 5 && Math.abs(e.clientY - state.lastMouseY) < 5) {
        return;
    }
    if (e) {
        state.lastMouseX = e.clientX;
        state.lastMouseY = e.clientY;
    }
    dom.playerControls.classList.add('visible');
    dom.playerContainer.style.cursor = 'default';
    state.controlsVisible = true;
    state.lastMouseMove = Date.now();
    scheduleHideControls();
}

function bindPlayerEvents() {
    dom.video.addEventListener('play', () => {
        updatePlayPauseUI();
        dom.playerOverlay.classList.add('hidden');
        scheduleHideControls();
        if (state.isHost && !isFromRemote()) sendCommand('play', dom.video.currentTime);
    });
    dom.video.addEventListener('pause', () => {
        updatePlayPauseUI();
        showControls();
        if (state.isHost && !isFromRemote()) sendCommand('pause', dom.video.currentTime);
    });
    dom.video.addEventListener('seeked', () => {
        if (state.isHost && !isFromRemote()) sendCommand('seek', dom.video.currentTime);
    });
    dom.video.addEventListener('timeupdate', () => {
        updateProgress();
        renderSubtitle(dom.video.currentTime);
    });
    dom.video.addEventListener('click', togglePlay);

    dom.video.addEventListener('waiting', () => {
        updateSyncStatus('loading', 'Carregando...');
        dom.playerOverlay.classList.remove('hidden');
        dom.centerPlay.classList.add('hidden');
    });

    dom.video.addEventListener('playing', () => {
        dom.playerOverlay.classList.add('hidden');
        dom.centerPlay.classList.remove('hidden');
        updateSyncStatus('synced', 'Sincronizado');
    });

    dom.video.addEventListener('canplay', () => {
        if (dom.video.paused) {
            dom.centerPlay.classList.remove('hidden');
            updateSyncStatus('synced', 'Pronto');
        }
    });
}

function bindControls() {
    dom.btnPlay.addEventListener('click', togglePlay);
    dom.centerPlay.addEventListener('click', togglePlay);

    dom.btnBackward.addEventListener('click', () => {
        if (dom.video.duration) {
            const t = Math.max(0, dom.video.currentTime - 10);
            dom.video.currentTime = t;
            sendCommand('seek', t);
        }
    });

    dom.btnForward.addEventListener('click', () => {
        if (dom.video.duration) {
            const t = Math.min(dom.video.duration, dom.video.currentTime + 10);
            dom.video.currentTime = t;
            sendCommand('seek', t);
        }
    });

    dom.progressWrapper.addEventListener('click', seekTo);

    dom.btnFullscreen.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else dom.playerContainer.requestFullscreen();
    });

    dom.btnPip.addEventListener('click', () => {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else dom.video.requestPictureInPicture();
    });

    dom.volumeSlider.addEventListener('input', (e) => {
        dom.video.volume = e.target.value;
        updateVolumeUI();
    });

    dom.btnVolume.addEventListener('click', () => {
        dom.video.muted = !dom.video.muted;
        updateVolumeUI();
    });

    dom.playerContainer.addEventListener('mousemove', showControls);
    dom.playerContainer.addEventListener('mouseenter', showControls);
    dom.playerContainer.addEventListener('mousedown', showControls);
    dom.playerContainer.addEventListener('mouseleave', () => hideControls());
}

function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (!state.hasVideo) return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlay();
                showControls();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (dom.video.duration) {
                    const t = Math.max(0, dom.video.currentTime - 10);
                    dom.video.currentTime = t;
                    sendCommand('seek', t);
                    showControls();
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (dom.video.duration) {
                    const t = Math.min(dom.video.duration, dom.video.currentTime + 10);
                    dom.video.currentTime = t;
                    sendCommand('seek', t);
                    showControls();
                }
                break;
            case 'KeyF':
                if (document.fullscreenElement) document.exitFullscreen();
                else dom.playerContainer.requestFullscreen();
                break;
        }
    });
}

function bindMovieModal() {
    dom.movieInfoHeader.addEventListener('click', () => {
        if (state.currentMovieInfo) {
            dom.modalMovieDetails.classList.remove('hidden');
        }
    });

    dom.btnCloseMovieModal.addEventListener('click', () => {
        dom.modalMovieDetails.classList.add('hidden');
    });

    dom.modalMovieDetails.addEventListener('click', (e) => {
        if (e.target === dom.modalMovieDetails) {
            dom.modalMovieDetails.classList.add('hidden');
        }
    });
}

function bindSessionModals() {
    dom.btnEndSession.addEventListener('click', () => {
        const message = dom.modalConfirmEnd.querySelector('p');
        if (message) {
            message.textContent = 'Isso irá desconectar todos os participantes e apagar a sala.';
        }
        dom.modalConfirmEnd.classList.remove('hidden');
    });

    dom.btnCancelEnd.addEventListener('click', () => {
        dom.modalConfirmEnd.classList.add('hidden');
    });

    dom.btnConfirmEnd.addEventListener('click', async () => {
        let failed = false;
        try {
            await fetch(`/api/discord-end-session/${state.roomId}`, {
                method: 'POST',
                headers: buildRoomHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ token: state.userToken })
            });
        } catch (e) {
            failed = true;
            const message = dom.modalConfirmEnd.querySelector('p');
            if (message) {
                message.textContent = 'Erro ao encerrar sessão.';
            }
            dom.modalConfirmEnd.classList.remove('hidden');
        }
        if (!failed) {
            dom.modalConfirmEnd.classList.add('hidden');
        }
    });

    dom.btnHome.addEventListener('click', () => {
        closeWindowOrRedirect('/');
    });

    dom.btnCancelSession.addEventListener('click', () => {
        dom.modalConfirmCancel.classList.remove('hidden');
    });

    dom.btnDismissCancel.addEventListener('click', () => {
        dom.modalConfirmCancel.classList.add('hidden');
    });

    dom.btnConfirmCancel.addEventListener('click', async () => {
        try {
            await fetch(`/api/discord-cancel-session/${state.roomId}`, {
                method: 'POST',
                headers: buildRoomHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ token: state.userToken }),
            });
        } catch {
            // falha silenciosa — o WS event vai disparar se o servidor processou
        }
        dom.modalConfirmCancel.classList.add('hidden');
    });
}

function showSessionCompletedScreen() {
    document.body.innerHTML = `
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;color:white;text-align:center;">
            <h1>Sessão Concluída</h1>
            <p>Você pode fechar esta aba agora.</p>
            <button id="btn-close-page" class="btn-primary" style="margin-top:20px;max-width:420px;">Fechar Aba</button>
        </div>
    `;

    document.getElementById('btn-close-page')?.addEventListener('click', () => {
        closeWindowOrRedirect('/');
    });
}

function bindBufferTracking() {
    dom.video.addEventListener('loadedmetadata', () => {
        const bitrateBps = 5000000;
        state.estimatedFileSize = (dom.video.duration * bitrateBps) / 8;
    });

    dom.video.addEventListener('progress', () => {
        if (dom.video.duration > 0 && dom.video.buffered.length > 0) {
            for (let i = 0; i < dom.video.buffered.length; i++) {
                if (dom.video.buffered.start(i) <= dom.video.currentTime && dom.video.buffered.end(i) > dom.video.currentTime) {
                    const end = dom.video.buffered.end(i);
                    const pct = (end / dom.video.duration) * 100;
                    dom.progressBuffered.style.width = `${pct}%`;
                    break;
                }
            }
        }
    });
}

function bindRatingModal() {
    state.selectedRating = 0.0;

    if (dom.starRatingContainer) {
        dom.starRatingContainer.addEventListener('mousemove', (e) => {
            if (dom.btnSubmitRating?.disabled && dom.btnSubmitRating.textContent !== 'Enviar Avaliação') return;

            const rect = dom.starRatingContainer.getBoundingClientRect();
            let x = e.clientX - rect.left;
            const width = rect.width;
            let percent = x / width;
            if (percent < 0) percent = 0;
            if (percent > 1) percent = 1;

            let rawRating = percent * 10;
            let snappedRating = Math.ceil(rawRating);
            if (snappedRating < 1) snappedRating = 1;

            dom.starsFg.style.width = `${(snappedRating / 10) * 100}%`;
            dom.ratingValueDisplay.textContent = snappedRating.toFixed(0);
        });

        dom.starRatingContainer.addEventListener('mouseleave', () => {
            dom.starsFg.style.width = `${(state.selectedRating / 10) * 100}%`;
            dom.ratingValueDisplay.textContent = state.selectedRating > 0 ? state.selectedRating.toFixed(0) : '0';
        });

        dom.starRatingContainer.addEventListener('click', (e) => {
            const rect = dom.starRatingContainer.getBoundingClientRect();
            let x = e.clientX - rect.left;
            const width = rect.width;
            let percent = x / width;
            let rawRating = percent * 10;
            state.selectedRating = Math.ceil(rawRating);
            if (state.selectedRating < 1) state.selectedRating = 1;

            dom.starsFg.style.width = `${(state.selectedRating / 10) * 100}%`;
            dom.ratingValueDisplay.textContent = state.selectedRating.toFixed(0);
            dom.btnSubmitRating.disabled = false;
        });
    }

    dom.btnSubmitRating?.addEventListener('click', async () => {
        if (!state.selectedRating || !state.userToken) return;

        dom.btnSubmitRating.disabled = true;
        dom.ratingStatus.textContent = 'Enviando...';
        dom.ratingStatus.classList.remove('hidden');

        try {
            const res = await fetch(`/api/session-rating/${state.roomId}`, {
                method: 'POST',
                headers: buildRoomHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ token: state.userToken, rating: state.selectedRating })
            });

            if (res.ok) {
                const data = await res.json();
                if (data.ratingProgress) {
                    showRatingProgress(data.ratingProgress);
                } else {
                    dom.ratingStatus.textContent = 'Aguardando outros participantes...';
                }
            } else {
                dom.ratingStatus.textContent = 'Erro ao enviar avaliação';
                dom.btnSubmitRating.disabled = false;
            }
        } catch (e) {
            dom.ratingStatus.textContent = 'Erro de conexão';
            dom.btnSubmitRating.disabled = false;
        }
    });

    dom.btnCloseResults?.addEventListener('click', async () => {
        if (!state.ratingProgress?.isClosed) {
            return;
        }

        dom.modalRatingResults.classList.add('hidden');
        if (state.ratingCountdownTimer) {
            clearInterval(state.ratingCountdownTimer);
            state.ratingCountdownTimer = null;
        }
        state.ratingProgress = null;

        if (state.isEpisodeTransition) {
            state.isEpisodeTransition = false;

            if (state.isHost) {
                try {
                    await fetch(`/api/next-episode-finalize/${state.roomId}`, {
                        method: 'POST',
                        headers: buildRoomHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ token: state.userToken })
                    });
                } catch (e) {
                    log('Erro ao finalizar troca de episódio:', e);
                }
            }
            return;
        }

        state.pendingSessionEnd = false;

        closeWindowOrRedirect('/');
    });
}

function populateNextEpSelectors(seasons, selectedEpisode) {
    dom.nextEpSeasonSelect.innerHTML = '';
    for (const season of seasons) {
        const opt = document.createElement('option');
        opt.value = season.seasonNumber;
        opt.textContent = `Temporada ${season.seasonNumber}`;
        dom.nextEpSeasonSelect.appendChild(opt);
    }

    if (selectedEpisode) {
        dom.nextEpSeasonSelect.value = String(selectedEpisode.seasonNumber);
    }

    updateEpEpisodeSelect(seasons, selectedEpisode);
}

function updateEpEpisodeSelect(seasons, selectedEpisode) {
    const seasonNum = Number(dom.nextEpSeasonSelect.value);
    const season = seasons.find(s => s.seasonNumber === seasonNum);
    dom.nextEpEpisodeSelect.innerHTML = '';

    if (!season) return;

    for (const ep of season.episodes) {
        const opt = document.createElement('option');
        opt.value = ep.episodeNumber;
        opt.textContent = `E${ep.episodeNumber} - ${ep.name}`;
        dom.nextEpEpisodeSelect.appendChild(opt);
    }

    if (selectedEpisode && selectedEpisode.seasonNumber === seasonNum) {
        dom.nextEpEpisodeSelect.value = String(selectedEpisode.episodeNumber);
    }

    updateNextEpInfo(seasons);
}

function updateNextEpInfo(seasons) {
    const seasonNum = Number(dom.nextEpSeasonSelect.value);
    const epNum = Number(dom.nextEpEpisodeSelect.value);
    const season = seasons.find(s => s.seasonNumber === seasonNum);
    const ep = season?.episodes?.find(e => e.episodeNumber === epNum);

    if (ep?.overview) {
        dom.nextEpInfo.textContent = ep.overview;
        dom.nextEpInfo.classList.remove('hidden');
    } else {
        dom.nextEpInfo.classList.add('hidden');
    }
}

function buildSelectedEpisodeFromSelectors(seasons) {
    const seasonNum = Number(dom.nextEpSeasonSelect.value);
    const epNum = Number(dom.nextEpEpisodeSelect.value);
    const season = seasons.find(s => s.seasonNumber === seasonNum);
    const ep = season?.episodes?.find(e => e.episodeNumber === epNum);
    if (!ep) return null;
    return { ...ep, seasonNumber: seasonNum };
}

function bindNextEpisodeFlow() {
    dom.btnNextEpisode?.addEventListener('click', async () => {
        try {
            const res = await fetch(`/api/next-episode/${state.roomId}`, {
                method: 'POST',
                headers: buildRoomHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ token: state.userToken })
            });

            if (!res.ok) {
                log('Erro ao iniciar troca de episódio');
                return;
            }

            const data = await res.json();
            const seasons = data.seasons || state.seasons;
            const nextEp = data.nextEpisode;

            populateNextEpSelectors(seasons, nextEp);

            dom.nextEpSeasonSelect.onchange = () => {
                updateEpEpisodeSelect(seasons, null);
            };
            dom.nextEpEpisodeSelect.onchange = () => {
                updateNextEpInfo(seasons);
            };

            dom.modalNextEpisode.classList.remove('hidden');
        } catch (e) {
            log('Erro ao preparar troca de episódio:', e);
        }
    });

    dom.btnCancelNextEp?.addEventListener('click', () => {
        dom.modalNextEpisode.classList.add('hidden');
    });

    dom.btnProceedNextEp?.addEventListener('click', async () => {
        const seasons = state.seasons;
        const selectedEpisode = buildSelectedEpisodeFromSelectors(seasons);

        if (!selectedEpisode) {
            log('Nenhum episódio selecionado');
            return;
        }

        dom.modalNextEpisode.classList.add('hidden');
        dom.btnProceedNextEp.disabled = true;

        try {
            const res = await fetch(`/api/next-episode-proceed/${state.roomId}`, {
                method: 'POST',
                headers: buildRoomHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    token: state.userToken,
                    selectedEpisode
                })
            });

            if (!res.ok) {
                log('Erro ao prosseguir para próximo episódio');
            }
        } catch (e) {
            log('Erro na troca de episódio:', e);
        } finally {
            dom.btnProceedNextEp.disabled = false;
        }
    });
}

async function init() {
    const authenticated = await initAuth();
    if (!authenticated) return;

    initSidebar();
    initSubtitles();
    await initUpscaler();
    bindUploadEvents();
    bindPlayerEvents();
    bindControls();
    bindKeyboardShortcuts();
    bindMovieModal();
    bindSessionModals();
    bindBufferTracking();
    bindRatingModal();

    connectWebSocket();
    fetchRoomInfo();
    checkRoomStatus();
    startDriftCorrection();
    requestState();
    updateHostUI();
    fetchAvailableSubtitles();
    bindNextEpisodeFlow();
}

init();
