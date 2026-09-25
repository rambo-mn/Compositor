// GLSL for the compositor. Every target uses the y-down convention (texel row = output y), so gl_FragCoord.xy is
// the output pixel's centre. Colours are premultiplied throughout, stored 8 bits per channel like the Mac app's
// Core Graphics contexts, so each layer's result is rounded the same way.

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

/** Tiled image sampling: which tile a fragment belongs to, antialiased outer edges, and three filters. */
const SAMPLING = `
uniform mat3 u_outToGrid;     // output pixel → level-0 grid pixel (projective: divide by z)
uniform float u_levelScale;   // grid pixels per level pixel
uniform vec2 u_imageSize;     // level pixels
uniform vec2 u_extent;        // grid pixels the image covers (edges antialias here)
uniform vec4 u_tile;          // interior x, y, width, height (level pixels)
uniform vec4 u_seams;         // left, top, right, bottom: 1 where a neighbouring tile continues
uniform sampler2D u_tex;
uniform vec2 u_texOrigin;     // level pixel of texel (0, 0)
uniform vec2 u_texSize;
uniform int u_sampling;       // 0 nearest, 1 bilinear, 2 bicubic
uniform bool u_antialias;
uniform bool u_useFill;
uniform vec4 u_fill;

vec2 gridPoint() { vec3 g = u_outToGrid * vec3(gl_FragCoord.xy, 1.0); return g.xy / g.z; }

bool outsideTile(vec2 p) {
  return (u_seams.x > 0.5 && p.x < u_tile.x) || (u_seams.y > 0.5 && p.y < u_tile.y)
      || (u_seams.z > 0.5 && p.x >= u_tile.x + u_tile.z) || (u_seams.w > 0.5 && p.y >= u_tile.y + u_tile.w);
}

/** How much of the output pixel the image's outer edges leave covered. dx and dy are the grid point's change
 *  per output pixel (taken before any discard, where derivatives are defined). */
float edgeCoverage(vec2 g, vec2 dx, vec2 dy) {
  if (!u_antialias) {
    bool inside = (u_seams.x > 0.5 || g.x >= 0.0) && (u_seams.y > 0.5 || g.y >= 0.0)
      && (u_seams.z > 0.5 || g.x < u_extent.x) && (u_seams.w > 0.5 || g.y < u_extent.y);
    return inside ? 1.0 : 0.0;
  }
  float gx = max(length(vec2(dx.x, dy.x)), 1e-6);
  float gy = max(length(vec2(dx.y, dy.y)), 1e-6);
  float cx = 1.0, cy = 1.0;
  if (u_seams.x < 0.5) cx = min(cx, g.x / gx + 0.5);
  if (u_seams.z < 0.5) cx = min(cx, (u_extent.x - g.x) / gx + 0.5);
  if (u_seams.y < 0.5) cy = min(cy, g.y / gy + 0.5);
  if (u_seams.w < 0.5) cy = min(cy, (u_extent.y - g.y) / gy + 0.5);
  return clamp(cx, 0.0, 1.0) * clamp(cy, 0.0, 1.0);
}

vec4 fetchClamped(ivec2 q) {
  q = clamp(q, ivec2(0), ivec2(u_imageSize) - 1);
  return texelFetch(u_tex, q - ivec2(u_texOrigin), 0);
}

vec4 catmull(float f) {
  float f2 = f * f, f3 = f2 * f;
  return vec4(-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1.0, -1.5 * f3 + 2.0 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2);
}

/** The image at level pixel position p (texel centres at +0.5). */
vec4 sampleImage(vec2 p) {
  if (u_useFill) return u_fill;
  if (u_sampling == 0) return fetchClamped(ivec2(floor(p)));
  vec2 c = clamp(p, vec2(0.5), u_imageSize - 0.5);
  if (u_sampling == 1) return texture(u_tex, (c - u_texOrigin) / u_texSize);
  vec2 t = c - 0.5;
  vec2 f = fract(t);
  ivec2 i0 = ivec2(floor(t)) - 1;
  vec4 wx = catmull(f.x), wy = catmull(f.y);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    vec4 row = fetchClamped(i0 + ivec2(0, j)) * wx.x + fetchClamped(i0 + ivec2(1, j)) * wx.y
             + fetchClamped(i0 + ivec2(2, j)) * wx.z + fetchClamped(i0 + ivec2(3, j)) * wx.w;
    sum += row * wy[j];
  }
  float a = clamp(sum.a, 0.0, 1.0);
  return vec4(clamp(sum.rgb, vec3(0.0), vec3(a)), a);
}
`;

