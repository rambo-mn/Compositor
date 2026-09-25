// WebGL 2 plumbing: programs, render targets and quad drawing. Every offscreen target uses a y-down convention:
// output pixel (x, y) is texel (x, y), so gl_FragCoord.xy − 0.5 is the output pixel and readPixels returns rows
// top to bottom. Only the final draw to the screen flips.

export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  format: 'rgba8' | 'r8';
}

const VERTEX = `#version 300 es
in vec2 a_position;           // output pixels (or unit square for fullscreen passes)
uniform vec2 u_targetSize;
uniform bool u_flipY;
out vec2 v_output;
void main() {
  v_output = a_position;
  vec2 clip = a_position / u_targetSize * 2.0 - 1.0;
  if (u_flipY) clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly floatRenderable: boolean;
  private programs = new Map<string, { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }>();
  private quadBuffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private pool: Target[] = [];
  private inUse = new Set<Target>();
  private scratch = new Float32Array(12);

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2 is not available. Compositor needs a graphics card driver that supports it.');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.floatRenderable = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.quadBuffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.scratch.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** Compiles (once) a fragment program sharing the standard vertex stage. */
  program(name: string, fragment: string): WebGLProgram {
    const cached = this.programs.get(name);
    if (cached) return cached.program;
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        throw new Error(`Shader ${name} failed: ${log}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program ${name} failed: ${gl.getProgramInfoLog(program)}`);
    this.programs.set(name, { program, uniforms: new Map() });
    return program;
  }

  uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    for (const entry of this.programs.values()) {
      if (entry.program !== program) continue;
      if (!entry.uniforms.has(name)) entry.uniforms.set(name, this.gl.getUniformLocation(program, name));
      return entry.uniforms.get(name)!;
    }
    return this.gl.getUniformLocation(program, name);
  }

  use(program: WebGLProgram, target: Target | null, width: number, height: number, flipY = false): void {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(this.uniform(program, 'u_targetSize'), width, height);
    gl.uniform1i(this.uniform(program, 'u_flipY'), flipY ? 1 : 0);
  }

  /** Draws a quad with corners in output pixels (any four points, in order around the quad). */
  drawQuad(points: [number, number][]): void {
    const gl = this.gl;
    const s = this.scratch;
    const [a, b, c, d] = points;
    // Two triangles: a b c, a c d.
    s[0] = a[0]; s[1] = a[1]; s[2] = b[0]; s[3] = b[1]; s[4] = c[0]; s[5] = c[1];
    s[6] = a[0]; s[7] = a[1]; s[8] = c[0]; s[9] = c[1]; s[10] = d[0]; s[11] = d[1];
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, s);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawRect(x: number, y: number, width: number, height: number): void {
    this.drawQuad([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);
  }

  /** A pooled RGBA8 target at least as big as asked (exactly that size, so fragment coordinates line up). */
  acquire(width: number, height: number): Target {
    const index = this.pool.findIndex((t) => t.width === width && t.height === height);
    let target: Target;
    if (index >= 0) target = this.pool.splice(index, 1)[0];
    else target = this.createTarget(width, height);
    this.inUse.add(target);
    return target;
  }

  release(target: Target | null | undefined): void {
    if (!target || !this.inUse.has(target)) return;
    this.inUse.delete(target);
    this.pool.push(target);
    // Keep the pool from growing without bound.
    while (this.pool.length > 12) this.destroyTarget(this.pool.shift()!);
  }

  createTarget(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height, format: 'rgba8' };
  }

  destroyTarget(target: Target): void {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  clear(target: Target | null, r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    if (target) gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Copies a region of `source` into the same place of `destination`'s texture (both targets the same size). */
  copyRegion(source: Target, destination: Target, x: number, y: number, width: number, height: number): void {
    const gl = this.gl;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(source.width, Math.ceil(x + width)), y1 = Math.min(source.height, Math.ceil(y + height));
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, destination.texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x0, y0, x1 - x0, y1 - y0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /** Reads a target back as RGBA bytes, rows top to bottom. */
  read(target: Target, x = 0, y = 0, width = target.width, height = target.height): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  bindTexture(unit: number, texture: WebGLTexture | null, target: number = this.gl.TEXTURE_2D): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
  }

  /** A small float lookup texture (RGBA16F), `width` × 1. */
  createTable(data: Float32Array, width: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** A color cube (RGB per entry, red fastest) as a filterable 3-D texture. */
  createCube(values: Float32Array, dimension: number): WebGLTexture {
    const gl = this.gl;
    const rgba = new Float32Array(dimension * dimension * dimension * 4);
    for (let i = 0; i < dimension * dimension * dimension; i++) {
      rgba[i * 4] = values[i * 3]; rgba[i * 4 + 1] = values[i * 3 + 1]; rgba[i * 4 + 2] = values[i * 3 + 2]; rgba[i * 4 + 3] = 1;
    }
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, dimension, dimension, dimension, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return texture;
  }
}
