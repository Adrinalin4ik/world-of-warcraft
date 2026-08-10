class WMOMaterialDefinition {

  constructor(index, flags, blendingMode, shaderID, textures, sidnColor) {
    this.index = index;
    this.flags = flags;
    this.blendingMode = blendingMode;
    this.shaderID = shaderID;
    this.textures = textures;
    // MOMT slot 1's colour word — the SIDN emissive. Carried separately from `textures` because
    // that list is FILTERED to slots whose path resolved, so its index 0 is not reliably slot 0.
    this.sidnColor = sidnColor;

    // Comes from reference
    this.batchType = null;
    this.interior = null;
    // The reference's LIGHTING class (MOGI/MOGP flags & 0x48), distinct from `interior` above,
    // which is the portal-culling/camera-containment question. Must be in `key` or two groups that
    // share `interior` but differ here silently collide on one cached WMOMaterial instance.
    this.lightingInterior = null;
  }

  forRef(ref) {
    const clone = this.clone();

    clone.batchType = ref.batchType;
    clone.interior = ref.interior;
    clone.lightingInterior = ref.lightingInterior;

    return clone;
  }

  get key() {
    const key = [];

    key.push(this.index);

    if (this.batchType !== null) {
      key.push(this.batchType);
    }

    if (this.interior !== null) {
      key.push(this.interior ? 'i' : 'e');
    }

    if (this.lightingInterior !== null) {
      key.push(this.lightingInterior ? 'l' : 'x');
    }

    return key.join(';');
  }

  clone() {
    const { index, flags, blendingMode, shaderID, textures, sidnColor } = this;
    return new WMOMaterialDefinition(index, flags, blendingMode, shaderID, textures, sidnColor);
  }

}

export default WMOMaterialDefinition;