/** W3C / PDF blend modes on premultiplied colours (Core Graphics uses the same definitions). */
const BLEND = `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }

vec3 blendColors(int mode, vec3 cb, vec3 cs) {
  if (mode == 1) return cb * cs;
  if (mode == 2) return cb + cs - cb * cs;
  if (mode == 3) return mix(2.0 * cb * cs, 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs), step(0.5000001, cb));
  if (mode == 4) return min(cb, cs);
  if (mode == 5) return max(cb, cs);
  if (mode == 6) return abs(cb - cs);
  if (mode == 7) return vec3(dodge(cb.r, cs.r), dodge(cb.g, cs.g), dodge(cb.b, cs.b));
  if (mode == 8) return vec3(burn(cb.r, cs.r), burn(cb.g, cs.g), burn(cb.b, cs.b));
  if (mode == 9) return setLum(setSat(cs, sat(cb)), lum(cb));
  if (mode == 10) return setLum(setSat(cb, sat(cs)), lum(cb));
  if (mode == 11) return setLum(cs, lum(cb));
  if (mode == 12) return setLum(cb, lum(cs));
  return cs;
}

/** Source over backdrop in a blend mode (0 is Normal). */
vec4 blendOver(vec4 src, vec4 dst, int mode) {
  if (mode == 0) return src + dst * (1.0 - src.a);
  float as = src.a, ab = dst.a;
  if (as <= 0.0) return dst;
  vec3 cs = src.rgb / as;
  vec3 cb = ab > 0.0 ? dst.rgb / ab : vec3(0.0);
  vec3 b = clamp(blendColors(mode, clamp(cb, 0.0, 1.0), clamp(cs, 0.0, 1.0)), 0.0, 1.0);
  vec3 co = src.rgb * (1.0 - ab) + dst.rgb * (1.0 - as) + as * ab * b;
  float ao = as + ab * (1.0 - as);
  return vec4(clamp(co, vec3(0.0), vec3(ao)), ao);
}
`;

const COVERAGE_INPUTS = `
uniform sampler2D u_ownMask;
uniform bool u_hasOwnMask;
uniform bool u_useMaskLimit;
uniform vec4 u_maskLimit;     // grid rect beyond which the own mask doesn't apply
uniform sampler2D u_clip;
uniform bool u_hasClip;
uniform int u_clipChannel;    // 0 red, 3 alpha
uniform sampler2D u_backdrop;
uniform int u_blend;          // -1: fixed-function source-over; else a blend mode read against the backdrop
uniform float u_opacity;

float clipCoverage(vec2 g) {
  ivec2 at = ivec2(gl_FragCoord.xy);
  float c = 1.0;
  if (u_hasOwnMask) {
    bool limited = u_useMaskLimit && (g.x < u_maskLimit.x || g.y < u_maskLimit.y
      || g.x >= u_maskLimit.x + u_maskLimit.z || g.y >= u_maskLimit.y + u_maskLimit.w);
    if (!limited) c *= texelFetch(u_ownMask, at, 0).r;
  }
  if (u_hasClip) {
    vec4 clip = texelFetch(u_clip, at, 0);
    c *= u_clipChannel == 3 ? clip.a : clip.r;
  }
  return c;
}
`;

/** One tile of a layer image, with opacity, masks and blend mode. */
export const LAYER_FRAGMENT = HEADER + SAMPLING + BLEND + COVERAGE_INPUTS + `
out vec4 o;
void main() {
  vec2 g = gridPoint();
  vec2 gdx = dFdx(g), gdy = dFdy(g);
  vec2 p = g / u_levelScale;
  if (outsideTile(p)) discard;
  float coverage = edgeCoverage(g, gdx, gdy);
  if (coverage <= 0.0) discard;
  coverage *= u_opacity * clipCoverage(g);
  vec4 src = sampleImage(p) * coverage;
  if (u_blend < 0) { o = src; return; }
  o = blendOver(src, texelFetch(u_backdrop, ivec2(gl_FragCoord.xy), 0), u_blend);
}`;

