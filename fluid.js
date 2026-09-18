import { createFloatTarget, getUniforms } from "./gl.js";

export class VelocityField {
  constructor(gl, programs, quality) {
    this.gl = gl;
    this.programs = programs;
    this.quality = quality;
    this.enabled = false;
    this.width = 128;
    this.height = 128;
    this.jacobiIterations = quality.jacobiIterations;
    this.velocity = [null, null];
    this.pressure = [null, null];
    this.divergence = null;
    this.read = 0;
    this.pressureRead = 0;
    this.aspect = 1;
    this.quadVao = gl.createVertexArray();

    this.uniforms = {
      splat: getUniforms(gl, programs.splat, [
        "u_velocity",
        "u_point",
        "u_force",
        "u_radius",
        "u_aspect",
      ]),
      advect: getUniforms(gl, programs.advect, ["u_velocity", "u_dt", "u_dissipation"]),
      divergence: getUniforms(gl, programs.divergence, ["u_velocity", "u_texel"]),
      jacobi: getUniforms(gl, programs.jacobi, ["u_pressure", "u_divergence", "u_texel"]),
      subtract: getUniforms(gl, programs.subtract, ["u_velocity", "u_pressure", "u_texel"]),
      funnel: getUniforms(gl, programs.funnel, [
        "u_velocity",
        "u_origin",
        "u_axis",
        "u_perp",
        "u_bloomLength",
        "u_gather",
        "u_flow",
        "u_dt",
      ]),
    };
  }

  get texture() {
    return this.enabled ? this.velocity[this.read].texture : null;
  }

  resize(pixelWidth, pixelHeight) {
    const gl = this.gl;
    const short = Math.max(1, Math.min(pixelWidth, pixelHeight));
    const size = Math.max(
      this.quality.simMin,
      Math.min(this.quality.simMax, Math.round(short * 0.18)),
    );
    const aspect = pixelWidth / Math.max(1, pixelHeight);
    this.aspect = aspect;
    let width = size;
    let height = size;
    if (aspect > 1) width = Math.round(size * aspect);
    else height = Math.round(size / Math.max(aspect, 0.01));
    width = Math.max(64, width);
    height = Math.max(64, height);
    if (this.velocity[0] && this.width === width && this.height === height) return;

    this.disposeTargets();
    this.width = width;
    this.height = height;
    this.velocity = [createFloatTarget(gl, width, height), createFloatTarget(gl, width, height)];
    this.pressure = [createFloatTarget(gl, width, height), createFloatTarget(gl, width, height)];
    this.divergence = createFloatTarget(gl, width, height);
    this.enabled = Boolean(
      this.velocity[0] && this.velocity[1] && this.pressure[0] && this.pressure[1] && this.divergence,
    );
    this.read = 0;
    this.pressureRead = 0;
    if (this.enabled) this.clear();
  }

  disposeTargets() {
    const gl = this.gl;
    for (const target of [...this.velocity, ...this.pressure, this.divergence]) {
      if (!target) continue;
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    this.velocity = [null, null];
    this.pressure = [null, null];
    this.divergence = null;
    this.enabled = false;
  }

  clear() {
    const gl = this.gl;
    for (const target of [...this.velocity, ...this.pressure, this.divergence]) {
      if (!target) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  blit(program, target, bindTextures) {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.useProgram(program);
    bindTextures?.();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  splat(x, y, fx, fy, radius) {
    if (!this.enabled) return;
    const write = 1 - this.read;
    this.blit(this.programs.splat, this.velocity[write], () => {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity[this.read].texture);
      gl.uniform1i(this.uniforms.splat.u_velocity, 0);
      gl.uniform2f(this.uniforms.splat.u_point, x, 1 - y);
      gl.uniform2f(this.uniforms.splat.u_force, fx, -fy);
      gl.uniform1f(this.uniforms.splat.u_radius, Math.max(0.0002, radius));
      gl.uniform1f(this.uniforms.splat.u_aspect, this.aspect);
    });
    this.read = write;
  }

  addFunnel(params) {
    if (!this.enabled || params.gather < 0.02) return;
    const write = 1 - this.read;
    this.blit(this.programs.funnel, this.velocity[write], () => {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity[this.read].texture);
      gl.uniform1i(this.uniforms.funnel.u_velocity, 0);
      gl.uniform2f(this.uniforms.funnel.u_origin, params.originX, 1 - params.originY);
      gl.uniform2f(this.uniforms.funnel.u_axis, params.axisX, -params.axisY);
      gl.uniform2f(this.uniforms.funnel.u_perp, params.perpX, -params.perpY);
      gl.uniform1f(this.uniforms.funnel.u_bloomLength, params.bloomLength);
      gl.uniform1f(this.uniforms.funnel.u_gather, params.gather);
      gl.uniform1f(this.uniforms.funnel.u_flow, params.flow);
      gl.uniform1f(this.uniforms.funnel.u_dt, params.dt);
    });
    this.read = write;
  }

  step(dt) {
    if (!this.enabled) return;
    const gl = this.gl;
    const texel = [1 / this.width, 1 / this.height];
    const write = 1 - this.read;

    this.blit(this.programs.advect, this.velocity[write], () => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity[this.read].texture);
      gl.uniform1i(this.uniforms.advect.u_velocity, 0);
      gl.uniform1f(this.uniforms.advect.u_dt, dt);
      gl.uniform1f(this.uniforms.advect.u_dissipation, 0.985);
    });
    this.read = write;

    this.blit(this.programs.divergence, this.divergence, () => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity[this.read].texture);
      gl.uniform1i(this.uniforms.divergence.u_velocity, 0);
      gl.uniform2f(this.uniforms.divergence.u_texel, texel[0], texel[1]);
    });

    this.pressureRead = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pressure[0].framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (let i = 0; i < this.jacobiIterations; i += 1) {
      const pWrite = 1 - this.pressureRead;
      this.blit(this.programs.jacobi, this.pressure[pWrite], () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pressure[this.pressureRead].texture);
        gl.uniform1i(this.uniforms.jacobi.u_pressure, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.divergence.texture);
        gl.uniform1i(this.uniforms.jacobi.u_divergence, 1);
        gl.uniform2f(this.uniforms.jacobi.u_texel, texel[0], texel[1]);
      });
      this.pressureRead = pWrite;
    }

    const velWrite = 1 - this.read;
    this.blit(this.programs.subtract, this.velocity[velWrite], () => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.velocity[this.read].texture);
      gl.uniform1i(this.uniforms.subtract.u_velocity, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.pressure[this.pressureRead].texture);
      gl.uniform1i(this.uniforms.subtract.u_pressure, 1);
      gl.uniform2f(this.uniforms.subtract.u_texel, texel[0], texel[1]);
    });
    this.read = velWrite;
  }
}
