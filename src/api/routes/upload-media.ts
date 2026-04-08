import { existsSync } from "fs";
import { rm } from "fs/promises";
import { logger } from "../../shared/logger";
import { MediaProcessor, AudioTrackConversionError } from "../services/media-processor";
import type { UploadDeps } from "./upload-types";
import type { AudioTrackInfo } from "../../shared/types";

const INITIAL_PROCESSING_MESSAGE = "Iniciando pós-processamento...";
const AUDIO_CONVERSION_ERROR_MESSAGE = "Falha na conversão da faixa de áudio. Escolha outra faixa ou cancele o arquivo.";

export interface ProcessingResponse {
    ready: boolean;
    processing: boolean;
    requiresAudioSelection: boolean;
    audioTracks: AudioTrackInfo[];
    errorMessage: string;
}

export function getRoomProcessingResponse(
    roomId: string,
    deps: UploadDeps,
    fallbackAudioTracks: AudioTrackInfo[] = []
): ProcessingResponse {
    const room = deps.roomManager.getRoom(roomId);
    const audioTracks = room?.state.audioTracks.length
        ? room.state.audioTracks
        : fallbackAudioTracks;

    return {
        ready: Boolean(room?.state.videoPath),
        processing: Boolean(room?.state.isProcessing),
        requiresAudioSelection: Boolean(room?.state.isAwaitingAudioSelection),
        audioTracks,
        errorMessage: room?.state.audioSelectionErrorMessage || "",
    };
}

export async function processRoomMedia(
    roomId: string,
    filePath: string,
    deps: UploadDeps,
    selectedAudioStreamIndex?: number,
    availableAudioTracks: AudioTrackInfo[] = []
): Promise<void> {
    try {
        const processor = new MediaProcessor(deps.roomManager);
        const processedPath = await processor.processMedia(roomId, filePath, { selectedAudioStreamIndex });

        deps.roomManager.setVideoPath(roomId, processedPath);
        deps.roomManager.updateState(roomId, {
            isProcessing: false,
            processingMessage: "",
            pendingVideoPath: "",
            isAwaitingAudioSelection: false,
            audioTracks: [],
            selectedAudioStreamIndex: null,
            audioSelectionErrorMessage: "",
        });
        deps.roomManager.broadcastAll(roomId, { type: "video-ready" });
    } catch (err) {
        logger.error("UploadMedia", `Falha ao processar mídia da sala ${roomId}`, err);

        if (err instanceof AudioTrackConversionError) {
            const room = deps.roomManager.getRoom(roomId);
            const audioTracks = room?.state.audioTracks.length
                ? room.state.audioTracks
                : availableAudioTracks;

            deps.roomManager.updateState(roomId, {
                isProcessing: false,
                processingMessage: "",
                pendingVideoPath: filePath,
                isAwaitingAudioSelection: true,
                audioTracks,
                selectedAudioStreamIndex: null,
                audioSelectionErrorMessage: AUDIO_CONVERSION_ERROR_MESSAGE,
            });

            deps.roomManager.broadcastAll(roomId, {
                type: "audio-track-selection-required",
                audioTracks,
                errorMessage: AUDIO_CONVERSION_ERROR_MESSAGE,
            });
            return;
        }

        if (existsSync(filePath)) {
            try {
                await rm(filePath, { force: true });
            } catch (removeError) {
                logger.error("UploadMedia", `Falha ao remover arquivo após erro de processamento ${filePath}`, removeError);
            }
        }

        deps.roomManager.updateState(roomId, {
            isProcessing: false,
            processingMessage: "Erro no processamento",
            pendingVideoPath: "",
            isAwaitingAudioSelection: false,
            audioTracks: [],
            selectedAudioStreamIndex: null,
            audioSelectionErrorMessage: "",
        });
        deps.roomManager.broadcastAll(roomId, {
            type: "processing-progress",
            processingMessage: "Erro no processamento do vídeo",
        });
    }
}

export async function startRoomProcessing(
    roomId: string,
    filePath: string,
    deps: UploadDeps,
    selectedAudioStreamIndex?: number,
    availableAudioTracks: AudioTrackInfo[] = []
): Promise<ProcessingResponse> {
    deps.roomManager.updateState(roomId, {
        isUploading: false,
        uploadProgress: 100,
        isAwaitingAudioSelection: false,
        audioTracks: availableAudioTracks,
        selectedAudioStreamIndex: selectedAudioStreamIndex ?? null,
        pendingVideoPath: filePath,
        isProcessing: true,
        processingMessage: INITIAL_PROCESSING_MESSAGE,
        audioSelectionErrorMessage: "",
    });

    deps.roomManager.broadcastAll(roomId, {
        type: "processing-progress",
        processingMessage: INITIAL_PROCESSING_MESSAGE,
    });

    processRoomMedia(roomId, filePath, deps, selectedAudioStreamIndex, availableAudioTracks).catch((error) => {
        logger.error("UploadMedia", `Falha inesperada no fluxo de processamento da sala ${roomId}`, error);
    });

    await Promise.resolve();
    return getRoomProcessingResponse(roomId, deps, availableAudioTracks);
}