/** One tile of a mask, as coverage (0–1 in every channel). Beyond its extent a mask either continues its edge
 *  (a layer's own mask) or gives a fixed value (a mask placed apart, a folder's mask). */
export const MASK_FRAGMENT = HEADER + SAMPLING + `
uniform bool u_clampOutside;
uniform float u_outside;
out vec4 o;
void main() {
  vec2 g = gridPoint();
  vec2 gdx = dFdx(g), gdy = dFdy(g);
  vec2 p = g / u_levelScale;
  if (outsideTile(p)) discard;
  float value = sampleImage(p).r;
  if (!u_clampOutside) value = mix(u_outside, value, edgeCoverage(g, gdx, gdy));
  o = vec4(value);
}`;

/** Multiplies the target (red) by a coverage texture's channel. Used with blending off into a copy. */
export const MULTIPLY_FRAGMENT = HEADER + `
uniform sampler2D u_a;
uniform int u_aChannel;
uniform sampler2D u_b;
uniform int u_bChannel;
uniform bool u_hasB;
out vec4 o;
float channel(vec4 v, int c) { return c == 3 ? v.a : v.r; }
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  float a = channel(texelFetch(u_a, at, 0), u_aChannel);
  float b = u_hasB ? channel(texelFetch(u_b, at, 0), u_bChannel) : 1.0;
  o = vec4(a * b);
}`;

/** A whole target drawn over another: a clipping group's result, or an isolated layer. */
export const COMPOSITE_FRAGMENT = HEADER + BLEND + `
uniform sampler2D u_src;
uniform sampler2D u_backdrop;
uniform int u_blend;
uniform sampler2D u_clip;
uniform bool u_hasClip;
uniform int u_clipChannel;
out vec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(u_src, at, 0);
  if (u_hasClip) { vec4 c = texelFetch(u_clip, at, 0); src *= u_clipChannel == 3 ? c.a : c.r; }
  if (u_blend < 0) { o = src; return; }
  o = blendOver(src, texelFetch(u_backdrop, at, 0), u_blend);
}`;

/** Clipping stacks: colours unpremultiplied and made opaque (layer_unpremultiply_opaque), then premultiplied
 *  again by the base's alpha (layer_restore_alpha), with the Mac kernels' integer rounding. */
export const OPAQUE_FRAGMENT = HEADER + `
uniform sampler2D u_src;
out vec4 o;
void main() {
  vec4 v = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  int a = int(v.a * 255.0 + 0.5);
  ivec3 c = ivec3(v.rgb * 255.0 + 0.5);
  ivec3 u = a > 0 ? min((c * 255 + a / 2) / a, ivec3(255)) : ivec3(0);
  o = vec4(vec3(u) / 255.0, 1.0);
}`;

export const RESTORE_FRAGMENT = HEADER + `
uniform sampler2D u_src;
uniform sampler2D u_alpha;
out vec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(u_src, at, 0);
  int a = int(texelFetch(u_alpha, at, 0).a * 255.0 + 0.5);
  ivec3 c = ivec3(v.rgb * 255.0 + 0.5);
  o = vec4(vec3((c * a + 127) / 255) / 255.0, float(a) / 255.0);
}`;

/** Adjustment layers and adjustment previews, applied to what is below (u_backdrop):
 *  0 tables (Levels, Curves, Exposure), 1 colour cube (Hue/Saturation), 2 Gradient Map, 3 Grain. */
