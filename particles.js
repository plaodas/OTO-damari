import { getUniforms } from "./gl.js";

const STATE_STRIDE = 4;
const STATIC_STRIDE = 6;

export class ParticleField {
  constructor(gl, programs, noiseTexture, quality) {
    this.gl = gl;
    this.programs = programs;
    this.noiseTexture = noiseTexture;
    this.count = quality.particleCount;
    this.trailCount = Math.min(360, this.count);
    this.field = null;
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.read = 0;
    this.glowPulse = 0;
    this.glowFade = 0;
    this.sizePulse = 0;
    this.waterSheen = 0;
    this.flowBoost = 0;
    this.flowSpeed = 5;
    this.trailFade = 0;
    this.bloomAge = 0;
    this.disperse = 0;
    this.didBurst = false;
    this.burst = 0;
    this.swipeActive = false;
    this.swipeHeld = false;
    this.originX = 0.5;
    this.originY = 0.9;
    this.axisX = 0;
    this.axisY = -1;
    this.perpX = 1;
    this.perpY = 0;
    this.bloomLength = 0.4;
    this.lastSwipeX = 0.5;
    this.lastSwipeY = 0.5;
    this.tiltX = 0;
    this.tiltY = 0;
    this.north = 0;
    this.shakeForce = 0;
    this.photoAmount = 0;
    this.photoTarget = 0;
    this.photoGatheredSeconds = 0;

    this.updateUniforms = getUniforms(gl, programs.update, [
      "u_velocity",
      "u_hasField",
      "u_photoField",
      "u_photoAmount",
      "u_dt",
      "u_time",
      "u_gather",
      "u_disperse",
      "u_blooming",
      "u_flowSpeed",
      "u_burst",
      "u_origin",
      "u_axis",
      "u_perp",
      "u_bloomLength",
      "u_swipeHeld",
      "u_impactPoint",
      "u_impact",
      "u_tilt",
      "u_shake",
      "u_blowLevel",
      "u_north",
    ]);
    this.drawUniforms = getUniforms(gl, programs.particle, [
      "u_resolution",
      "u_pixelRatio",
      "u_waterSheen",
      "u_sizePulse",
      "u_blowEnergy",
      "u_blooming",
      "u_glowPulse",
      "u_glowFade",
      "u_blowLevel",
      "u_north",
      "u_noise",
      "u_maxPointSize",
    ]);
    this.maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
    this.useQuads = this.maxPointSize < 16 && Boolean(programs.particleQuad);
    this.quadUniforms = this.useQuads
      ? getUniforms(gl, programs.particleQuad, [
          "u_resolution",
          "u_pixelRatio",
          "u_waterSheen",
          "u_sizePulse",
          "u_blowEnergy",
          "u_blooming",
          "u_glowPulse",
          "u_glowFade",
          "u_blowLevel",
          "u_north",
          "u_noise",
        ])
      : null;
    this.dummyVelocity = this.createDummyVelocity();
    this.photoTexture = this.createPhotoTexture();
    this.trailUniforms = getUniforms(gl, programs.trail, ["u_resolution", "u_trailFade", "u_north"]);
    this.impactX = 0.5;
    this.impactY = 0.5;
    this.impactForce = 0;

    this.stateBuffers = [gl.createBuffer(), gl.createBuffer()];
    this.staticBuffer = gl.createBuffer();
    this.transformFeedback = gl.createTransformFeedback();
    this.updateVaos = [gl.createVertexArray(), gl.createVertexArray()];
    this.drawVaos = [gl.createVertexArray(), gl.createVertexArray()];
    this.quadVaos = this.useQuads ? [gl.createVertexArray(), gl.createVertexArray()] : null;
    this.trailVaos = [gl.createVertexArray(), gl.createVertexArray()];

    this.seedBuffers();
  }

