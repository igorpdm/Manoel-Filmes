export const easuShaderSource = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_outputSize;
uniform ivec2 u_sourceSize;

out vec4 outColor;

vec3 loadSourceColor(ivec2 topLeftPosition, ivec2 sourceSize) {
    ivec2 clampedTopLeftPosition = clamp(topLeftPosition, ivec2(0), sourceSize - ivec2(1));
    return texelFetch(u_texture, clampedTopLeftPosition, 0).rgb;
}

float approximateLuma(vec3 color) {
    return color.b * 0.5 + (color.r * 0.5 + color.g);
}

void easuSet(
    inout vec2 direction,
    inout float lengthValue,
    vec2 fractionalPosition,
    bool isS,
    bool isT,
    bool isU,
    bool isV,
    float lA,
    float lB,
    float lC,
    float lD,
    float lE
) {
    float weight = 0.0;

    if (isS) {
        weight = (1.0 - fractionalPosition.x) * (1.0 - fractionalPosition.y);
    }

    if (isT) {
        weight = fractionalPosition.x * (1.0 - fractionalPosition.y);
    }

    if (isU) {
        weight = (1.0 - fractionalPosition.x) * fractionalPosition.y;
    }

    if (isV) {
        weight = fractionalPosition.x * fractionalPosition.y;
    }

    float dc = lD - lC;
    float cb = lC - lB;
    float lengthX = max(abs(dc), abs(cb));
    float directionX = lD - lB;

    direction.x += directionX * weight;

    if (lengthX > 0.0) {
        lengthX = clamp(abs(directionX) / lengthX, 0.0, 1.0);
        lengthValue += lengthX * lengthX * weight;
    }

    float ec = lE - lC;
    float ca = lC - lA;
    float lengthY = max(abs(ec), abs(ca));
    float directionY = lE - lA;

    direction.y += directionY * weight;

    if (lengthY > 0.0) {
        lengthY = clamp(abs(directionY) / lengthY, 0.0, 1.0);
        lengthValue += lengthY * lengthY * weight;
    }
}

void easuTap(
    inout vec3 accumulatedColor,
    inout float accumulatedWeight,
    vec2 offset,
    vec2 direction,
    vec2 lengthValue,
    float lobe,
    float clippingPoint,
    vec3 color
) {
    vec2 rotatedOffset;
    rotatedOffset.x = offset.x * direction.x + offset.y * direction.y;
    rotatedOffset.y = offset.x * -direction.y + offset.y * direction.x;
    rotatedOffset *= lengthValue;

    float distanceSquared = min(dot(rotatedOffset, rotatedOffset), clippingPoint);
    float base = (2.0 / 5.0) * distanceSquared - 1.0;
    float window = lobe * distanceSquared - 1.0;

    base *= base;
    window *= window;
    base = (25.0 / 16.0) * base - (25.0 / 16.0 - 1.0);

    float weight = base * window;
    accumulatedColor += color * weight;
    accumulatedWeight += weight;
}

