import ffmpeg from "fluent-ffmpeg";
import { existsSync } from "fs";
import { mkdir, readdir, rename, unlink, stat, copyFile } from "fs/promises";
import { spawn } from "child_process";
import { join, basename, extname, dirname, relative } from "path";
import { logger } from "../../shared/logger";
import type { RoomManager } from "../../core/room-manager";
import type { AudioTrackInfo } from "../../shared/types";

interface ProcessMediaOptions {
    selectedAudioStreamIndex?: number;
}

export class MediaProcessor {
    private static BITMAP_CODECS = new Set([
        'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'
    ]);
    private static COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp3']);

    constructor(private roomManager: typeof RoomManager.prototype) {}

    async processMedia(roomId: string, filePath: string, options: ProcessMediaOptions = {}): Promise<string> {
        // 1. Extrair Legendas
        await this.extractSubtitles(roomId, filePath);

        // 2. Verificar e Converter Áudio se necessário
        const processedPath = await this.convertAudioIfNeeded(roomId, filePath, options.selectedAudioStreamIndex);

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
        // Remove accents/diacritics
        const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        // Replace non-alphanumeric (except dots, dashes, underscores) with underscores
        return normalized.replace(/[^a-zA-Z0-9._-]/g, "_");
    }

    private async extractSubtitles(roomId: string, filePath: string): Promise<void> {
        this.notifyProgress(roomId, "Analisando legendas...");
        
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
                if (hadBitmap) this.notifyProgress(roomId, "Legendas bitmap ignoradas (não extraíveis)");
                return;
            }

            // uploadsDir/roomId_subtitles/
            const subtitlesDir = join(dirname(filePath), `${roomId}_subtitles`);
            if (!existsSync(subtitlesDir)) {
                await mkdir(subtitlesDir, { recursive: true });
            }

            for (const stream of textStreams) {
                if (stream.index === undefined) continue;

                const lang = stream.tags?.language || 'und';
                const rawTitle = stream.tags?.title || '';
                const title = rawTitle ? rawTitle.replace(/\s+/g, '_') : '';
                const isForced = stream.disposition?.forced === 1 || title.toLowerCase().includes('forced');
                
                // Simplify filename to avoid FS issues: roomId_index_lang.srt
                const outputFilename = `${roomId}_sub_${stream.index}_${this.sanitizeFilename(lang)}.srt`;
                const outputPath = join(subtitlesDir, outputFilename);
                
                // Strategy: Extract to a simple temp file in CWD, then move.
                // This avoids FFmpeg struggling with complex/absolute output paths.
                const tempSrt = `temp_${Date.now()}_${stream.index}.srt`;

                this.notifyProgress(roomId, `Extraindo legenda (${lang})...`);
                
                try {
                    await new Promise<void>((resolve, reject) => {
                        const args = [
                            '-nostdin',
                            '-i', filePath,
                            '-map', `0:${stream.index}`,
                            '-c:s', 'srt',
                            '-y',
                            '-hide_banner',
                            '-loglevel', 'error',
                            tempSrt
                        ];
                        
                        logger.debug("MediaProcessor", `Spawn FFmpeg: ffmpeg ${args.join(' ')}`);

                        const proc = spawn('ffmpeg', args);

                        let stderr = '';
                        proc.stderr.on('data', (d) => stderr += d.toString());

                        proc.on('close', (code) => {
                            if (code === 0) resolve();
                            else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
                        });
                        
                        proc.on('error', (err) => reject(err));
                    });

                    // Copia em vez de rename para evitar EXDEV em filesystems distintos
                    if (existsSync(tempSrt)) {
                        await copyFile(tempSrt, outputPath);
                        await unlink(tempSrt).catch(() => {});
                        
                        // Add to room manager
                        const displayName = `${lang.toUpperCase()} ${title ? `(${title})` : ''} ${isForced ? '[Forced]' : ''}`.trim();
                        this.roomManager.addSubtitle(roomId, outputFilename, displayName);
                    }
                } catch (err) {
                    logger.error("MediaProcessor", `Erro extraindo legenda ${stream.index}`, err);
                    // Attempt cleanup
                    if (existsSync(tempSrt)) await unlink(tempSrt).catch(() => {});
                }
            }

        } catch (error) {
            logger.error("MediaProcessor", "Erro geral na extração de legendas", error);
        }
    }

    private async convertAudioIfNeeded(roomId: string, filePath: string, selectedAudioStreamIndex?: number): Promise<string> {
        this.notifyProgress(roomId, "Verificando codecs de áudio...");

        try {
            const metadata = await this.ffprobe(filePath);
            const audioStreams = metadata.streams.filter(
                (stream) => stream.codec_type === 'audio' && typeof stream.index === 'number'
            );

            if (audioStreams.length === 0) {
                return filePath; // Sem áudio, nada a fazer
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
            const tempPath = join(dir, `${name}_converted.mp4`); // Force MP4 container for web compatibility

            await new Promise<void>((resolve, reject) => {
                const command = ffmpeg(filePath)
                    .output(tempPath)
                    .outputOptions('-map 0:v:0')
                    .outputOptions(`-map 0:${targetStream.index}`)
                    .videoCodec('copy') // Copy video stream (fast)
                    .outputOptions('-movflags +faststart') // Optimize for web streaming
                    .outputOptions('-y') // Force overwrite
                    .on('start', (cmd) => {
                        logger.debug("MediaProcessor", `Comando FFmpeg Áudio: ${cmd}`);
                    })
                    .on('progress', (progress) => {
                        if (needsConversion && progress.percent) {
                            this.notifyProgress(roomId, `Convertendo áudio: ${Math.round(progress.percent)}%`);
                        }
                    })
                    .on('end', () => resolve())
                    .on('error', (err) => reject(err));

                if (needsConversion) {
                    command.audioCodec('aac').audioChannels(2).audioBitrate('192k');
                } else {
                    command.audioCodec('copy');
                }

                command.run();
            });

            // Replace original file
            if (existsSync(filePath)) {
                await unlink(filePath);
            }
            
            // Rename converted file to original name (but maybe change extension if it was MKV)
            // Ideally we keep the new extension if we changed container to MP4
            const finalPath = join(dir, `${name}.mp4`);
            if (existsSync(finalPath)) {
                await unlink(finalPath);
            }
            await rename(tempPath, finalPath);

            return finalPath;

        } catch (error) {
            logger.error("MediaProcessor", "Erro na conversão de áudio", error);
            // In case of error, return original file path and hope for the best (or throw)
            return filePath;
        }
    }

    private ffprobe(filePath: string): Promise<ffmpeg.FfprobeData> {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, data) => {
                if (err) reject(err);
                else resolve(data);
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
