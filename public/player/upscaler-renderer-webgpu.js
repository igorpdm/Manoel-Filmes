import { wgslCopyShaderSource, wgslBlitShaderSource } from './upscaler-shaders/wgsl-copy.js';
import { wgslEasuShaderSource } from './upscaler-shaders/wgsl-easu.js';
import { wgslRcasShaderSource } from './upscaler-shaders/wgsl-rcas.js';

// Mesma lógica de viewport do WebGL renderer — preserva aspect ratio com letterboxing.
function buildContainViewport(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
        return { x: 0, y: 0, width: targetWidth, height: targetHeight };
    }

    const sourceRatio = sourceWidth / sourceHeight;
    const targetRatio = targetWidth / targetHeight;

    if (sourceRatio > targetRatio) {
        const width = targetWidth;
        const height = Math.round(targetWidth / sourceRatio);
        const y = Math.floor((targetHeight - height) / 2);
        return { x: 0, y, width, height };
    }

    const width = Math.round(targetHeight * sourceRatio);
    const x = Math.floor((targetWidth - width) / 2);
    return { x, y: 0, width, height: targetHeight };
}

export class UpscalerRendererWebGPU {
    // Formato interno das texturas intermediárias — garantidamente renderável e sampável.
    static INTERNAL_FORMAT = 'rgba8unorm';

    // Construtor privado — usar apenas via UpscalerRendererWebGPU.create()
    constructor(canvas, video, device, context, preferredFormat) {
        this.canvas = canvas;
        this.video = video;
        this.device = device;
        this.context = context;
        this.preferredFormat = preferredFormat;

        this.settings = { intensity: 0.5, isEnabled: true };

        // Texturas criadas por demanda (recriadas quando tamanho muda)
        this.copyTexture = null;
        this.copyTextureView = null;
        this.copyTextureSize = { width: 0, height: 0 };

        this.intermediateTexture = null;
        this.intermediateTextureView = null;
        this.intermediateTextureSize = { width: 0, height: 0 };

        // Cache de bind groups para passes 1 e 2 (invalidado quando textura muda)
        this._easuBindGroup = null;
        this._easuBindGroupTextureKey = null;
        this._rcasBindGroup = null;
        this._rcasBindGroupTextureKey = null;
        this._blitToIntermediateBindGroup = null;
        this._blitToIntermediateTextureKey = null;
        this._blitToCanvasBindGroup = null;
        this._blitToCanvasTextureKey = null;

        this._setupPipelines();
        this._setupUniformBuffers();
        this._setupSamplers();
    }

    // Factory assíncrona — ponto de entrada público.
    static async create(canvas, video) {
        if (!navigator.gpu) {
            throw new Error('WebGPU não disponível neste browser.');
        }

        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
            throw new Error('Nenhum GPUAdapter disponível.');
        }

        const device = await adapter.requestDevice();

        // Captura erros não tratados do device para debug.
        device.addEventListener('uncapturederror', (event) => {
            console.error('[Upscaler WebGPU] Uncaptured error:', event.error.message);
        });

        const context = canvas.getContext('webgpu');
        if (!context) {
            throw new Error('Falha ao obter contexto WebGPU do canvas.');
        }