export const ADJUST_FRAGMENT = HEADER + BLEND + `
uniform sampler2D u_backdrop;
uniform int u_kind;
uniform sampler2D u_table;     // 256 × 1: red, green, blue output (0–1) per input byte
uniform sampler3D u_cube;
uniform float u_cubeSize;
uniform int u_blend;           // the adjustment layer's blend mode (0 Normal)
uniform float u_opacity;
uniform sampler2D u_ownMask;
uniform bool u_hasOwnMask;
uniform sampler2D u_clip;
uniform bool u_hasClip;
uniform int u_clipChannel;
uniform mat3 u_outToDoc;
uniform float u_unitsPerPixel;
uniform float u_grainAmount;
uniform float u_grainSize;
uniform float u_grainRoughness;
uniform uint u_grainSeed;
out vec4 o;

uint mix32(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
float lattice(int ix, int iy, uint seed) {
  uint h = mix32(uint(ix) * 0x9E3779B1u ^ mix32(uint(iy) * 0x85EBCA77u ^ seed));
  return float(h & 0xFFFFu) / 65535.0 + float(h >> 16u) / 65535.0 - 1.0;
}

vec3 tables(vec4 v) {
  vec3 result;
  for (int k = 0; k < 3; k++) {
    float x = min(255.0, v[k] * 255.0 / v.a);
    int lo = int(x);
    int hi = lo < 255 ? lo + 1 : 255;
    float a = texelFetch(u_table, ivec2(lo, 0), 0)[k], b = texelFetch(u_table, ivec2(hi, 0), 0)[k];
    result[k] = clamp((a + (b - a) * (x - float(lo))) * v.a, 0.0, v.a);
  }
  return result;
}

vec3 cube(vec4 v) {
  vec3 c = clamp(v.rgb / v.a, 0.0, 1.0);
  vec3 r = texture(u_cube, (c * (u_cubeSize - 1.0) + 0.5) / u_cubeSize).rgb;
  return clamp(r, 0.0, 1.0) * v.a;
}

vec3 gradientMap(vec4 v) {
  int a = int(v.a * 255.0 + 0.5);
  ivec3 c = ivec3(v.rgb * 255.0 + 0.5);
  if (a < 255) c = min((c * 255 + a / 2) / a, ivec3(255));
  int level = min(255, (2126 * c.r + 7152 * c.g + 722 * c.b + 5000) / 10000);
  ivec3 color = ivec3(texelFetch(u_table, ivec2(level, 0), 0).rgb * 255.0 + 0.5);
  return vec3((color * a + 127) / 255) / 255.0;
}

vec3 grain(vec4 v) {
  vec2 doc = (u_outToDoc * vec3(gl_FragCoord.xy, 1.0)).xy;
  float size = u_grainSize > 0.0 ? u_grainSize : 1.0;
  float strength = min(1.0, u_grainAmount / 100.0) * 0.35 * 255.0;
  float rough = clamp(u_grainRoughness / 100.0, 0.0, 1.0);
  uint fineSeed = mix32(u_grainSeed ^ 0xA511E9B3u);
  float cellY = floor(doc.y / size), cellX = floor(doc.x / size);
  float ty = doc.y / size - cellY, tx = doc.x / size - cellX;
  ty = ty * ty * (3.0 - 2.0 * ty);
  tx = tx * tx * (3.0 - 2.0 * tx);
  int ix = int(cellX), iy = int(cellY);
  float n00 = lattice(ix, iy, u_grainSeed), n10 = lattice(ix + 1, iy, u_grainSeed);
  float n01 = lattice(ix, iy + 1, u_grainSeed), n11 = lattice(ix + 1, iy + 1, u_grainSeed);
  float top = n00 + (n10 - n00) * tx, bottom = n01 + (n11 - n01) * tx;
  float smoothed = (top + (bottom - top) * ty) * 1.6;
  float fine = lattice(int(floor(doc.x)), int(floor(doc.y)), fineSeed);
  float noise = smoothed + (fine - smoothed) * rough;
  float a8 = floor(v.a * 255.0 + 0.5);
  vec3 c = floor(v.rgb * 255.0 + 0.5) * (a8 >= 255.0 ? 1.0 : 255.0 / a8);
  float level = min(1.0, (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255.0);
  float delta = noise * strength * (0.4 + 2.4 * level * (1.0 - level));
  return floor(clamp(c + delta, 0.0, 255.0) * (a8 / 255.0) + 0.5) / 255.0;
}

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec4 original = texelFetch(u_backdrop, at, 0);
  if (original.a <= 0.0) { o = original; return; }
  float amount = u_opacity;
  if (u_hasOwnMask) amount *= texelFetch(u_ownMask, at, 0).r;
  if (u_hasClip) { vec4 c = texelFetch(u_clip, at, 0); amount *= u_clipChannel == 3 ? c.a : c.r; }
  if (amount <= 0.0) { o = original; return; }
  vec4 adjusted = original;
  if (u_kind == 0) adjusted.rgb = tables(original);
  else if (u_kind == 1) adjusted.rgb = cube(original);
  else if (u_kind == 2) adjusted.rgb = gradientMap(original);
  else if (u_kind == 3 && u_grainAmount > 0.0) adjusted.rgb = grain(original);
  if (u_blend > 0) {
    // Colours blended at full coverage, then the original alpha restored (as the Mac app does).
    vec3 base = clamp(original.rgb / original.a, 0.0, 1.0);
    vec3 top = clamp(adjusted.rgb / original.a, 0.0, 1.0);
    adjusted.rgb = clamp(blendColors(u_blend, base, top), 0.0, 1.0) * original.a;
  }
  o = original + (adjusted - original) * amount;
}`;