void main() {
    ivec2 sourceSize = u_sourceSize;
    vec2 sourceSizeFloat = vec2(sourceSize);
    vec2 logicalFragCoord = vec2(gl_FragCoord.x, u_outputSize.y - gl_FragCoord.y);
    vec2 sourcePosition = logicalFragCoord * sourceSizeFloat / u_outputSize - 0.5;
    vec2 basePosition = floor(sourcePosition);
    vec2 fractionalPosition = sourcePosition - basePosition;
    ivec2 baseTexel = ivec2(basePosition);

    vec3 b = loadSourceColor(baseTexel + ivec2(0, -1), sourceSize);
    vec3 c = loadSourceColor(baseTexel + ivec2(1, -1), sourceSize);
    vec3 e = loadSourceColor(baseTexel + ivec2(-1, 0), sourceSize);
    vec3 f = loadSourceColor(baseTexel + ivec2(0, 0), sourceSize);
    vec3 g = loadSourceColor(baseTexel + ivec2(1, 0), sourceSize);
    vec3 h = loadSourceColor(baseTexel + ivec2(2, 0), sourceSize);
    vec3 i = loadSourceColor(baseTexel + ivec2(-1, 1), sourceSize);
    vec3 j = loadSourceColor(baseTexel + ivec2(0, 1), sourceSize);
    vec3 k = loadSourceColor(baseTexel + ivec2(1, 1), sourceSize);
    vec3 l = loadSourceColor(baseTexel + ivec2(2, 1), sourceSize);
    vec3 n = loadSourceColor(baseTexel + ivec2(0, 2), sourceSize);
    vec3 o = loadSourceColor(baseTexel + ivec2(1, 2), sourceSize);

    float bLuma = approximateLuma(b);
    float cLuma = approximateLuma(c);
    float eLuma = approximateLuma(e);
    float fLuma = approximateLuma(f);
    float gLuma = approximateLuma(g);
    float hLuma = approximateLuma(h);
    float iLuma = approximateLuma(i);
    float jLuma = approximateLuma(j);
    float kLuma = approximateLuma(k);
    float lLuma = approximateLuma(l);
    float nLuma = approximateLuma(n);
    float oLuma = approximateLuma(o);

    vec2 direction = vec2(0.0);
    float lengthValue = 0.0;

    easuSet(direction, lengthValue, fractionalPosition, true, false, false, false, bLuma, eLuma, fLuma, gLuma, jLuma);
    easuSet(direction, lengthValue, fractionalPosition, false, true, false, false, cLuma, fLuma, gLuma, hLuma, kLuma);
    easuSet(direction, lengthValue, fractionalPosition, false, false, true, false, fLuma, iLuma, jLuma, kLuma, nLuma);
    easuSet(direction, lengthValue, fractionalPosition, false, false, false, true, gLuma, jLuma, kLuma, lLuma, oLuma);

    float directionLengthSquared = dot(direction, direction);

    if (directionLengthSquared < (1.0 / 32768.0)) {
        direction = vec2(1.0, 0.0);
    } else {
        direction *= inversesqrt(directionLengthSquared);
    }

    lengthValue *= 0.5;
    lengthValue *= lengthValue;

    float stretch = dot(direction, direction) / max(abs(direction.x), abs(direction.y));
    vec2 anisotropicLength = vec2(
        1.0 + (stretch - 1.0) * lengthValue,
        1.0 - 0.5 * lengthValue
    );
    float lobe = 0.5 + ((0.25 - 0.04) - 0.5) * lengthValue;
    float clippingPoint = 1.0 / lobe;

    vec3 minimumColor = min(min(min(f, g), j), k);
    vec3 maximumColor = max(max(max(f, g), j), k);
    vec3 accumulatedColor = vec3(0.0);
    float accumulatedWeight = 0.0;

    easuTap(accumulatedColor, accumulatedWeight, vec2(0.0, -1.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, b);
    easuTap(accumulatedColor, accumulatedWeight, vec2(1.0, -1.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, c);
    easuTap(accumulatedColor, accumulatedWeight, vec2(-1.0, 1.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, i);
    easuTap(accumulatedColor, accumulatedWeight, vec2(0.0, 1.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, j);
    easuTap(accumulatedColor, accumulatedWeight, vec2(0.0, 0.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, f);
    easuTap(accumulatedColor, accumulatedWeight, vec2(-1.0, 0.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, e);
    easuTap(accumulatedColor, accumulatedWeight, vec2(1.0, 1.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, k);
    easuTap(accumulatedColor, accumulatedWeight, vec2(2.0, 1.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, l);
    easuTap(accumulatedColor, accumulatedWeight, vec2(2.0, 0.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, h);
    easuTap(accumulatedColor, accumulatedWeight, vec2(1.0, 0.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, g);
    easuTap(accumulatedColor, accumulatedWeight, vec2(1.0, 2.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, o);
    easuTap(accumulatedColor, accumulatedWeight, vec2(0.0, 2.0) - fractionalPosition, direction, anisotropicLength, lobe, clippingPoint, n);

    vec3 upscaledColor = accumulatedColor / max(accumulatedWeight, 0.00001);
    outColor = vec4(clamp(upscaledColor, minimumColor, maximumColor), 1.0);
}
`;
