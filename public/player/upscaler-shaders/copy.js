export const copyShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
uniform bool u_flipY;

in vec2 v_texCoord;

out vec4 outColor;

void main() {
    vec2 sampleCoord = u_flipY ? vec2(v_texCoord.x, 1.0 - v_texCoord.y) : v_texCoord;
    outColor = texture(u_texture, sampleCoord);
}
`;
