import { expandTriangleSoup } from './data-tables.js';
import { normalMatrix } from './math.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log + '\n---\n' + src);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class VisibilityRenderer {
  constructor(canvas, tables, scene, shaderSources) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.tables = tables;
    this.scene = scene;
    this.ext = {
      colorFloat: gl.getExtension('EXT_color_buffer_float'),
      colorHalfFloat: gl.getExtension('EXT_color_buffer_half_float'),
    };
    if (!this.ext.colorFloat && !this.ext.colorHalfFloat) {
      throw new Error('需要 EXT_color_buffer_float / EXT_color_buffer_half_float 以写入重心浮点缓冲');
    }
    this.progs = {
      visibility: program(gl, shaderSources.visVS, shaderSources.visFS),
      resolve: program(gl, shaderSources.fullVS, shaderSources.resolveFS),
      forward: program(gl, shaderSources.fwdVS, shaderSources.fwdFS),
      blit: program(gl, shaderSources.fullVS, shaderSources.blitFS),
      diff: program(gl, shaderSources.fullVS, shaderSources.diffFS),
      dbgIdentity: program(gl, shaderSources.fullVS, shaderSources.dbgIdentityFS),
      dbgBary: program(gl, shaderSources.fullVS, shaderSources.dbgBaryFS),
    };
    this.shaderSources = shaderSources;
    this._buildDataTextures();
    this._buildGeometryBuffers();
    this._buildMaterialTextures();
    this._buildVisibilityTargets();
    this._buildBlitQuad();
    this.captureSnapshot();
    this.stats = { invalidPixels: 0, totalPixels: 0, versionMismatches: 0 };
  }

  _buildDataTextures() {
    const gl = this.gl, t = this.tables;
    // Vertex table: 2 RGBA32F rows, one texel column per vertex.
    this.vertTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.vertTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, t.totalVertices, 2, 0, gl.RGBA, gl.FLOAT, t.vertData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Index table: R32I, width 3, height = triangle count.
    this.indexTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 3, t.totalTriangles, 0, gl.RED_INTEGER, gl.INT, t.indexData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Geometry info: R32UI, width 4 (vertStart,indexStart,triCount,id), per geometry.
    const gi = new Uint32Array(t.geomInfo.length * 4);
    t.geomInfo.forEach((g, i) => {
      gi[i * 4] = g.vertStart; gi[i * 4 + 1] = g.indexStart;
      gi[i * 4 + 2] = g.triCount; gi[i * 4 + 3] = g.id;
    });
    this.geomTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.geomTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, 4, t.geomInfo.length, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, gi);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  _buildGeometryBuffers() {
    const gl = this.gl;
    this.geometryGL = this.scene.geometries.map((g) => {
      const soup = expandTriangleSoup(g.mesh);
      const mk = (data, loc, size, type = gl.FLOAT) => {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, type, false, 0, 0);
        return buf;
      };
      const visVAO = gl.createVertexArray();
      gl.bindVertexArray(visVAO);
      mk(soup.pos, 0, 3);
      mk(soup.nrm, 1, 3);
      mk(soup.uv, 2, 2);
      mk(soup.bary, 3, 3);
      gl.bindVertexArray(null);

      // Forward (indexed) VAO.
      const fwdVAO = gl.createVertexArray();
      gl.bindVertexArray(fwdVAO);
      const fPos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fPos);
      gl.bufferData(gl.ARRAY_BUFFER, g.mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const fNrm = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fNrm);
      gl.bufferData(gl.ARRAY_BUFFER, g.mesh.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      const fUv = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fUv);
      gl.bufferData(gl.ARRAY_BUFFER, g.mesh.uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(g.mesh.indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);

      return { visVAO, fwdVAO, soupVertexCount: soup.vertexCount, indexCount: g.mesh.indices.length };
    });
  }

  _buildMaterialTextures() {
    const gl = this.gl;
    // Two banks: snapshot (captured with visibility) and live (rebind path).
    this.snapshotTextures = [];
    this.liveTextures = [];
    for (const m of this.scene.materials) {
      this.snapshotTextures.push(this._uploadImage(m.texture));
      this.liveTextures.push(this._uploadImage(m.texture));
    }
    // Track the source texture version each bank currently holds.
    this.snapshotVersions = this.scene.materials.map((m) => m.version);
    this.liveVersions = this.scene.materials.map((m) => m.version);
  }

  _uploadImage(tex) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.size, tex.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  // Re-sync a material's texture bank after an edit.
  refreshMaterial(materialId) {
    const gl = this.gl;
    const m = this.scene.materials[materialId];
    gl.bindTexture(gl.TEXTURE_2D, this.liveTextures[materialId]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.texture.size, m.texture.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.texture.data);
    this.liveVersions[materialId] = m.version;
  }

  // Freeze the descriptor snapshot at visibility-capture time.
  captureSnapshot() {
    const gl = this.gl;
    this.scene.materials.forEach((m, i) => {
      gl.bindTexture(gl.TEXTURE_2D, this.snapshotTextures[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.texture.size, m.texture.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.texture.data);
      this.snapshotVersions[i] = m.version;
    });
    this.snapshotBase = this.scene.materials.map((m) => m.baseColor.slice());
    this.snapshotRough = this.scene.materials.map((m) => m.roughness);
    this.snapshotMetal = this.scene.materials.map((m) => m.metalness);
  }

  _buildVisibilityTargets() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    this.identityTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.identityTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.baryTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.baryTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.visDepth = this._makeDepth(w, h);
    this.visFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.visFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.identityTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.baryTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.visDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Visibility framebuffer incomplete');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Resolve/forward targets for readback & comparison.
    this.resolveTex = this._makeColorTarget(w, h, gl.RGBA8);
    this.resolveDepth = this._makeDepth(w, h);
    this.resolveFB = this._makeFB(this.resolveTex, this.resolveDepth);
    this.forwardTex = this._makeColorTarget(w, h, gl.RGBA8);
    this.forwardDepth = this._makeDepth(w, h);
    this.forwardFB = this._makeFB(this.forwardTex, this.forwardDepth);
    this.diffTex = this._makeColorTarget(w, h, gl.RGBA8);
    this.diffFB = this._makeFB(this.diffTex, null);
  }

  _makeDepth(w, h) {
    const gl = this.gl, rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    return rb;
  }

  _makeColorTarget(w, h, internal) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
  _makeFB(tex, depthRB) {
    const gl = this.gl, fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (depthRB) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }

  _buildBlitQuad() {
    // Fullscreen triangle is generated from gl_VertexID; VAO still required.
    const gl = this.gl;
    this.emptyVAO = gl.createVertexArray();
  }

  // ---- Frame rendering -------------------------------------------------
  renderFrame(camera, batches, opts) {
    const gl = this.gl;
    const { view, viewProj, camPos, background } = camera;
    // In snapshot strategy the descriptor is frozen with the visibility buffer
    // until explicitly released; rebind strategy always sees live materials.
    if (!opts.freezeSnapshot) this.captureSnapshot();

    this._visibilityPass(viewProj, batches);
    this._forwardPass(viewProj, view, camPos, batches, opts.outputMode);
    this._resolvePass(view, viewProj, camPos, background, opts);
    this._diffPass();
    return this._measure();
  }

  _visibilityPass(viewProj, batches) {
    const gl = this.gl, p = this.progs.visibility;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.visFB);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    // Clear identity to 0 -> valid bit clear, so background/clipped pixels are
    // explicitly invalid rather than reading as instance 0 / primitive 0.
    gl.clearBufferuiv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 1]);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uViewProj'), false, viewProj);
    for (const b of batches) {
      const ins = this.scene.instances[b.instanceId];
      const ggl = this.geometryGL[b.geometryId];
      gl.bindVertexArray(ggl.visVAO);
      gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uModel'), false, ins.model);
      gl.uniform1i(gl.getUniformLocation(p, 'uInstanceId'), ins.id);
      gl.drawArrays(gl.TRIANGLES, 0, ggl.soupVertexCount);
    }
    gl.bindVertexArray(null);
  }

  _forwardPass(viewProj, view, camPos, batches, outputMode) {
    const gl = this.gl, p = this.progs.forward;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.forwardFB);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.05, 0.07, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(p, 'uCamPos'), camPos);
    gl.uniform1i(gl.getUniformLocation(p, 'uOutputMode'), outputMode);

    for (const b of batches) {
      const ins = this.scene.instances[b.instanceId];
      const m = this.scene.materials[ins.materialId];
      const ggl = this.geometryGL[b.geometryId];
      gl.bindVertexArray(ggl.fwdVAO);
      gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uModel'), false, ins.model);
      gl.uniformMatrix3fv(gl.getUniformLocation(p, 'uNormalMat'), false, normalMatrix(ins.model));
      gl.uniform4fv(gl.getUniformLocation(p, 'uBaseRough'), [...m.baseColor, m.roughness]);
      gl.uniform1f(gl.getUniformLocation(p, 'uMetal'), m.metalness);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.liveTextures[ins.materialId]);
      gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);
      gl.drawElements(gl.TRIANGLES, ggl.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  _setMaterialUniforms(p, opts) {
    const gl = this.gl;
    const mats = this.scene.materials;
    const base = new Float32Array(5 * 4);
    const metal = new Float32Array(5);
    const boundVer = new Int32Array(5);
    const liveVer = new Int32Array(5);
    const units = new Int32Array(5);
    mats.forEach((m, i) => {
      const useSnapshot = opts.materialMode === 0;
      const sb = useSnapshot && this.snapshotBase ? this.snapshotBase[i] : m.baseColor;
      const sr = useSnapshot && this.snapshotRough ? this.snapshotRough[i] : m.roughness;
      const sm = useSnapshot && this.snapshotMetal ? this.snapshotMetal[i] : m.metalness;
      base[i * 4] = sb[0]; base[i * 4 + 1] = sb[1]; base[i * 4 + 2] = sb[2];
      base[i * 4 + 3] = sr;
      metal[i] = sm;
      // The "bound" version reflects whichever bank is attached this pass.
      boundVer[i] = useSnapshot ? this.snapshotVersions[i] : this.liveVersions[i];
      liveVer[i] = this.liveVersions[i];
      // Material textures occupy units 5..(5+N-1); data textures use 0..4.
      units[i] = 5 + i;
    });
    gl.uniform4fv(gl.getUniformLocation(p, 'uMatBase'), base);
    gl.uniform1fv(gl.getUniformLocation(p, 'uMatMetal'), metal);
    gl.uniform1iv(gl.getUniformLocation(p, 'uMatVersion'), boundVer);
    gl.uniform1iv(gl.getUniformLocation(p, 'uMatLiveVersion'), liveVer);
    gl.uniform1iv(gl.getUniformLocation(p, 'uMatTex[0]'), units);
    mats.forEach((m, i) => {
      gl.activeTexture(gl.TEXTURE0 + 5 + i);
      const bank = opts.materialMode === 0 ? this.snapshotTextures : this.liveTextures;
      gl.bindTexture(gl.TEXTURE_2D, bank[i]);
    });
    gl.activeTexture(gl.TEXTURE0);
  }

  _resolvePass(view, viewProj, camPos, background, opts) {
    const gl = this.gl, p = this.progs.resolve;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFB);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVAO);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.identityTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uIdentityTex'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.baryTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uBaryTex'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.vertTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uVertTex'), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uIndexTex'), 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.geomTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uGeomTex'), 4);

    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(p, 'uCamPos'), camPos);
    gl.uniform3fv(gl.getUniformLocation(p, 'uBackground'), background);
    gl.uniform1i(gl.getUniformLocation(p, 'uPerspectiveCorrect'), opts.perspective ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uMaterialMode'), opts.materialMode);
    gl.uniform1i(gl.getUniformLocation(p, 'uOutputMode'), opts.outputMode);
    gl.uniform2f(gl.getUniformLocation(p, 'uViewport'), this.canvas.width, this.canvas.height);
    gl.uniform1i(gl.getUniformLocation(p, 'uVisFrameToken'), this.visToken || 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uCurrentFrameToken'), this.curToken || 0);

    // Per-instance tables.
    const inst = this.scene.instances;
    const iGeo = new Int32Array(16), iMat = new Int32Array(16);
    const models = [], normals = [];
    inst.forEach((ins, i) => {
      iGeo[i] = ins.geometryId; iMat[i] = ins.materialId;
      models.push(ins.model); normals.push(normalMatrix(ins.model));
    });
    gl.uniform1iv(gl.getUniformLocation(p, 'uInstanceGeometry'), iGeo);
    gl.uniform1iv(gl.getUniformLocation(p, 'uInstanceMaterial'), iMat);
    gl.uniform1i(gl.getUniformLocation(p, 'uInstanceCount'), inst.length);
    const modelLoc = gl.getUniformLocation(p, 'uInstanceModel[0]');
    const nrmLoc = gl.getUniformLocation(p, 'uInstanceNormalMat[0]');
    const flatModel = new Float32Array(16 * 16);
    const flatNrm = new Float32Array(9 * 16);
    models.forEach((m, i) => flatModel.set(m, i * 16));
    normals.forEach((n, i) => flatNrm.set(n, i * 9));
    gl.uniformMatrix4fv(modelLoc, false, flatModel);
    gl.uniformMatrix3fv(nrmLoc, false, flatNrm);

    this._setMaterialUniforms(p, opts);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _diffPass() {
    const gl = this.gl, p = this.progs.diff;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.diffFB);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uA'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.forwardTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uB'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.identityTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uIdentity'), 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // Read back at reduced resolution for metrics; full-res stays on GPU.
  _measure() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const step = 4;
    const rw = Math.ceil(w / step), rh = Math.ceil(h / step);
    const id = new Uint32Array(w * h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.visFB);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, id);

    let invalid = 0, covered = 0, mismatches = 0;
    for (let i = 0; i < id.length; i++) {
      if ((id[i] & 0x80000000) === 0) invalid++;
      else covered++;
    }
    const diff = new Uint8Array(rw * rh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.diffFB);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    // Downsample on CPU by reading full then averaging stride pixels.
    const full = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, full);
    let sum = 0, n = 0, max = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const d = (full[i] + full[i + 1] + full[i + 2]) / 3;
        if ((id[y * w + x] & 0x80000000) !== 0) { sum += d; n++; if (d > max) max = d; }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stats = {
      invalidPixels: invalid,
      coveredPixels: covered,
      totalPixels: w * h,
      meanDiff8: n ? sum / n : 0,
      maxDiff8: max,
      coverage: covered / (w * h),
    };
    return this.stats;
  }

  blit(target, mode = 0) {
    const gl = this.gl, p = this.progs.blit;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uMode'), mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // Render a decoded debug view of an internal buffer to the default target.
  renderDebug(kind, background) {
    const gl = this.gl;
    const p = kind === 'identity' ? this.progs.dbgIdentity : this.progs.dbgBary;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.identityTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uIdentity'), 0);
    gl.uniform3fv(gl.getUniformLocation(p, 'uBackground'), background);
    if (kind === 'bary') {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.baryTex);
      gl.uniform1i(gl.getUniformLocation(p, 'uBary'), 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // Read the raw packed identity at a device pixel (for the probe panel).
  readIdentityAt(x, y) {
    const gl = this.gl;
    const h = this.canvas.height;
    const fy = h - 1 - y; // GL origin bottom-left
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.visFB);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Uint32Array(1);
    gl.readPixels(x, fy, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const packed = out[0];
    const valid = (packed & 0x80000000) !== 0;
    return {
      packed,
      valid,
      instanceId: valid ? (packed >> 16) & 0xff : -1,
      primitiveId: valid ? packed & 0xffff : -1,
    };
  }

  readColorAt(framebuffer, x, y) {
    const gl = this.gl;
    const fy = this.canvas.height - 1 - y;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Uint8Array(4);
    gl.readPixels(x, fy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  resize(w, h) {
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.identityTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.baryTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    for (const [tex, internal] of [[this.resolveTex, gl.RGBA8], [this.forwardTex, gl.RGBA8], [this.diffTex, gl.RGBA8]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    for (const rb of [this.visDepth, this.resolveDepth, this.forwardDepth]) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    }
  }
}
