// The fallback for a batch whose shader names could not be resolved at all: draw nothing.
//
// `gl_FragColor` is assigned even though `discard` follows it and no fragment ever survives. A
// GLSL ES 1.00 shader that writes no output at all fails draw-time validation --
// `GL_INVALID_OPERATION: glDrawArrays: Active draw buffers with missing fragment shader outputs`,
// once per draw call, which floods the context until the browser stops reporting -- because the
// driver checks the shader's static outputs, not whether any fragment reached them. The assignment
// costs nothing and has no visual effect; removing it brings the flood back.
void main() {
  gl_FragColor = vec4(0.0);
  discard;
}
