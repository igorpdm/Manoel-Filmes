import { fullscreenShaderSource } from './upscaler-shaders/fullscreen.js';
import { copyShaderSource } from './upscaler-shaders/copy.js';
import { easuShaderSource } from './upscaler-shaders/easu.js';
import { rcasShaderSource } from './upscaler-shaders/rcas.js';

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        return shader;
    }

    const details = gl.getShaderInfoLog(shader) || 'Shader compilation failed';
    gl.deleteShader(shader);
    throw new Error(details);
}

function createProgram(gl, vertexSource, fragmentSource) {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return program;
    }

    const details = gl.getProgramInfoLog(program) || 'Program link failed';
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.deleteProgram(program);
    throw new Error(details);
}

function createProgramInfo(gl, fragmentSource, uniformNames) {
    const program = createProgram(gl, fullscreenShaderSource, fragmentSource);
    const uniforms = Object.fromEntries(
        uniformNames.map((name) => [name, gl.getUniformLocation(program, name)])
    );

    return { program, uniforms };
}

function createTexture(gl, minFilter, magFilter) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
    return texture;
}

function createFramebuffer(gl, texture) {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(framebuffer);
        throw new Error('Framebuffer is incomplete');
    }

    return framebuffer;
}

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

export class UpscalerRenderer {
    constructor(canvas, video) {
        this.canvas = canvas;
        this.video = video;
        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            premultipliedAlpha: false,
        });

        if (!this.gl) {
            throw new Error('WebGL2 unavailable');
        }

        this.settings = {
            intensity: 0.5,
            isEnabled: true,
        };

        this.sourceTexture = null;
        this.sourceTextureSize = { width: 0, height: 0 };
        this.intermediateTexture = null;
        this.intermediateFramebuffer = null;
        this.intermediateSize = { width: 0, height: 0 };

        this.programs = {
            copy: createProgramInfo(this.gl, copyShaderSource, ['u_texture', 'u_flipY']),
            easu: createProgramInfo(this.gl, easuShaderSource, ['u_texture', 'u_outputSize']),
            rcas: createProgramInfo(this.gl, rcasShaderSource, ['u_texture', 'u_intensity']),
        };

        this.vao = this.createGeometry();
        this.gl.disable(this.gl.DEPTH_TEST);
        this.gl.disable(this.gl.BLEND);
    }

    createGeometry() {
        const gl = this.gl;
        const vao = gl.createVertexArray();
        const positionBuffer = gl.createBuffer();
        const texCoordBuffer = gl.createBuffer();

        gl.bindVertexArray(vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1.0, -1.0,
            1.0, -1.0,
            -1.0, 1.0,
            -1.0, 1.0,
            1.0, -1.0,
            1.0, 1.0,
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0.0, 0.0,
            1.0, 0.0,
            0.0, 1.0,
            0.0, 1.0,
            1.0, 0.0,
            1.0, 1.0,
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.positionBuffer = positionBuffer;
        this.texCoordBuffer = texCoordBuffer;

        return vao;
    }

    setSettings(settings) {
        this.settings = {
            ...this.settings,
            ...settings,
        };
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
    }

    ensureSourceTexture(width, height) {
        const gl = this.gl;

        if (
            this.sourceTexture
            && this.sourceTextureSize.width === width
            && this.sourceTextureSize.height === height
        ) {
            return;
        }

        if (this.sourceTexture) {
            gl.deleteTexture(this.sourceTexture);
        }

        this.sourceTexture = createTexture(gl, gl.LINEAR, gl.LINEAR);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        this.sourceTextureSize = { width, height };
    }

    ensureIntermediateTarget(width, height) {
        const gl = this.gl;

        if (
            this.intermediateTexture
            && this.intermediateFramebuffer
            && this.intermediateSize.width === width
            && this.intermediateSize.height === height
        ) {
            return;
        }

        if (this.intermediateFramebuffer) {
            gl.deleteFramebuffer(this.intermediateFramebuffer);
        }

        if (this.intermediateTexture) {
            gl.deleteTexture(this.intermediateTexture);
        }

        this.intermediateTexture = createTexture(gl, gl.NEAREST, gl.NEAREST);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        this.intermediateFramebuffer = createFramebuffer(gl, this.intermediateTexture);
        this.intermediateSize = { width, height };
    }

    updateSourceTexture() {
        const gl = this.gl;
        const width = this.video.videoWidth;
        const height = this.video.videoHeight;

        this.ensureSourceTexture(width, height);

        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    }

    clearCanvas() {
        const gl = this.gl;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    bindFullscreenState(programInfo, texture, shouldFlipY = false) {
        const gl = this.gl;
        gl.useProgram(programInfo.program);
        gl.bindVertexArray(this.vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        if (programInfo.uniforms.u_texture) {
            gl.uniform1i(programInfo.uniforms.u_texture, 0);
        }

        if (programInfo.uniforms.u_flipY) {
            gl.uniform1i(programInfo.uniforms.u_flipY, shouldFlipY ? 1 : 0);
        }
    }

    drawFullscreen() {
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    renderCopyToIntermediate(width, height) {
        const gl = this.gl;
        const programInfo = this.programs.copy;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.intermediateFramebuffer);
        gl.viewport(0, 0, width, height);
        this.bindFullscreenState(programInfo, this.sourceTexture, true);
        this.drawFullscreen();
    }

    renderCopyToCanvas(viewport) {
        const gl = this.gl;
        const programInfo = this.programs.copy;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        this.bindFullscreenState(programInfo, this.sourceTexture, true);
        this.drawFullscreen();
    }

    renderEasuToIntermediate(width, height) {
        const gl = this.gl;
        const programInfo = this.programs.easu;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.intermediateFramebuffer);
        gl.viewport(0, 0, width, height);
        this.bindFullscreenState(programInfo, this.sourceTexture);
        gl.uniform2f(programInfo.uniforms.u_outputSize, width, height);
        this.drawFullscreen();
    }

    renderIntermediateToCanvas(viewport, shouldFlipY) {
        const gl = this.gl;
        const programInfo = this.programs.copy;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        this.bindFullscreenState(programInfo, this.intermediateTexture, shouldFlipY);
        this.drawFullscreen();
    }

    renderRcasToCanvas(viewport) {
        const gl = this.gl;
        const programInfo = this.programs.rcas;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        this.bindFullscreenState(programInfo, this.intermediateTexture);
        gl.uniform1f(programInfo.uniforms.u_intensity, this.settings.intensity);
        this.drawFullscreen();
    }

    render() {
        if (!this.video.videoWidth || !this.video.videoHeight) {
            return false;
        }

        if (this.video.readyState < this.video.HAVE_CURRENT_DATA) {
            return false;
        }

        this.resize();
        this.updateSourceTexture();

        const viewport = buildContainViewport(
            this.video.videoWidth,
            this.video.videoHeight,
            this.canvas.width,
            this.canvas.height,
        );
        const shouldUseEasu = viewport.width > this.video.videoWidth || viewport.height > this.video.videoHeight;

        this.clearCanvas();

        if (!shouldUseEasu && this.settings.intensity <= 0) {
            this.renderCopyToCanvas(viewport);
            return true;
        }

        this.ensureIntermediateTarget(viewport.width, viewport.height);

        if (shouldUseEasu) {
            this.renderEasuToIntermediate(viewport.width, viewport.height);
        } else {
            this.renderCopyToIntermediate(viewport.width, viewport.height);
        }

        if (this.settings.intensity <= 0) {
            this.renderIntermediateToCanvas(viewport, false);
            return true;
        }

        this.renderRcasToCanvas(viewport);
        return true;
    }

    dispose() {
        const gl = this.gl;

        if (this.sourceTexture) {
            gl.deleteTexture(this.sourceTexture);
        }

        if (this.intermediateFramebuffer) {
            gl.deleteFramebuffer(this.intermediateFramebuffer);
        }

        if (this.intermediateTexture) {
            gl.deleteTexture(this.intermediateTexture);
        }

        if (this.positionBuffer) {
            gl.deleteBuffer(this.positionBuffer);
        }

        if (this.texCoordBuffer) {
            gl.deleteBuffer(this.texCoordBuffer);
        }

        if (this.vao) {
            gl.deleteVertexArray(this.vao);
        }

        Object.values(this.programs).forEach((programInfo) => {
            if (programInfo?.program) {
                gl.deleteProgram(programInfo.program);
            }
        });
    }
}
