import ffmpeg from "fluent-ffmpeg";
import { existsSync } from "fs";
import { mkdir, rename, unlink } from "fs/promises";
import { spawn } from "child_process";
import { join, basename, extname, dirname } from "path";
import { logger } from "../../shared/logger";
import type { RoomManager } from "../../core/room-manager";
import type { AudioTrackInfo } from "../../shared/types";

interface ProcessMediaOptions {
    selectedAudioStreamIndex?: number;
}

interface ProcessResult {
    stdout: string;
    stderr: string;
}

const FFPROBE_TIMEOUT_MS = 30 * 1000;
const FFMPEG_SUBTITLE_TIMEOUT_MS = 10 * 60 * 1000;
const FFMPEG_AUDIO_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export class AudioTrackConversionError extends Error {
    constructor(message: string, public readonly details: string) {
        super(message);
        this.name = 'AudioTrackConversionError';
    }
}

export class MediaProcessor {
    private static BITMAP_CODECS = new Set([
        'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'
    ]);
    private static COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp3']);
    private static FFPROBE_CACHE_TTL_MS = 5 * 60 * 1000;
    private static ffprobeCache = new Map<string, { data: ffmpeg.FfprobeData; expiresAt: number }>();

    constructor(private roomManager: typeof RoomManager.prototype) { }

    async processMedia(roomId: string, filePath: string, options: ProcessMediaOptions = {}): Promise<string> {
        const processedPath = await this.convertAudioIfNeeded(roomId, filePath, options.selectedAudioStreamIndex, true);

        this.extractSubtitlesInBackground(roomId, filePath, processedPath).catch((error) => {
            logger.error("MediaProcessor", "Erro na extração assíncrona de legendas", error);
        });

        return processedPath;
    }

    async listAudioTracks(filePath: string): Promise<AudioTrackInfo[]> {
        try {
            const metadata = await this.ffprobe(filePath);
            return metadata.streams
                .filter((stream) => stream.codec_type === 'audio' && typeof stream.index === 'number')
                .map((stream) => {
                    const codec = (stream.codec_name || 'unknown').toLowerCase();
                    return {
                        streamIndex: stream.index as number,
                        codec,
                        language: (stream.tags?.language || 'und').toLowerCase(),
                        title: (stream.tags?.title || '').trim(),
                        channels: typeof stream.channels === 'number' ? stream.channels : 0,
                        isDefault: stream.disposition?.default === 1,
                        isCompatible: MediaProcessor.COMPATIBLE_AUDIO_CODECS.has(codec),
                    };
                })
                .sort((a, b) => a.streamIndex - b.streamIndex);
        } catch (error) {
            logger.error("MediaProcessor", "Erro ao listar faixas de áudio", error);
            return [];
        }
    }

    private sanitizeFilename(name: string): string {
        // Remove acentos e diacríticos.
        const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        // Troca caracteres fora da lista segura por underscores.
        return normalized.replace(/[^a-zA-Z0-9._-]/g, "_");
    }

    private getCachedFfprobe(filePath: string): ffmpeg.FfprobeData | null {
        const cached = MediaProcessor.ffprobeCache.get(filePath);
        if (!cached) {
            return null;
        }

        if (cached.expiresAt <= Date.now()) {
            MediaProcessor.ffprobeCache.delete(filePath);
            return null;
        }

        return cached.data;
    }

    private setCachedFfprobe(filePath: string, data: ffmpeg.FfprobeData): void {
        MediaProcessor.ffprobeCache.set(filePath, {
            data,
            expiresAt: Date.now() + MediaProcessor.FFPROBE_CACHE_TTL_MS,
        });
    }

    private clearCachedFfprobe(filePath: string): void {
        MediaProcessor.ffprobeCache.delete(filePath);
    }