        const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format: preferredFormat, alphaMode: 'opaque' });

        return new UpscalerRendererWebGPU(canvas, video, device, context, preferredFormat);
    }

    _setupPipelines() {
        const device = this.device;
        const internalFormat = UpscalerRendererWebGPU.INTERNAL_FORMAT;

        // --- copyPipeline: GPUExternalTexture → copyTexture ---
        this.copyBindGroupLayout = device.createBindGroupLayout({
            label: 'copy-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });

        const copyModule = device.createShaderModule({ label: 'copy-shader', code: wgslCopyShaderSource });

        this.copyPipeline = device.createRenderPipeline({
            label: 'copy-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.copyBindGroupLayout] }),
            vertex: { module: copyModule, entryPoint: 'vs_main' },
            fragment: { module: copyModule, entryPoint: 'fs_main', targets: [{ format: internalFormat }] },
            primitive: { topology: 'triangle-list' },
        });

        // --- blitPipeline: GPUTexture regular → GPUTexture regular (sem EASU, sem sharpening) ---
        this.blitBindGroupLayout = device.createBindGroupLayout({
            label: 'blit-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });

        const blitModule = device.createShaderModule({ label: 'blit-shader', code: wgslBlitShaderSource });

        // Versão que escreve para textura interna (intermediate ou canvas com internalFormat)
        this.blitToInternalPipeline = device.createRenderPipeline({
            label: 'blit-to-internal-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitBindGroupLayout] }),
            vertex: { module: blitModule, entryPoint: 'vs_main' },
            fragment: { module: blitModule, entryPoint: 'fs_main', targets: [{ format: internalFormat }] },
            primitive: { topology: 'triangle-list' },
        });

        // Versão que escreve para o canvas (preferredFormat, pode ser bgra8unorm)
        this.blitToCanvasPipeline = device.createRenderPipeline({
            label: 'blit-to-canvas-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitBindGroupLayout] }),
            vertex: { module: blitModule, entryPoint: 'vs_main' },
            fragment: { module: blitModule, entryPoint: 'fs_main', targets: [{ format: this.preferredFormat }] },
            primitive: { topology: 'triangle-list' },
        });

        // --- easuPipeline: copyTexture → intermediateTexture ---
        this.easuBindGroupLayout = device.createBindGroupLayout({
            label: 'easu-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const easuModule = device.createShaderModule({ label: 'easu-shader', code: wgslEasuShaderSource });

        this.easuPipeline = device.createRenderPipeline({
            label: 'easu-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.easuBindGroupLayout] }),
            vertex: { module: easuModule, entryPoint: 'vs_main' },
            fragment: { module: easuModule, entryPoint: 'fs_main', targets: [{ format: internalFormat }] },
            primitive: { topology: 'triangle-list' },
        });

        // --- rcasPipeline: intermediateTexture → canvas ---
        this.rcasBindGroupLayout = device.createBindGroupLayout({
            label: 'rcas-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const rcasModule = device.createShaderModule({ label: 'rcas-shader', code: wgslRcasShaderSource });

        this.rcasPipeline = device.createRenderPipeline({
            label: 'rcas-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.rcasBindGroupLayout] }),
            vertex: { module: rcasModule, entryPoint: 'vs_main' },
            fragment: { module: rcasModule, entryPoint: 'fs_main', targets: [{ format: this.preferredFormat }] },
            primitive: { topology: 'triangle-list' },
        });
    }

    _setupUniformBuffers() {
        const device = this.device;

        // EASU: struct { output_size: vec2f, source_size: vec2u } = 16 bytes
        this.easuUniformBuffer = device.createBuffer({
            label: 'easu-uniforms',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // RCAS: struct { intensity: f32, _pad: f32, source_size: vec2u } = 16 bytes
        // _pad alinha source_size em offset 8 (requisito de alinhamento WGSL para vec2u)
        this.rcasUniformBuffer = device.createBuffer({
            label: 'rcas-uniforms',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Valores iniciais dos uniforms RCAS
        this._writeRcasUniforms(this.settings.intensity, 1, 1);
    }

    _setupSamplers() {
        this.linearSampler = this.device.createSampler({
            label: 'linear-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
    }

    _ensureCopyTexture(width, height) {
        if (
            this.copyTexture &&
            this.copyTextureSize.width === width &&
            this.copyTextureSize.height === height
        ) {
            return;
        }

        this.copyTexture?.destroy();
        this._easuBindGroup = null;
        this._blitToIntermediateBindGroup = null;
        this._blitToCanvasBindGroup = null;

        this.copyTexture = this.device.createTexture({
            label: 'copy-texture',
            size: { width, height },
            format: UpscalerRendererWebGPU.INTERNAL_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.copyTextureView = this.copyTexture.createView({ label: 'copy-texture-view' });
        this.copyTextureSize = { width, height };
    }

    _ensureIntermediateTexture(width, height) {
        if (
            this.intermediateTexture &&
            this.intermediateTextureSize.width === width &&
            this.intermediateTextureSize.height === height
        ) {
            return;
        }

        this.intermediateTexture?.destroy();
        this._rcasBindGroup = null;
        this._blitToCanvasBindGroup = null;

        this.intermediateTexture = this.device.createTexture({
            label: 'intermediate-texture',
            size: { width, height },
            format: UpscalerRendererWebGPU.INTERNAL_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.intermediateTextureView = this.intermediateTexture.createView({ label: 'intermediate-texture-view' });
        this.intermediateTextureSize = { width, height };
    }

    // Pass 0: copia GPUExternalTexture → copyTexture.
    // CRÍTICO: GPUExternalTexture expira após o task atual — nunca usar await depois de importExternalTexture.
    // Este método tem seu próprio encoder e chama queue.submit imediatamente.
    _renderCopyPass() {
        const externalTexture = this.device.importExternalTexture({ source: this.video });

        // GPUBindGroup para este pass é sempre recriado por frame (GPUExternalTexture expira).
        const bindGroup = this.device.createBindGroup({
            label: 'copy-bg',
            layout: this.copyBindGroupLayout,
            entries: [
                { binding: 0, resource: externalTexture },
                { binding: 1, resource: this.linearSampler },
            ],
        });

        const encoder = this.device.createCommandEncoder({ label: 'copy-encoder' });
        const pass = encoder.beginRenderPass({
            label: 'copy-pass',
            colorAttachments: [{
                view: this.copyTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        pass.setPipeline(this.copyPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();

        // Submit imediato — garante que a external texture não expire antes de ser consumida.
        this.device.queue.submit([encoder.finish()]);
    }

    _writeEasuUniforms(outW, outH, srcW, srcH) {
        const data = new ArrayBuffer(16);
        const f32 = new Float32Array(data);
        const u32 = new Uint32Array(data);
        f32[0] = outW;
        f32[1] = outH;
        u32[2] = srcW;
        u32[3] = srcH;
        this.device.queue.writeBuffer(this.easuUniformBuffer, 0, data);
    }

    _writeRcasUniforms(intensity, srcW, srcH) {
        const data = new ArrayBuffer(16);
        const f32 = new Float32Array(data);
        const u32 = new Uint32Array(data);
        f32[0] = intensity;
        f32[1] = 0; // padding
        u32[2] = srcW;
        u32[3] = srcH;
        this.device.queue.writeBuffer(this.rcasUniformBuffer, 0, data);
    }

    _getEasuBindGroup() {
        const key = this.copyTextureView;
        if (this._easuBindGroup && this._easuBindGroupTextureKey === key) {
            return this._easuBindGroup;
        }
        this._easuBindGroup = this.device.createBindGroup({
            label: 'easu-bg',
            layout: this.easuBindGroupLayout,
            entries: [
                { binding: 0, resource: this.copyTextureView },
                { binding: 1, resource: { buffer: this.easuUniformBuffer } },
            ],
        });
        this._easuBindGroupTextureKey = key;
        return this._easuBindGroup;
    }

    _getRcasBindGroup() {
        const key = this.intermediateTextureView;
        if (this._rcasBindGroup && this._rcasBindGroupTextureKey === key) {
            return this._rcasBindGroup;
        }
        this._rcasBindGroup = this.device.createBindGroup({
            label: 'rcas-bg',
            layout: this.rcasBindGroupLayout,
            entries: [
                { binding: 0, resource: this.intermediateTextureView },
                { binding: 1, resource: { buffer: this.rcasUniformBuffer } },
            ],
        });
        this._rcasBindGroupTextureKey = key;
        return this._rcasBindGroup;
    }

    _getBlitToIntermediateBindGroup() {
        const key = this.copyTextureView;
        if (this._blitToIntermediateBindGroup && this._blitToIntermediateTextureKey === key) {
            return this._blitToIntermediateBindGroup;
        }
        this._blitToIntermediateBindGroup = this.device.createBindGroup({
            label: 'blit-to-intermediate-bg',
            layout: this.blitBindGroupLayout,
            entries: [
                { binding: 0, resource: this.copyTextureView },
                { binding: 1, resource: this.linearSampler },
            ],
        });
        this._blitToIntermediateTextureKey = key;
        return this._blitToIntermediateBindGroup;
    }

    _getBlitToCanvasBindGroup(sourceView) {
        if (this._blitToCanvasBindGroup && this._blitToCanvasTextureKey === sourceView) {
            return this._blitToCanvasBindGroup;
        }
        this._blitToCanvasBindGroup = this.device.createBindGroup({
            label: 'blit-to-canvas-bg',
            layout: this.blitBindGroupLayout,
            entries: [
                { binding: 0, resource: sourceView },
                { binding: 1, resource: this.linearSampler },
            ],
        });
        this._blitToCanvasTextureKey = sourceView;
        return this._blitToCanvasBindGroup;
    }

    _encodeEasuPass(encoder, outW, outH) {
        const pass = encoder.beginRenderPass({
            label: 'easu-pass',
            colorAttachments: [{
                view: this.intermediateTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.easuPipeline);
        pass.setBindGroup(0, this._getEasuBindGroup());
        pass.setViewport(0, 0, outW, outH, 0, 1);
        pass.draw(3);
        pass.end();
    }

    _encodeBlitToIntermediate(encoder, outW, outH) {
        const pass = encoder.beginRenderPass({
            label: 'blit-to-intermediate-pass',
            colorAttachments: [{
                view: this.intermediateTextureView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.blitToInternalPipeline);
        pass.setBindGroup(0, this._getBlitToIntermediateBindGroup());
        pass.setViewport(0, 0, outW, outH, 0, 1);
        pass.draw(3);
        pass.end();
    }

    _encodeRcasPass(encoder, canvasView, viewport) {
        const pass = encoder.beginRenderPass({
            label: 'rcas-pass',
            colorAttachments: [{
                view: canvasView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.rcasPipeline);
        pass.setBindGroup(0, this._getRcasBindGroup());
        pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
        pass.draw(3);
        pass.end();
    }

    _encodeBlitToCanvas(encoder, canvasView, sourceView, viewport) {
        const pass = encoder.beginRenderPass({
            label: 'blit-to-canvas-pass',
            colorAttachments: [{
                view: canvasView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.blitToCanvasPipeline);
        pass.setBindGroup(0, this._getBlitToCanvasBindGroup(sourceView));
        pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
        pass.draw(3);
        pass.end();
    }

    resize() {
        const pixelRatio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));

        if (this.canvas.width === width && this.canvas.height === height) {
            return;
        }

        this.canvas.width = width;
        this.canvas.height = height;
        // WebGPU adapta o swap chain automaticamente ao novo tamanho do canvas.
    }

    setSettings(settings) {
        this.settings = { ...this.settings, ...settings };
    }

    render() {
        if (!this.video.videoWidth || !this.video.videoHeight) {
            return false;
        }

        if (this.video.readyState < this.video.HAVE_CURRENT_DATA) {
            return false;
        }

        this.resize();

        const srcW = this.video.videoWidth;
        const srcH = this.video.videoHeight;
        const viewport = buildContainViewport(srcW, srcH, this.canvas.width, this.canvas.height);
        const shouldUseEasu = viewport.width > srcW || viewport.height > srcH;

        // Pass 0: sempre necessário — copia external texture para copyTexture (GPU-side, zero CPU copy).
        // DEVE ser executado e submetido antes de qualquer ponto de await.
        this._ensureCopyTexture(srcW, srcH);
        this._renderCopyPass();

        const encoder = this.device.createCommandEncoder({ label: 'upscaler-encoder' });
        const canvasView = this.context.getCurrentTexture().createView({ label: 'canvas-view' });

        if (!shouldUseEasu && this.settings.intensity <= 0) {
            // Caminho direto: copia para canvas sem processamento.
            this._encodeBlitToCanvas(encoder, canvasView, this.copyTextureView, viewport);
        } else {
            this._ensureIntermediateTexture(viewport.width, viewport.height);

            if (shouldUseEasu) {
                this._writeEasuUniforms(viewport.width, viewport.height, srcW, srcH);
                this._encodeEasuPass(encoder, viewport.width, viewport.height);
            } else {
                this._encodeBlitToIntermediate(encoder, viewport.width, viewport.height);
            }

            if (this.settings.intensity <= 0) {
                this._encodeBlitToCanvas(encoder, canvasView, this.intermediateTextureView, viewport);
            } else {
                this._writeRcasUniforms(this.settings.intensity, viewport.width, viewport.height);
                this._encodeRcasPass(encoder, canvasView, viewport);
            }
        }

        this.device.queue.submit([encoder.finish()]);
        return true;
    }

    dispose() {
        this.copyTexture?.destroy();
        this.intermediateTexture?.destroy();
        this.easuUniformBuffer?.destroy();
        this.rcasUniformBuffer?.destroy();
        this.context.unconfigure();
        this.device.destroy();
    }
}
