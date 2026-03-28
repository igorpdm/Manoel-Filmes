export const upscalerVertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;

    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
    }
`;

export const upscalerFragmentShaderSource = `
    precision mediump float;

    varying vec2 v_texCoord;

    uniform sampler2D u_image;
    uniform bool u_upscaleEnabled;
    uniform int u_algorithm;
    uniform vec2 u_resolution;
    uniform float u_intensity;

    vec3 applyFsr1Sharpen(
        vec3 colorCenter,
        vec3 colorUp,
        vec3 colorDown,
        vec3 colorLeft,
        vec3 colorRight,
        float intensity
    ) {
        vec3 sharpened = colorCenter * (1.0 + 4.0 * intensity) - (colorUp + colorDown + colorLeft + colorRight) * intensity;
        return clamp(sharpened, 0.0, 1.0);
    }

    vec3 applyCasSharpen(
        vec3 colorCenter,
        vec3 colorUp,
        vec3 colorDown,
        vec3 colorLeft,
        vec3 colorRight,
        float intensity
    ) {
        vec3 minRgb = min(min(min(colorCenter, colorUp), min(colorDown, colorLeft)), colorRight);
        vec3 maxRgb = max(max(max(colorCenter, colorUp), max(colorDown, colorLeft)), colorRight);
        vec3 safeMaxRgb = max(maxRgb, vec3(0.0001));
        vec3 amp = clamp(min(minRgb, 1.0 - maxRgb) / safeMaxRgb, 0.0, 1.0);

        float normalizedIntensity = clamp(intensity, 0.0, 1.2);
        float extraRange = max(normalizedIntensity - 1.0, 0.0) / 0.2;
        float sharpness = normalizedIntensity <= 1.0
            ? mix(0.0, -0.2, normalizedIntensity)
            : mix(-0.2, -0.245, extraRange);

        vec3 weight = amp * sharpness;
        vec3 reciprocalWeight = 1.0 / (1.0 + 4.0 * weight);
        vec3 sharpened = (colorCenter + (colorUp + colorDown + colorLeft + colorRight) * weight) * reciprocalWeight;

        return clamp(sharpened, 0.0, 1.0);
    }

    void main() {
        vec4 color = texture2D(u_image, v_texCoord);

        if (u_upscaleEnabled) {
            vec2 texel = vec2(1.0 / u_resolution.x, 1.0 / u_resolution.y);
            vec3 colorCenter = color.rgb;
            vec3 colorUp = texture2D(u_image, v_texCoord + vec2(0.0, -texel.y)).rgb;
            vec3 colorDown = texture2D(u_image, v_texCoord + vec2(0.0, texel.y)).rgb;
            vec3 colorLeft = texture2D(u_image, v_texCoord + vec2(-texel.x, 0.0)).rgb;
            vec3 colorRight = texture2D(u_image, v_texCoord + vec2(texel.x, 0.0)).rgb;

            color.rgb = u_algorithm == 1
                ? applyCasSharpen(colorCenter, colorUp, colorDown, colorLeft, colorRight, u_intensity)
                : applyFsr1Sharpen(colorCenter, colorUp, colorDown, colorLeft, colorRight, u_intensity);
        }

        gl_FragColor = color;
    }
`;