    private async extractSubtitles(roomId: string, filePath: string, reportProgress = true): Promise<number> {
        if (reportProgress) {
            this.notifyProgress(roomId, "Analisando legendas...");
        }

        try {
            const metadata = await this.ffprobe(filePath);
            const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');

            const textStreams = subtitleStreams.filter(s => {
                const codec = s.codec_name?.toLowerCase() || '';
                if (MediaProcessor.BITMAP_CODECS.has(codec)) {
                    logger.info("MediaProcessor", `Legenda bitmap ignorada (${codec}, stream ${s.index})`);
                    return false;
                }
                return true;
            });

            if (textStreams.length === 0) {
                const hadBitmap = subtitleStreams.length > 0;
                const message = hadBitmap
                    ? `Legendas encontradas são bitmap (imagem) e não podem ser extraídas como texto`
                    : `Nenhuma legenda encontrada em ${basename(filePath)}`;
                logger.info("MediaProcessor", message);
                if (hadBitmap && reportProgress) this.notifyProgress(roomId, "Legendas bitmap ignoradas (não extraíveis)");
                return 0;
            }

            const subtitlesDir = join(dirname(filePath), `${roomId}_subtitles`);
            if (!existsSync(subtitlesDir)) {
                await mkdir(subtitlesDir, { recursive: true });
            }

            const subtitleOutputs = textStreams
                .filter((stream) => stream.index !== undefined)
                .map((stream) => {
                    const lang = stream.tags?.language || 'und';
                    const rawTitle = stream.tags?.title || '';
                    const title = rawTitle ? rawTitle.replace(/\s+/g, '_') : '';
                    const isForced = stream.disposition?.forced === 1 || title.toLowerCase().includes('forced');
                    const outputFilename = `${roomId}_sub_${stream.index}_${this.sanitizeFilename(lang)}.srt`;

                    return {
                        streamIndex: stream.index as number,
                        lang,
                        title,
                        isForced,
                        outputFilename,
                        outputPath: join(subtitlesDir, outputFilename),
                    };
                });

            if (subtitleOutputs.length === 0) {
                return 0;
            }

            if (reportProgress) {
                this.notifyProgress(roomId, `Extraindo ${subtitleOutputs.length} legenda(s)...`);
            }

            const args = [
                '-nostdin',
                '-i', filePath,
                '-y',
                '-hide_banner',
                '-loglevel', 'error',
            ];

            for (const subtitleOutput of subtitleOutputs) {
                args.push(
                    '-map', `0:${subtitleOutput.streamIndex}`,
                    '-c:s', 'srt',
                    subtitleOutput.outputPath,
                );
            }

            logger.debug("MediaProcessor", `Spawn FFmpeg: ffmpeg ${args.join(' ')}`);

            try {
                await this.runProcess('ffmpeg', args, FFMPEG_SUBTITLE_TIMEOUT_MS);

                let extractedCount = 0;
                for (const subtitleOutput of subtitleOutputs) {
                    if (!existsSync(subtitleOutput.outputPath)) {
                        logger.warn("MediaProcessor", `Legenda ${subtitleOutput.streamIndex} não foi gerada`);
                        continue;
                    }

                    const displayName = `${subtitleOutput.lang.toUpperCase()} ${subtitleOutput.title ? `(${subtitleOutput.title})` : ''} ${subtitleOutput.isForced ? '[Forced]' : ''}`.trim();
                    this.roomManager.addSubtitle(roomId, subtitleOutput.outputFilename, displayName);
                    extractedCount += 1;
                }

                return extractedCount;
            } catch (error) {
                for (const subtitleOutput of subtitleOutputs) {
                    if (existsSync(subtitleOutput.outputPath)) {
                        await unlink(subtitleOutput.outputPath).catch(() => { });
                    }
                }

                logger.error("MediaProcessor", "Erro extraindo legendas", error);
                return 0;
            }

        } catch (error) {
            logger.error("MediaProcessor", "Erro geral na extração de legendas", error);
            return 0;
        }
    }