  createDummyVelocity() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return texture;
  }

  createPhotoTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 0, 0]),
    );
    return texture;
  }

  seedBuffers() {
    const gl = this.gl;
    const state = new Float32Array(this.count * STATE_STRIDE);
    const extra = new Float32Array(this.count * STATIC_STRIDE);
    for (let i = 0; i < this.count; i += 1) {
      const s = i * STATE_STRIDE;
      state[s] = Math.random();
      state[s + 1] = Math.random();
      state[s + 2] = (Math.random() - 0.5) * 0.018;
      state[s + 3] = (Math.random() - 0.5) * 0.018;
      const e = i * STATIC_STRIDE;
      extra[e] = 3 + Math.random() * 9;
      extra[e + 1] = 0.35 + Math.random() * 0.65;
      extra[e + 2] = Math.random() * 2 - 1;
      extra[e + 3] = Math.random() * Math.PI * 2;
      extra[e + 4] = Math.random();
      extra[e + 5] = Math.random();
    }

    for (const buffer of this.stateBuffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, state, gl.DYNAMIC_COPY);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, extra, gl.STATIC_DRAW);

    for (let i = 0; i < 2; i += 1) {
      this.bindUpdateVao(this.updateVaos[i], this.stateBuffers[i]);
      this.bindDrawVao(this.drawVaos[i], this.stateBuffers[i], this.programs.particle, false);
      if (this.useQuads) {
        this.bindDrawVao(this.quadVaos[i], this.stateBuffers[i], this.programs.particleQuad, true);
      }
      this.bindTrailVao(this.trailVaos[i], this.stateBuffers[i], this.stateBuffers[1 - i]);
    }
    gl.bindVertexArray(null);
  }

  bindUpdateVao(vao, stateBuffer) {
    const gl = this.gl;
    const program = this.programs.update;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuffer);
    const pos = gl.getAttribLocation(program, "a_position");
    const vel = gl.getAttribLocation(program, "a_velocity");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(vel);
    gl.vertexAttribPointer(vel, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBuffer);
    const lane = gl.getAttribLocation(program, "a_lane");
    const phase = gl.getAttribLocation(program, "a_phase");
    const home = gl.getAttribLocation(program, "a_home");
    gl.enableVertexAttribArray(lane);
    gl.vertexAttribPointer(lane, 1, gl.FLOAT, false, 24, 8);
    gl.enableVertexAttribArray(phase);
    gl.vertexAttribPointer(phase, 1, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(home);
    gl.vertexAttribPointer(home, 2, gl.FLOAT, false, 24, 16);
  }

  bindDrawVao(vao, stateBuffer, program, instanced) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuffer);
    const pos = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    if (instanced) gl.vertexAttribDivisor(pos, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBuffer);
    const size = gl.getAttribLocation(program, "a_size");
    const brightness = gl.getAttribLocation(program, "a_brightness");
    gl.enableVertexAttribArray(size);
    gl.vertexAttribPointer(size, 1, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(brightness);
    gl.vertexAttribPointer(brightness, 1, gl.FLOAT, false, 24, 4);
    if (instanced) {
      gl.vertexAttribDivisor(size, 1);
      gl.vertexAttribDivisor(brightness, 1);
    }
  }

  bindTrailVao(vao, current, previous) {
    const gl = this.gl;
    const program = this.programs.trail;
    gl.bindVertexArray(vao);
    const cur = gl.getAttribLocation(program, "a_current");
    const prev = gl.getAttribLocation(program, "a_previous");
    gl.bindBuffer(gl.ARRAY_BUFFER, current);
    gl.enableVertexAttribArray(cur);
    gl.vertexAttribPointer(cur, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(cur, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, previous);
    gl.enableVertexAttribArray(prev);
    gl.vertexAttribPointer(prev, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(prev, 1);
  }

  resize(width, height, pixelRatio) {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
  }

  pulse(kind) {
    if (kind === "weak") {
      this.glowPulse = 1;
      this.sizePulse = 0.85;
    } else if (kind === "medium") {
      this.glowPulse = 0.72;
      this.waterSheen = 1;
      this.flowBoost = 1;
    } else if (kind === "strong") {
      this.glowPulse = 1;
      this.flowBoost = 1.35;
      this.trailFade = 1;
      this.bloomAge = 0;
      this.disperse = 0;
      this.didBurst = false;
    }
  }

  setAxis(dx, dy) {
    const length = Math.hypot(dx, dy);
    if (length < 1e-5) {
      this.axisX = 0;
      this.axisY = -1;
    } else {
      this.axisX = dx / length;
      this.axisY = dy / length;
    }
    this.perpX = -this.axisY;
    this.perpY = this.axisX;
  }

  lengthToEdge() {
    const { originX: ox, originY: oy, axisX: ax, axisY: ay } = this;
    let t = 1.35;
    if (ax > 1e-4) t = Math.min(t, (1.08 - ox) / ax);
    else if (ax < -1e-4) t = Math.min(t, (-0.08 - ox) / ax);
    if (ay > 1e-4) t = Math.min(t, (1.08 - oy) / ay);
    else if (ay < -1e-4) t = Math.min(t, (-0.08 - oy) / ay);
    return Math.max(0.45, t);
  }

  setBlowOrigin() {
    if (this.swipeHeld) return;
    this.originX = 0.5;
    this.originY = 0.9;
    this.setAxis(0, -1);
    this.bloomLength = this.lengthToEdge();
  }

  beginSwipe(x, y, toX, toY) {
    this.swipeActive = true;
    this.swipeHeld = true;
    this.originX = x / this.width;
    this.originY = y / this.height;
    this.lastSwipeX = toX / this.width;
    this.lastSwipeY = toY / this.height;
    this.setAxis(toX - x, toY - y);
    this.bloomLength = this.lengthToEdge();
    this.glowPulse = Math.max(this.glowPulse, 0.55);
    this.flowBoost = Math.max(this.flowBoost, 0.68);
    this.trailFade = Math.max(this.trailFade, 0.5);
    this.bloomAge = 0;
    this.disperse = 0;
    this.didBurst = false;
    if (this.field?.enabled) {
      this.field.splat(this.originX, this.originY, this.axisX * 0.04, this.axisY * 0.04, 0.012);
      this.field.splat(this.lastSwipeX, this.lastSwipeY, this.axisX * 0.03, this.axisY * 0.03, 0.01);
    }
  }

  steerSwipe(x, y) {
    const nx = x / this.width;
    const ny = y / this.height;
    this.setAxis(nx - this.originX, ny - this.originY);
    this.bloomLength = this.lengthToEdge();
    if (this.field?.enabled) {
      const fx = (nx - this.lastSwipeX) * 0.45;
      const fy = (ny - this.lastSwipeY) * 0.45;
      this.field.splat(nx, ny, fx, fy, 0.01);
    }
    this.lastSwipeX = nx;
    this.lastSwipeY = ny;
  }

  releaseSwipe() {
    this.swipeHeld = false;
  }

  impact(x, y) {
    this.impactX = x / this.width;
    this.impactY = y / this.height;
    this.impactForce = 1;
    if (this.field?.enabled) {
      this.field.splat(this.impactX, this.impactY, 0, -0.035, 0.02);
    }
  }

  setTilt(x, y, north = 0) {
    this.tiltX = x;
    this.tiltY = y;
    this.north = north;
  }

  setPhotoField({ width, height, pixels }) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    this.photoAmount = 0;
    this.photoTarget = 1;
    this.photoGatheredSeconds = 0;
    this.glowPulse = Math.max(this.glowPulse, 0.7);
    this.sizePulse = Math.max(this.sizePulse, 0.35);
  }

  clearPhotoField() {
    this.photoTarget = 0;
    this.photoGatheredSeconds = 0;
  }

  shake(amount) {
    const force = Math.max(0, Math.min(1.4, amount));
    this.shakeForce = Math.max(this.shakeForce, force);
    this.glowPulse = Math.max(this.glowPulse, 0.45 + force * 0.35);
    this.flowBoost = Math.max(this.flowBoost, 0.55 + force * 0.4);
    this.trailFade = Math.max(this.trailFade, 0.28 + force * 0.32);
    if (!this.field?.enabled) return;
    const mag = 0.05 + force * 0.08;
    const radius = 0.05;
    const centers = [0.22, 0.5, 0.78];
    for (let i = 0; i < centers.length; i += 1) {
      this.field.addVortex(0.5, centers[i], mag, radius, 0.2, 0.095);
    }
    const rise = 0.045 + force * 0.07;
    for (let y = 0.86; y >= 0.14; y -= 0.12) {
      const fromBottom = (y - 0.14) / 0.72;
      this.field.splat(0.5, y, 0, -rise * (0.4 + fromBottom * 0.8), 0.018);
    }
    this.field.splat(0.26, 0.45, 0, rise * 0.4, 0.022);
    this.field.splat(0.74, 0.45, 0, rise * 0.4, 0.022);
  }

  update(deltaSeconds, elapsedSeconds, blowEnergy, blowLevel) {
    const gl = this.gl;
    const frames = deltaSeconds * 60;
    this.glowPulse *= Math.pow(0.92, frames);
    const bloomingNow = blowLevel === 3 || this.swipeActive;
    const emitTarget = Math.max(this.glowPulse, bloomingNow ? 1 : 0, blowLevel >= 2 ? 0.4 : 0);
    this.glowFade = Math.max(emitTarget, this.glowFade * Math.pow(0.96, frames));
    this.sizePulse *= Math.pow(0.94, frames);
    this.waterSheen *= Math.pow(0.96, frames);
    this.flowBoost *= Math.pow(0.97, frames);
    this.impactForce *= Math.pow(0.82, frames);
    this.shakeForce *= Math.pow(0.94, frames);
    const photoRate = this.photoTarget > this.photoAmount ? 0.18 : 0.42;
    const photoStep = photoRate * deltaSeconds;
    this.photoAmount += Math.max(-photoStep, Math.min(photoStep, this.photoTarget - this.photoAmount));
    if (this.photoTarget > 0.5 && this.photoAmount >= 0.995) {
      this.photoGatheredSeconds += deltaSeconds;
      if (this.photoGatheredSeconds >= 5) this.clearPhotoField();
    }
    this.blowEnergy = blowEnergy;
    this.blowLevel = blowLevel;

    const blooming = blowLevel === 3 || this.swipeActive;
    const swipeOnly = this.swipeActive && blowLevel !== 3;
    const flowLevel = blooming ? 3 : blowLevel;
    const flowScale = swipeOnly ? 0.5 : 1;
    const flowTarget = ([5, 11, 52, 132][flowLevel] + this.flowBoost * 36) * flowScale;
    this.flowSpeed += (flowTarget - this.flowSpeed) * Math.min(1, 0.08 * frames);
    this.trailFade = blooming
      ? Math.min(swipeOnly ? 0.21 : 0.42, this.trailFade + deltaSeconds * (swipeOnly ? 1.2 : 2.4))
      : this.trailFade * Math.pow(0.9, frames);

    if (blowLevel === 3) this.setBlowOrigin();

    if (blooming) {
      this.bloomAge += deltaSeconds;
      if (this.swipeHeld) {
        this.bloomAge = Math.min(this.bloomAge, 0.5);
        this.disperse = 0;
        this.didBurst = false;
      } else {
        const disperseTarget = this.bloomAge < 0.7 ? 0 : Math.min(1, (this.bloomAge - 0.7) / 0.8);
        this.disperse += (disperseTarget - this.disperse) * Math.min(1, 0.14 * frames);
      }
    } else {
      this.bloomAge = 0;
      this.disperse *= Math.pow(0.92, frames);
    }

    const gather = blooming ? 1 - this.disperse : 0;
    this.burst = 0;
    if (blooming && this.disperse > 0.2 && !this.didBurst) {
      this.didBurst = true;
      this.burst = swipeOnly ? 0.04 : 0.08;
    }

    const flowUv = this.flowSpeed / Math.max(this.height, 1);

    if (this.field?.enabled) {
      if (blowLevel > 0) {
        const strength = [0, 0.03, 0.055, 0.09][blowLevel];
        const radius = [0, 0.008, 0.012, 0.018][blowLevel];
        this.field.splat(this.originX, this.originY, this.axisX * strength, this.axisY * strength, radius);
      }
      this.field.addFunnel({
        originX: this.originX,
        originY: this.originY,
        axisX: this.axisX,
        axisY: this.axisY,
        perpX: this.perpX,
        perpY: this.perpY,
        bloomLength: this.bloomLength,
        gather,
        flow: flowUv,
        dt: deltaSeconds,
      });
      this.field.step(deltaSeconds, blowLevel === 0 && !blooming ? 0.968 : 0.985);
    }

    const write = 1 - this.read;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(this.updateVaos[this.read]);
    gl.useProgram(this.programs.update);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.field?.texture || this.dummyVelocity);
    gl.uniform1i(this.updateUniforms.u_velocity, 0);
    gl.uniform1f(this.updateUniforms.u_hasField, this.field?.enabled ? 1 : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTexture);
    gl.uniform1i(this.updateUniforms.u_photoField, 1);
    gl.uniform1f(this.updateUniforms.u_photoAmount, this.photoAmount);
    gl.uniform1f(this.updateUniforms.u_dt, deltaSeconds);
    gl.uniform1f(this.updateUniforms.u_time, elapsedSeconds);
    gl.uniform1f(this.updateUniforms.u_gather, gather);
    gl.uniform1f(this.updateUniforms.u_disperse, this.disperse);
    gl.uniform1f(this.updateUniforms.u_blooming, blooming ? 1 : 0);
    gl.uniform1f(this.updateUniforms.u_flowSpeed, flowUv);
    gl.uniform1f(this.updateUniforms.u_burst, this.burst);
    gl.uniform2f(this.updateUniforms.u_origin, this.originX, this.originY);
    gl.uniform2f(this.updateUniforms.u_axis, this.axisX, this.axisY);
    gl.uniform2f(this.updateUniforms.u_perp, this.perpX, this.perpY);
    gl.uniform1f(this.updateUniforms.u_bloomLength, this.bloomLength);
    gl.uniform1f(this.updateUniforms.u_swipeHeld, this.swipeHeld ? 1 : 0);
    gl.uniform2f(this.updateUniforms.u_impactPoint, this.impactX, this.impactY);
    gl.uniform1f(this.updateUniforms.u_impact, this.impactForce);
    gl.uniform2f(this.updateUniforms.u_tilt, this.tiltX, this.tiltY);
    gl.uniform1f(this.updateUniforms.u_shake, this.shakeForce);
    gl.uniform1f(this.updateUniforms.u_blowLevel, this.blowLevel || 0);
    gl.uniform1f(this.updateUniforms.u_north, this.north || 0);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.transformFeedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.stateBuffers[write]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    this.read = write;

    if (this.swipeActive && !this.swipeHeld && this.disperse > 0.92) {
      this.swipeActive = false;
    }
  }

  draw() {
    const gl = this.gl;
    const blooming = this.blowLevel === 3 || this.swipeActive ? 1 : 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTexture);
    if (this.useQuads) {
      gl.bindVertexArray(this.quadVaos[this.read]);
      gl.useProgram(this.programs.particleQuad);
      gl.uniform1i(this.quadUniforms.u_noise, 0);
      gl.uniform2f(this.quadUniforms.u_resolution, this.width, this.height);
      gl.uniform1f(this.quadUniforms.u_pixelRatio, this.pixelRatio);
      gl.uniform1f(this.quadUniforms.u_waterSheen, this.waterSheen);
      gl.uniform1f(this.quadUniforms.u_sizePulse, this.sizePulse);
      gl.uniform1f(this.quadUniforms.u_blowEnergy, this.blowEnergy || 0);
      gl.uniform1f(this.quadUniforms.u_blooming, blooming);
      gl.uniform1f(this.quadUniforms.u_glowPulse, this.glowPulse);
      gl.uniform1f(this.quadUniforms.u_glowFade, this.glowFade);
      gl.uniform1f(this.quadUniforms.u_blowLevel, this.blowLevel || 0);
      gl.uniform1f(this.quadUniforms.u_north, this.north || 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    } else {
      gl.bindVertexArray(this.drawVaos[this.read]);
      gl.useProgram(this.programs.particle);
      gl.uniform1i(this.drawUniforms.u_noise, 0);
      gl.uniform2f(this.drawUniforms.u_resolution, this.width, this.height);
      gl.uniform1f(this.drawUniforms.u_pixelRatio, this.pixelRatio);
      gl.uniform1f(this.drawUniforms.u_waterSheen, this.waterSheen);
      gl.uniform1f(this.drawUniforms.u_sizePulse, this.sizePulse);
      gl.uniform1f(this.drawUniforms.u_blowEnergy, this.blowEnergy || 0);
      gl.uniform1f(this.drawUniforms.u_blooming, blooming);
      gl.uniform1f(this.drawUniforms.u_glowPulse, this.glowPulse);
      gl.uniform1f(this.drawUniforms.u_glowFade, this.glowFade);
      gl.uniform1f(this.drawUniforms.u_blowLevel, this.blowLevel || 0);
      gl.uniform1f(this.drawUniforms.u_north, this.north || 0);
      gl.uniform1f(this.drawUniforms.u_maxPointSize, this.maxPointSize);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }

    if (this.trailFade > 0.04) {
      gl.bindVertexArray(this.trailVaos[this.read]);
      gl.useProgram(this.programs.trail);
      gl.uniform2f(this.trailUniforms.u_resolution, this.width, this.height);
      gl.uniform1f(this.trailUniforms.u_trailFade, this.trailFade);
      gl.uniform1f(this.trailUniforms.u_north, this.north || 0);
      gl.drawArraysInstanced(gl.LINES, 0, 2, this.trailCount);
    }

    gl.bindVertexArray(null);
  }
}
