// RCAS (Robust Contrast Adaptive Sharpening) — parte do FidelityFX Super Resolution 1.
// Tradução do shader GLSL ES 3.0 original para WGSL.
//
// Diferenças críticas em relação ao GLSL:
// - O GLSL original invertia Y em loadSourceColor: sourceSize.y - 1 - y
//   Isso existia porque texturas no WebGL têm (0,0) na parte inferior.
//   No WebGPU, texturas têm (0,0) na parte SUPERIOR — igual ao @builtin(position).
//   Por isso NÃO há flip de Y aqui.
// - v_texCoord e logicalCoord removidos: pixel_position derivado diretamente de frag_coord.xy.
export const wgslRcasShaderSource = `
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

const RCAS_LIMIT: f32 = 0.25 - (1.0 / 16.0);

struct RcasUniforms {
    intensity: f32,      // offset 0
    _pad: f32,           // offset 4 — padding para alinhar source_size em offset 8
    source_size: vec2u,  // offset 8
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> uniforms: RcasUniforms;

fn load_source_color(pos: vec2i, source_size: vec2i) -> vec3f {
    // WebGPU: (0,0) é o canto superior esquerdo tanto em texturas como em frag_coord.
    // Sem flip de Y (o GLSL original invertia por convenção OpenGL/WebGL).
    let clamped = clamp(pos, vec2i(0), source_size - vec2i(1));
    return textureLoad(source_texture, vec2u(clamped), 0).rgb;
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
    let source_size = vec2i(uniforms.source_size);
    // frag_coord.xy já está em pixel coords top-left — basta converter para inteiro.
    let pixel_position = clamp(vec2i(frag_coord.xy), vec2i(0), source_size - vec2i(1));

    let b = load_source_color(pixel_position + vec2i( 0, -1), source_size);
    let d = load_source_color(pixel_position + vec2i(-1,  0), source_size);
    let e = load_source_color(pixel_position,                 source_size);
    let f = load_source_color(pixel_position + vec2i( 1,  0), source_size);
    let h = load_source_color(pixel_position + vec2i( 0,  1), source_size);

    let min_ring = min(min(min(b, d), f), h);
    let max_ring = max(max(max(b, d), f), h);
    let safe_max = max(max_ring, vec3f(0.00001));
    let safe_min = min(min_ring, vec3f(0.24999));

    let hit_min = min(min_ring, e) / (4.0 * safe_max);
    let hit_max = (1.0 - max(max_ring, e)) / max(4.0 * safe_min - 4.0, vec3f(-3.99999));
    let lobe = max(-hit_min, hit_max);
    let sharpening = clamp(uniforms.intensity, 0.0, 1.2);
    let clipped_lobe = max(-RCAS_LIMIT, min(max(max(lobe.r, lobe.g), lobe.b), 0.0)) * sharpening;
    let recip_lobe = 1.0 / (4.0 * clipped_lobe + 1.0);
    let color = (clipped_lobe * (b + d + f + h) + e) * recip_lobe;

    return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