    private async extractSubtitlesInBackground(roomId: string, sourcePath: string, processedPath: string): Promise<void> {
        const extractedCount = await this.extractSubtitles(roomId, sourcePath, false);

        if (sourcePath !== processedPath && existsSync(sourcePath)) {
            this.clearCachedFfprobe(sourcePath);
            await unlink(sourcePath).catch((error) => {
                logger.error("MediaProcessor", `Falha ao remover mídia original após extrair legendas: ${sourcePath}`, error);
            });
        }

        if (extractedCount > 0) {
            this.roomManager.broadcastAll(roomId, {
                type: "subtitles-ready",
            });
        }
    }

    private async convertAudioIfNeeded(
        roomId: string,
        filePath: string,
        selectedAudioStreamIndex?: number,
        keepSourceFile = false,
    ): Promise<string> {
        this.notifyProgress(roomId, "Verificando codecs de áudio...");

        const metadata = await this.ffprobe(filePath);
        const audioStreams = metadata.streams.filter(
            (stream) => stream.codec_type === 'audio' && typeof stream.index === 'number'
        );

        if (audioStreams.length === 0) {
            return filePath;
        }

        const selectedStream = typeof selectedAudioStreamIndex === 'number'
            ? audioStreams.find((stream) => stream.index === selectedAudioStreamIndex)
            : undefined;
        const targetStream = selectedStream || audioStreams[0];
        const targetCodec = targetStream.codec_name?.toLowerCase() || 'unknown';
        const needsConversion = !MediaProcessor.COMPATIBLE_AUDIO_CODECS.has(targetCodec);
        const needsTrackSelection = typeof selectedAudioStreamIndex === 'number' && audioStreams.length > 1;

        if (!needsConversion && !needsTrackSelection) {
            logger.info("MediaProcessor", "Áudio compatível. Nenhuma conversão necessária.");
            return filePath;
        }

        const selectedTrackLabel = `stream ${targetStream.index}`;
        logger.info("MediaProcessor", `Usando ${selectedTrackLabel} (${targetCodec})`);

        if (needsConversion) {
            this.notifyProgress(roomId, "Convertendo faixa de áudio selecionada para AAC (Isso pode demorar)...");
        } else {
            this.notifyProgress(roomId, "Aplicando faixa de áudio selecionada...");
        }

        const dir = dirname(filePath);
        const ext = extname(filePath);
        const name = basename(filePath, ext);
        const tempPath = join(dir, `${name}_converted.mp4`);

        try {
            await new Promise<void>((resolve, reject) => {
                let timeout: NodeJS.Timeout;
                let isSettled = false;
                const settle = (callback: () => void) => {
                    if (isSettled) return;
                    isSettled = true;
                    clearTimeout(timeout);
                    callback();
                };

                const command = ffmpeg(filePath)
                    .output(tempPath)
                    .outputOptions('-map 0:v:0')
                    .outputOptions(`-map 0:${targetStream.index}`)
                    .videoCodec('copy')
                    .outputOptions('-movflags +faststart')
                    .outputOptions('-y')
                    .on('start', (cmd) => {
                        logger.debug("MediaProcessor", `Comando FFmpeg Áudio: ${cmd}`);
                    })
                    .on('progress', (progress) => {
                        if (needsConversion && progress.percent) {
                            this.notifyProgress(roomId, `Convertendo áudio: ${Math.round(progress.percent)}%`);
                        }
                    })
                    .on('end', () => settle(resolve))
                    .on('error', (err, _stdout, stderr) => {
                        const stderrText = String(stderr || '').trim();
                        const details = stderrText || (err?.message || 'Falha sem detalhes do FFmpeg');
                        settle(() => reject(new AudioTrackConversionError(
                            `Falha ao converter a faixa de áudio ${targetStream.index} (${targetCodec})`,
                            details
                        )));
                    });

                timeout = setTimeout(() => {
                    settle(() => {
                        try {
                            command.kill('SIGKILL');
                        } catch (error) {
                            logger.warn("MediaProcessor", "Falha ao encerrar FFmpeg após timeout", error);
                        }

                        reject(new AudioTrackConversionError(
                            `Tempo limite excedido ao converter a faixa de áudio ${targetStream.index} (${targetCodec})`,
                            `FFmpeg excedeu ${Math.round(FFMPEG_AUDIO_TIMEOUT_MS / 1000)} segundos`
                        ));
                    });
                }, FFMPEG_AUDIO_TIMEOUT_MS);

                if (needsConversion) {
                    command.audioCodec('aac').outputOptions('-aac_coder fast').audioChannels(2).audioBitrate('192k');
                } else {
                    command.audioCodec('copy');
                }

                command.run();
            });

            if (!keepSourceFile && existsSync(filePath)) {
                this.clearCachedFfprobe(filePath);
                await unlink(filePath);
            }

            const finalPath = join(dir, `${name}.mp4`);
            if (existsSync(finalPath)) {
                this.clearCachedFfprobe(finalPath);
                await unlink(finalPath);
            }
            await rename(tempPath, finalPath);
            this.clearCachedFfprobe(tempPath);

            return finalPath;
        } catch (error) {

            if (existsSync(tempPath)) {
                this.clearCachedFfprobe(tempPath);
                await unlink(tempPath).catch(() => null);
            }

            if (error instanceof AudioTrackConversionError) {
                logger.error("MediaProcessor", `Erro na conversão de áudio (${selectedTrackLabel})`, error.details);
                throw error;
            }

            logger.error("MediaProcessor", `Erro inesperado na conversão de áudio (${selectedTrackLabel})`, error);
            throw error;
        }
    }

