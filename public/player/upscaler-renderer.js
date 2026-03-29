import { upscalerVertexShaderSource, upscalerFragmentShaderSource } from './upscaler-shader.js';

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
        this.gl = canvas.getContext('webgl', {
            alpha: false,
            antialias: false,
        }) || canvas.getContext('experimental-webgl', {
            alpha: false,
            antialias: false,
        });

        if (!this.gl) {
            throw new Error('WebGL unavailable');
        }

        this.program = createProgram(this.gl, upscalerVertexShaderSource, upscalerFragmentShaderSource);
        this.settings = {
            intensity: 0.5,
            isEnabled: true,
            algorithm: 'fsr1',
        };

        this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
        this.texCoordLocation = this.gl.getAttribLocation(this.program, 'a_texCoord');
        this.upscaleEnabledLocation = this.gl.getUniformLocation(this.program, 'u_upscaleEnabled');
        this.algorithmLocation = this.gl.getUniformLocation(this.program, 'u_algorithm');
        this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
        this.intensityLocation = this.gl.getUniformLocation(this.program, 'u_intensity');

        this.positionBuffer = this.gl.createBuffer();
        this.texCoordBuffer = this.gl.createBuffer();
        this.texture = this.gl.createTexture();

        this.configureGeometry();
        this.configureTexture();
        this.resize();
    }

    configureGeometry() {
        const gl = this.gl;

        gl.useProgram(this.program);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1.0, -1.0,
            1.0, -1.0,
            -1.0, 1.0,
            -1.0, 1.0,
            1.0, -1.0,
            1.0, 1.0,
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0.0, 1.0,
            1.0, 1.0,
            0.0, 0.0,
            0.0, 0.0,
            1.0, 1.0,
            1.0, 0.0,
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.texCoordLocation);
        gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 0, 0);
    }

    configureTexture() {
        const gl = this.gl;

        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

    clear() {
        const gl = this.gl;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    render() {
        if (!this.video.videoWidth || !this.video.videoHeight) {
            return false;
        }

        if (this.video.readyState < this.video.HAVE_CURRENT_DATA) {
            return false;
        }

        this.resize();

        const gl = this.gl;
        const viewport = buildContainViewport(
            this.video.videoWidth,
            this.video.videoHeight,
            this.canvas.width,
            this.canvas.height,
        );

        this.clear();

        gl.useProgram(this.program);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        gl.uniform1i(this.upscaleEnabledLocation, this.settings.isEnabled);
        gl.uniform1i(this.algorithmLocation, this.settings.algorithm === 'cas' ? 1 : 0);
        gl.uniform2f(this.resolutionLocation, this.video.videoWidth, this.video.videoHeight);
        gl.uniform1f(this.intensityLocation, this.settings.intensity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        return true;
    }

    dispose() {
        const gl = this.gl;

        if (this.texture) {
            gl.deleteTexture(this.texture);
        }

        if (this.positionBuffer) {
            gl.deleteBuffer(this.positionBuffer);
        }

        if (this.texCoordBuffer) {
            gl.deleteBuffer(this.texCoordBuffer);
        }

        if (this.program) {
            gl.deleteProgram(this.program);
        }
    }
}
