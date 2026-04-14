// EASU (Edge Adaptive Spatial Upsampling) — parte do FidelityFX Super Resolution 1.
// Tradução do shader GLSL ES 3.0 original para WGSL.
//
// Diferenças críticas em relação ao GLSL:
// - gl_FragCoord.y=0 ficava na PARTE INFERIOR (OpenGL bottom-up).
//   O GLSL original fazia: logicalFragCoord.y = u_outputSize.y - gl_FragCoord.y
//   No WGSL, @builtin(position).y=0 fica na PARTE SUPERIOR (top-left, igual CSS).
//   Por isso NÃO há flip de Y aqui — frag_coord.xy é usado diretamente.
// - texelFetch(texture, ivec2, 0) → textureLoad(texture, vec2u, 0)
// - inout → ptr<function, T> com acesso via *param
// - ivec2 → vec2i | vec2/3/4 → vec2f/3f/4f
// - inversesqrt → inverseSqrt
export const wgslEasuShaderSource = `
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

struct EasuUniforms {
    output_size: vec2f,   // bytes 0-7
    source_size: vec2u,   // bytes 8-15
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> uniforms: EasuUniforms;

fn load_source_color(pos: vec2i, source_size: vec2i) -> vec3f {
    let clamped = clamp(pos, vec2i(0), source_size - vec2i(1));
    return textureLoad(source_texture, vec2u(clamped), 0).rgb;
}

fn approximate_luma(color: vec3f) -> f32 {
    return color.b * 0.5 + (color.r * 0.5 + color.g);
}

fn easu_set(
    direction: ptr<function, vec2f>,
    length_value: ptr<function, f32>,
    fract_pos: vec2f,
    is_s: bool,
    is_t: bool,
    is_u: bool,
    is_v: bool,
    l_a: f32,
    l_b: f32,
    l_c: f32,
    l_d: f32,
    l_e: f32,
) {
    var weight = 0.0f;
    if is_s { weight = (1.0 - fract_pos.x) * (1.0 - fract_pos.y); }
    if is_t { weight = fract_pos.x * (1.0 - fract_pos.y); }
    if is_u { weight = (1.0 - fract_pos.x) * fract_pos.y; }
    if is_v { weight = fract_pos.x * fract_pos.y; }

    let dc = l_d - l_c;
    let cb = l_c - l_b;
    let length_x = max(abs(dc), abs(cb));
    let direction_x = l_d - l_b;
    (*direction).x += direction_x * weight;
    if length_x > 0.0 {
        let nx = clamp(abs(direction_x) / length_x, 0.0, 1.0);
        *length_value += nx * nx * weight;
    }

    let ec = l_e - l_c;
    let ca = l_c - l_a;
    let length_y = max(abs(ec), abs(ca));
    let direction_y = l_e - l_a;
    (*direction).y += direction_y * weight;
    if length_y > 0.0 {
        let ny = clamp(abs(direction_y) / length_y, 0.0, 1.0);
        *length_value += ny * ny * weight;
    }
}

fn easu_tap(
    acc_color: ptr<function, vec3f>,
    acc_weight: ptr<function, f32>,
    offset: vec2f,
    direction: vec2f,
    length_value: vec2f,
    lobe: f32,
    clipping_point: f32,
    color: vec3f,
) {
    var rot: vec2f;
    rot.x = offset.x * direction.x + offset.y * direction.y;
    rot.y = offset.x * (-direction.y) + offset.y * direction.x;
    rot *= length_value;

    let dist_sq = min(dot(rot, rot), clipping_point);
    var base_val = (2.0 / 5.0) * dist_sq - 1.0;
    var window_val = lobe * dist_sq - 1.0;
    base_val *= base_val;
    window_val *= window_val;
    base_val = (25.0 / 16.0) * base_val - (25.0 / 16.0 - 1.0);

    let w = base_val * window_val;
    *acc_color += color * w;
    *acc_weight += w;
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
    let source_size = vec2i(uniforms.source_size);
    let source_size_f = vec2f(source_size);

    // WebGPU: frag_coord.y=0 está no TOPO — sem flip de Y (diferente do GLSL original).
    let source_position = frag_coord.xy * source_size_f / uniforms.output_size - vec2f(0.5);
    let base_position = floor(source_position);
    let fract_pos = source_position - base_position;
    let base_texel = vec2i(base_position);

    let b = load_source_color(base_texel + vec2i( 0, -1), source_size);
    let c = load_source_color(base_texel + vec2i( 1, -1), source_size);
    let e = load_source_color(base_texel + vec2i(-1,  0), source_size);
    let f = load_source_color(base_texel + vec2i( 0,  0), source_size);
    let g = load_source_color(base_texel + vec2i( 1,  0), source_size);
    let h = load_source_color(base_texel + vec2i( 2,  0), source_size);
    let i = load_source_color(base_texel + vec2i(-1,  1), source_size);
    let j = load_source_color(base_texel + vec2i( 0,  1), source_size);
    let k = load_source_color(base_texel + vec2i( 1,  1), source_size);
    let l = load_source_color(base_texel + vec2i( 2,  1), source_size);
    let n = load_source_color(base_texel + vec2i( 0,  2), source_size);
    let o = load_source_color(base_texel + vec2i( 1,  2), source_size);

    let b_luma = approximate_luma(b);
    let c_luma = approximate_luma(c);
    let e_luma = approximate_luma(e);
    let f_luma = approximate_luma(f);
    let g_luma = approximate_luma(g);
    let h_luma = approximate_luma(h);
    let i_luma = approximate_luma(i);
    let j_luma = approximate_luma(j);
    let k_luma = approximate_luma(k);
    let l_luma = approximate_luma(l);
    let n_luma = approximate_luma(n);
    let o_luma = approximate_luma(o);

    var direction = vec2f(0.0);
    var length_value = 0.0f;

    easu_set(&direction, &length_value, fract_pos, true,  false, false, false, b_luma, e_luma, f_luma, g_luma, j_luma);
    easu_set(&direction, &length_value, fract_pos, false, true,  false, false, c_luma, f_luma, g_luma, h_luma, k_luma);
    easu_set(&direction, &length_value, fract_pos, false, false, true,  false, f_luma, i_luma, j_luma, k_luma, n_luma);
    easu_set(&direction, &length_value, fract_pos, false, false, false, true,  g_luma, j_luma, k_luma, l_luma, o_luma);

    let dir_len_sq = dot(direction, direction);
    if dir_len_sq < (1.0 / 32768.0) {
        direction = vec2f(1.0, 0.0);
    } else {
        direction *= inverseSqrt(dir_len_sq);
    }

    length_value *= 0.5;
    length_value *= length_value;

    let stretch = dot(direction, direction) / max(abs(direction.x), abs(direction.y));
    let aniso_length = vec2f(
        1.0 + (stretch - 1.0) * length_value,
        1.0 - 0.5 * length_value,
    );
    let lobe = 0.5 + ((0.25 - 0.04) - 0.5) * length_value;
    let clipping_point = 1.0 / lobe;

    let min_color = min(min(min(f, g), j), k);
    let max_color = max(max(max(f, g), j), k);
    var acc_color = vec3f(0.0);
    var acc_weight = 0.0f;

    easu_tap(&acc_color, &acc_weight, vec2f( 0.0, -1.0) - fract_pos, direction, aniso_length, lobe, clipping_point, b);
    easu_tap(&acc_color, &acc_weight, vec2f( 1.0, -1.0) - fract_pos, direction, aniso_length, lobe, clipping_point, c);
    easu_tap(&acc_color, &acc_weight, vec2f(-1.0,  1.0) - fract_pos, direction, aniso_length, lobe, clipping_point, i);
    easu_tap(&acc_color, &acc_weight, vec2f( 0.0,  1.0) - fract_pos, direction, aniso_length, lobe, clipping_point, j);
    easu_tap(&acc_color, &acc_weight, vec2f( 0.0,  0.0) - fract_pos, direction, aniso_length, lobe, clipping_point, f);
    easu_tap(&acc_color, &acc_weight, vec2f(-1.0,  0.0) - fract_pos, direction, aniso_length, lobe, clipping_point, e);
    easu_tap(&acc_color, &acc_weight, vec2f( 1.0,  1.0) - fract_pos, direction, aniso_length, lobe, clipping_point, k);
    easu_tap(&acc_color, &acc_weight, vec2f( 2.0,  1.0) - fract_pos, direction, aniso_length, lobe, clipping_point, l);
    easu_tap(&acc_color, &acc_weight, vec2f( 2.0,  0.0) - fract_pos, direction, aniso_length, lobe, clipping_point, h);
    easu_tap(&acc_color, &acc_weight, vec2f( 1.0,  0.0) - fract_pos, direction, aniso_length, lobe, clipping_point, g);
    easu_tap(&acc_color, &acc_weight, vec2f( 1.0,  2.0) - fract_pos, direction, aniso_length, lobe, clipping_point, o);
    easu_tap(&acc_color, &acc_weight, vec2f( 0.0,  2.0) - fract_pos, direction, aniso_length, lobe, clipping_point, n);

    let upscaled = acc_color / max(acc_weight, 0.00001);
    return vec4f(clamp(upscaled, min_color, max_color), 1.0);
}
`;
