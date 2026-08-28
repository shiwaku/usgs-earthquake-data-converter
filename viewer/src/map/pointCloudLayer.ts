import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'

/**
 * 震源を深さ方向に配置して描く点群。MapLibreのカスタムレイヤーとして実装している。
 *
 * **deck.gl を使っていないのは globe のため。** `@deck.gl/mapbox` は globe のとき
 * `_GlobeView` に切り替わるが、その `GlobeViewState` には pitch も bearing も無い。
 * 地図は傾いて描かれ、deck.gl は真上から描くので点が地図から外れる（実測で確認）。
 *
 * 代わりに MapLibre が custom layer 向けに公開している `projectTileFor3D` を使う。
 * これは globe でもメルカトルでも、標高付きの位置を地図と同じ式で投影する。
 * globe では球（半径 GLOBE_RADIUS = 6371008.8m）からの標高(m)として扱われるので、
 * 深さは負の標高としてそのまま渡せる。
 *
 * 位置は「メルカトル 0..1」で渡す（MercatorCoordinate.fromLngLat と同じ座標系）。
 * MapLibre が `defaultProjectionData` をその前提で用意してくれる。
 */

/** 投影のためにMapLibreから渡されるユニフォーム。名前は型定義（ProjectionData）に載っている。 */
const PROJECTION_UNIFORMS = [
  'u_projection_matrix',
  'u_projection_tile_mercator_coords',
  'u_projection_clipping_plane',
  'u_projection_transition',
  'u_projection_fallback_matrix',
] as const

/** 1点あたりのバイト数。pos(vec2 f32) + elevation(f32) + color(4 u8) */
const STRIDE = 2 * 4 + 4 + 4

function vertexSource(input: CustomRenderMethodInput): string {
  return `#version 300 es
${input.shaderData.vertexShaderPrelude}
${input.shaderData.define}
in vec2 a_pos;
in float a_elevation;
in vec4 a_color;
uniform float u_size;
out vec4 v_color;
out vec4 v_pick;

void main() {
  // ピッキング用の色。頂点の番号を24bitに詰める。0は「当たりなし」に使うので+1する
  uint pid = uint(gl_VertexID) + 1u;
  v_pick = vec4(
    float(pid & 255u) / 255.0,
    float((pid >> 8) & 255u) / 255.0,
    float((pid >> 16) & 255u) / 255.0,
    1.0);

#ifdef GLOBE
  // 3D経路（projectTileFor3D）は球の裏側を落としてくれない。
  // 2D経路が深度で行っているクリップを、ここでは頂点を画面外へ飛ばして代用する。
  vec3 spherePos = projectToSphere(a_pos, a_pos);
  vec3 elevated = spherePos * (1.0 + a_elevation / GLOBE_RADIUS);
  if (dot(elevated, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_color = vec4(0.0);
    v_pick = vec4(0.0);
    return;
  }
#endif
  gl_Position = projectTileFor3D(a_pos, a_elevation);
  gl_PointSize = u_size;
  v_color = a_color;
}`
}

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec4 v_color;
in vec4 v_pick;
uniform float u_opacity;
uniform bool u_picking;
out vec4 fragColor;

