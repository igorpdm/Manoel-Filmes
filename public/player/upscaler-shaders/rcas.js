export const rcasShaderSource = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform float u_intensity;

in vec2 v_texCoord;

out vec4 outColor;

const float RCAS_LIMIT = 0.25 - (1.0 / 16.0);

vec3 loadSourceColor(ivec2 topLeftPosition, ivec2 sourceSize) {
    ivec2 clampedTopLeftPosition = clamp(topLeftPosition, ivec2(0), sourceSize - ivec2(1));
    ivec2 texturePosition = ivec2(clampedTopLeftPosition.x, sourceSize.y - 1 - clampedTopLeftPosition.y);
    return texelFetch(u_texture, texturePosition, 0).rgb;
}

void main() {
    ivec2 sourceSize = textureSize(u_texture, 0);
    vec2 logicalCoord = vec2(v_texCoord.x, 1.0 - v_texCoord.y);
    ivec2 pixelPosition = clamp(ivec2(floor(logicalCoord * vec2(sourceSize))), ivec2(0), sourceSize - ivec2(1));

    vec3 b = loadSourceColor(pixelPosition + ivec2(0, -1), sourceSize);
    vec3 d = loadSourceColor(pixelPosition + ivec2(-1, 0), sourceSize);
    vec3 e = loadSourceColor(pixelPosition, sourceSize);
    vec3 f = loadSourceColor(pixelPosition + ivec2(1, 0), sourceSize);
    vec3 h = loadSourceColor(pixelPosition + ivec2(0, 1), sourceSize);

    vec3 minRing = min(min(min(b, d), f), h);
    vec3 maxRing = max(max(max(b, d), f), h);
    vec3 safeMaxRing = max(maxRing, vec3(0.00001));
    vec3 safeMinRing = min(minRing, vec3(0.24999));

    vec3 hitMin = min(minRing, e) / (4.0 * safeMaxRing);
    vec3 hitMax = (1.0 - max(maxRing, e)) / max(4.0 * safeMinRing - 4.0, vec3(-3.99999));
    vec3 lobe = max(-hitMin, hitMax);
    float sharpeningAmount = clamp(u_intensity, 0.0, 1.2);
    float clippedLobe = max(-RCAS_LIMIT, min(max(max(lobe.r, lobe.g), lobe.b), 0.0)) * sharpeningAmount;
    float reciprocalLobe = 1.0 / (4.0 * clippedLobe + 1.0);
    vec3 color = (clippedLobe * (b + d + f + h) + e) * reciprocalLobe;

    outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
