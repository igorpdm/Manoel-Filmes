import ffmpeg from "fluent-ffmpeg";
import { existsSync } from "fs";
import { mkdir, readdir, rename, unlink, stat, copyFile } from "fs/promises";
import { spawn } from "child_process";
import { join, basename, extname, dirname, relative } from "path";
import { logger } from "../../shared/logger";
import type { RoomManager } from "../../core/room-manager";

export class MediaProcessor {
    private static BITMAP_CODECS = new Set([
        'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'
    ]);

    constructor(private roomManager: typeof RoomManager.prototype) {}

    async processMedia(roomId: string, filePath: string): Promise<string> {
        // 1. Extrair Legendas
        await this.extractSubtitles(roomId, filePath);

        // 2. Verificar e Converter Áudio se necessário
        const processedPath = await this.convertAudioIfNeeded(roomId, filePath);

        return processedPath;
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

    private async convertAudioIfNeeded(roomId: string, filePath: string): Promise<string> {
        this.notifyProgress(roomId, "Verificando codecs de áudio...");

        try {
            const metadata = await this.ffprobe(filePath);
            const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');

            if (audioStreams.length === 0) {
                return filePath; // Sem áudio, nada a fazer
            }

            const needsConversion = audioStreams.some(s => {
                const codec = s.codec_name?.toLowerCase();
                return codec !== 'aac' && codec !== 'mp3';
            });

            if (!needsConversion) {
                logger.info("MediaProcessor", "Áudio compatível. Nenhuma conversão necessária.");
                return filePath;
            }

            this.notifyProgress(roomId, "Convertendo áudio para AAC (Isso pode demorar)...");

            const dir = dirname(filePath);
            const ext = extname(filePath);
            const name = basename(filePath, ext);
            const tempPath = join(dir, `${name}_converted.mp4`); // Force MP4 container for web compatibility

            await new Promise<void>((resolve, reject) => {
                ffmpeg(filePath)
                    .output(tempPath)
                    .videoCodec('copy') // Copy video stream (fast)
                    .audioCodec('aac')  // Convert audio to AAC
                    .audioChannels(2)   // Force Stereo
                    .audioBitrate('192k')
                    .outputOptions('-movflags +faststart') // Optimize for web streaming
                    .outputOptions('-y') // Force overwrite
                    .on('start', (cmd) => {
                        logger.debug("MediaProcessor", `Comando FFmpeg Áudio: ${cmd}`);
                    })
                    .on('progress', (progress) => {
                        // Simple progress estimation if possible, or just keep "Processing..."
                        if (progress.percent) {
                            this.notifyProgress(roomId, `Convertendo áudio: ${Math.round(progress.percent)}%`);
                        }
                    })
                    .on('end', () => resolve())
                    .on('error', (err) => reject(err))
                    .run();
            });

            // Replace original file
            await unlink(filePath);
            
            // Rename converted file to original name (but maybe change extension if it was MKV)
            // Ideally we keep the new extension if we changed container to MP4
            const finalPath = join(dir, `${name}.mp4`);
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