void main() {
  // 四角い点は目立ちすぎるので丸く落とす
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  if (u_picking) {
    fragColor = v_pick;
    return;
  }
  float a = v_color.a * u_opacity;
  // MapLibreのキャンバスは乗算済みアルファ
  fragColor = vec4(v_color.rgb * a, a);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`シェーダのコンパイルに失敗: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

export interface PointCloudPoint {
  /** メルカトル 0..1 */
  x: number
  y: number
  /** 標高(m)。地下は負。 */
  elevation: number
  color: [number, number, number]
}

/**
 * 点群レイヤー。データは setPoints で丸ごと差し替える。
 * 点は数十万〜百万件になるので、属性は1本のインターリーブしたバッファに詰める。
 */
export class PointCloudLayer implements CustomLayerInterface {
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  private map: MapLibreMap | null = null
  private gl: WebGL2RenderingContext | null = null
  /** 直近の描画で渡された投影データ。クリック判定のときに使い回す。 */
  private lastInput: CustomRenderMethodInput | null = null
  private pickFbo: WebGLFramebuffer | null = null
  private pickTexture: WebGLTexture | null = null
  private pickWidth = 0
  private pickHeight = 0
  private program: WebGLProgram | null = null
  /** ユニフォームの位置。getUniformLocation は毎フレーム引くには重い。 */
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  /** 投影が変わるとpreludeも変わる。作り直しの判断に使う。 */
  private variant = ''
  private buffer: WebGLBuffer | null = null
  private vao: WebGLVertexArrayObject | null = null
  private data = new ArrayBuffer(0)
  private count = 0
  private dirty = false

  /** 点の大きさ(px)と不透明度。外から差し替える。 */
  size = 2
  opacity = 0.25

  constructor(readonly id: string) {}

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map
    this.gl = gl
    this.buffer = gl.createBuffer()
    this.vao = gl.createVertexArray()
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.program) gl.deleteProgram(this.program)
    if (this.buffer) gl.deleteBuffer(this.buffer)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo)
    if (this.pickTexture) gl.deleteTexture(this.pickTexture)
    this.pickFbo = null
    this.pickTexture = null
    this.pickWidth = 0
    this.pickHeight = 0
    this.lastInput = null
    this.program = null
    this.buffer = null
    this.vao = null
    this.variant = ''
  }

  /** 点を丸ごと差し替える。次の描画でGPUへ上げる。 */
  setPoints(points: Iterable<PointCloudPoint>, count: number): void {
    const data = new ArrayBuffer(count * STRIDE)
    const f32 = new Float32Array(data)
    const u8 = new Uint8Array(data)
    let i = 0
    for (const p of points) {
      if (i >= count) break
      const f = i * (STRIDE / 4)
      f32[f] = p.x
      f32[f + 1] = p.y
      f32[f + 2] = p.elevation
      const b = i * STRIDE + 12
      u8[b] = p.color[0]
      u8[b + 1] = p.color[1]
      u8[b + 2] = p.color[2]
      u8[b + 3] = 255
      i++
    }
    this.data = data
    this.count = i
    this.dirty = true
    this.map?.triggerRepaint()
  }

  /** 投影が変わったらプログラムを作り直す。preludeが別物になるため。 */
  private ensureProgram(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): WebGLProgram {
    if (this.program && this.variant === input.shaderData.variantName) return this.program
    if (this.program) gl.deleteProgram(this.program)
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource(input)))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`シェーダのリンクに失敗: ${gl.getProgramInfoLog(program)}`)
    }
    this.program = program
    this.variant = input.shaderData.variantName
    this.uniforms = {}
    for (const name of [...PROJECTION_UNIFORMS, 'u_size', 'u_opacity', 'u_picking']) {
      // preludeが使っていないユニフォームはリンク時に消えるのでnullになる
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }

    // 属性の割り当てはプログラムごとに決まるので、VAOもここで組み直す
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    const pos = gl.getAttribLocation(program, 'a_pos')
    const elev = gl.getAttribLocation(program, 'a_elevation')
    const color = gl.getAttribLocation(program, 'a_color')
    gl.enableVertexAttribArray(pos)
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, STRIDE, 0)
    gl.enableVertexAttribArray(elev)
    gl.vertexAttribPointer(elev, 1, gl.FLOAT, false, STRIDE, 8)
    gl.enableVertexAttribArray(color)
    gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12)
    gl.bindVertexArray(null)
    return program
  }

  private setProjectionUniforms(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    const p = input.defaultProjectionData
    for (const name of PROJECTION_UNIFORMS) {
      const location = this.uniforms[name]
      if (!location) continue
      if (name === 'u_projection_matrix') gl.uniformMatrix4fv(location, false, p.mainMatrix)
      else if (name === 'u_projection_fallback_matrix') gl.uniformMatrix4fv(location, false, p.fallbackMatrix)
      else if (name === 'u_projection_tile_mercator_coords') gl.uniform4fv(location, p.tileMercatorCoords)
      else if (name === 'u_projection_clipping_plane') gl.uniform4fv(location, p.clippingPlane)
      else if (name === 'u_projection_transition') gl.uniform1f(location, p.projectionTransition)
    }
  }

  /**
   * 画面座標にある点の番号（setPointsで渡した並びの何番目か）を返す。当たらなければ null。
   *
   * GPUに描かせて読み戻す。点は最大百万件あり、JS側で1点ずつ投影して探すのは重い。
   * それに、globeでの投影は MapLibre のシェーダの中にしかない。同じシェーダに
   * 番号を色として描かせ、クリック位置の画素を読むのが素直で正確。
   *
   * 投影データは直近の描画で渡されたものを使い回す。クリックの瞬間は地図が
   * 止まっているので、1フレーム前の行列で問題ない。
   */
  pick(x: number, y: number, radius = 5): number | null {
    const gl = this.gl
    const input = this.lastInput
    const canvas = this.map?.getCanvas()
    if (!gl || !input || !canvas || !this.count) return null

    const width = canvas.width
    const height = canvas.height
    const program = this.ensureProgram(gl, input)

    if (!this.pickFbo || this.pickWidth !== width || this.pickHeight !== height) {
      if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo)
      if (this.pickTexture) gl.deleteTexture(this.pickTexture)
      this.pickTexture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.pickTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      this.pickFbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0)
      this.pickWidth = width
      this.pickHeight = height
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo)
    }

    const ratio = width / (canvas.clientWidth || 1)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.STATIC_DRAW)
      this.dirty = false
    }
    this.setProjectionUniforms(gl, input)
    gl.uniform1i(this.uniforms['u_picking'], 1)
    // 点は小さいので、当たり判定のときだけ大きく描く
    gl.uniform1f(this.uniforms['u_size'], (this.size + 4) * ratio)
    // MapLibreが直前の描画で残した状態を明示的に落とす。とくに scissor と stencil は
    // タイルの切り抜きに使われており、そのままだと描いた点が丸ごと捨てられる。
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.colorMask(true, true, true, true)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.POINTS, 0, this.count)
    gl.bindVertexArray(null)

    // WebGLのYは下から上。読み取りは画面外へはみ出さないように詰める
    const r = Math.round(radius * ratio)
    const px = Math.round(x * ratio)
    const py = Math.round(height - y * ratio)
    const x0 = Math.max(0, px - r)
    const y0 = Math.max(0, py - r)
    const w = Math.min(width, px + r + 1) - x0
    const h = Math.min(height, py + r + 1) - y0
    let found: number | null = null
    if (w > 0 && h > 0) {
      const pixels = new Uint8Array(w * h * 4)
      gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      // クリック位置にいちばん近い当たりを採る
      let best = Infinity
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const o = (j * w + i) * 4
          if (pixels[o + 3] === 0) continue
          const id = pixels[o] | (pixels[o + 1] << 8) | (pixels[o + 2] << 16)
          if (id === 0) continue
          const dx = x0 + i - px
          const dy = y0 + j - py
          const d = dx * dx + dy * dy
          if (d < best) {
            best = d
            found = id - 1
          }
        }
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    // 画面のフレームバッファは触っていないので再描画は要らない。
    // ここで triggerRepaint すると、カーソルを動かしている間ずっと描き直し続ける。
    return found
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    this.gl = gl
    this.lastInput = input
    if (!this.count) return
    const program = this.ensureProgram(gl, input)
    gl.useProgram(program)
    gl.uniform1i(this.uniforms['u_picking'], 0)

    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.STATIC_DRAW)
      this.dirty = false
    }

    this.setProjectionUniforms(gl, input)
    const canvas = this.map?.getCanvas()
    const pixelRatio = canvas ? canvas.width / (canvas.clientWidth || 1) : 1
    gl.uniform1f(this.uniforms['u_size'], this.size * pixelRatio)
    gl.uniform1f(this.uniforms['u_opacity'], this.opacity)

    // 地下の点まで見せたいので深度テストはしない。重なりの濃さで密度を見せる。
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.POINTS, 0, this.count)
    gl.bindVertexArray(null)
  }
}