/** The document composite over the checkerboard, with the pixel grid and the canvas frame, onto the screen. */
export const PRESENT_FRAGMENT = HEADER + `
uniform sampler2D u_doc;
uniform bool u_hasDoc;
uniform vec2 u_screenSize;     // device pixels
uniform vec4 u_canvas;         // canvas rect in device pixels (y down)
uniform vec4 u_docRect;        // where u_doc's texels land, in device pixels
uniform vec2 u_docSize;        // u_doc's size in texels
uniform bool u_nearest;
uniform float u_checker;       // checker square size in device pixels
uniform float u_dpr;
uniform bool u_grid;
uniform float u_devicePerPixel;
uniform vec4 u_background;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_screenSize.y - gl_FragCoord.y);
  vec3 color = u_background.rgb;
  vec2 lo = u_canvas.xy, hi = u_canvas.xy + u_canvas.zw;
  // The canvas's soft shadow: 14 pt blur, 3 pt down, 35% black.
  vec2 shadowLo = lo + vec2(0.0, 3.0 * u_dpr), shadowHi = hi + vec2(0.0, 3.0 * u_dpr);
  vec2 d = max(max(shadowLo - p, p - shadowHi), vec2(0.0));
  float distance = length(d);
  float shadow = 0.35 * exp(-distance * distance / (2.0 * pow(7.0 * u_dpr, 2.0)));
  bool insideCanvas = p.x >= lo.x && p.y >= lo.y && p.x < hi.x && p.y < hi.y;
  if (!insideCanvas) {
    color = mix(color, vec3(0.0), shadow);
    // A hairline frame just outside the canvas.
    bool frame = p.x >= lo.x - 1.0 && p.y >= lo.y - 1.0 && p.x < hi.x + 1.0 && p.y < hi.y + 1.0;
    if (frame) color = mix(color, vec3(1.0), 0.13);
    o = vec4(color, 1.0);
    return;
  }
  vec2 local = floor((p - lo) / u_checker);
  color = mod(local.x + local.y, 2.0) < 0.5 ? vec3(0.35) : vec3(0.30);
  if (u_hasDoc) {
    vec2 t = (p - u_docRect.xy) / u_docRect.zw * u_docSize;
    vec4 src;
    if (u_nearest) {
      ivec2 q = clamp(ivec2(floor(t)), ivec2(0), ivec2(u_docSize) - 1);
      src = texelFetch(u_doc, q, 0);
    } else {
      src = texture(u_doc, t / u_docSize);
    }
    color = src.rgb + color * (1.0 - src.a);
  }
  if (u_grid) {
    // One device pixel on every document pixel boundary.
    vec2 doc = (p - lo) / u_devicePerPixel;
    vec2 f = abs(doc - floor(doc + 0.5)) * u_devicePerPixel;
    if (min(f.x, f.y) < 0.5) color = mix(color, vec3(0.55), 0.45);
  }
  o = vec4(color, 1.0);
}`;
