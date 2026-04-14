// Vertex shader compartilhado: fullscreen triangle sem vertex buffer.
// NDC(-1,-1) → UV(0,1) | NDC(3,-1) → UV(2,1) | NDC(-1,3) → UV(0,-1)
// Interpolação garante: fragment top-left → UV(0,0), bottom-right → UV(1,1).
const VS_MAIN = `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VertexOutput {
    let x = f32(vid & 1u) * 4.0 - 1.0;
    let y = 1.0 - f32(vid & 2u) * 2.0;
    var out: VertexOutput;
    out.position = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}
`;

// Pass 0: copia GPUExternalTexture (buffer do decoder de vídeo, zero-copy) para GPUTexture rgba8unorm.
// textureSampleBaseClampToEdge é a única função de sampling válida para texture_external.
export const wgslCopyShaderSource = `
${VS_MAIN}

@group(0) @binding(0) var ext_texture: texture_external;
@group(0) @binding(1) var ext_sampler: sampler;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    return textureSampleBaseClampToEdge(ext_texture, ext_sampler, input.uv);
}
`;

// Blit simples de uma GPUTexture regular para outra (usado nos caminhos sem EASU).
export const wgslBlitShaderSource = `
${VS_MAIN}

@group(0) @binding(0) var src_texture: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(src_texture, src_sampler, input.uv);
}
`;