    private async ffprobe(filePath: string): Promise<ffmpeg.FfprobeData> {
        const cached = this.getCachedFfprobe(filePath);
        if (cached) {
            return cached;
        }

        try {
            const result = await this.runProcess('ffprobe', [
                '-v', 'error',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                filePath,
            ], FFPROBE_TIMEOUT_MS);
            const data = JSON.parse(result.stdout) as ffmpeg.FfprobeData;

            this.setCachedFfprobe(filePath, data);
            return data;
        } catch (error) {
            this.clearCachedFfprobe(filePath);
            throw error;
        }
    }

    private runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let isSettled = false;
            let timeout: NodeJS.Timeout;

            const settle = (callback: () => void) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timeout);
                callback();
            };

            timeout = setTimeout(() => {
                settle(() => {
                    child.kill('SIGKILL');
                    reject(new Error(`${command} excedeu ${Math.round(timeoutMs / 1000)} segundos`));
                });
            }, timeoutMs);

            child.stdout.on('data', (chunk) => {
                stdout = appendProcessOutput(stdout, chunk);
            });

            child.stderr.on('data', (chunk) => {
                stderr = appendProcessOutput(stderr, chunk);
            });

            child.on('close', (code) => {
                settle(() => {
                    if (code === 0) {
                        resolve({ stdout, stderr });
                        return;
                    }

                    reject(new Error(`${command} finalizou com código ${code}: ${stderr}`));
                });
            });

            child.on('error', (error) => {
                settle(() => reject(error));
            });
        });
    }

    private notifyProgress(roomId: string, message: string) {
        this.roomManager.updateState(roomId, {
            isProcessing: true,
            processingMessage: message
        });
        this.roomManager.broadcastAll(roomId, {
            type: "processing-progress",
            processingMessage: message
        });
    }
}

function appendProcessOutput(currentOutput: string, chunk: Buffer): string {
    const nextOutput = currentOutput + chunk.toString();
    if (nextOutput.length <= MAX_PROCESS_OUTPUT_BYTES) return nextOutput;
    return nextOutput.slice(nextOutput.length - MAX_PROCESS_OUTPUT_BYTES);
}
