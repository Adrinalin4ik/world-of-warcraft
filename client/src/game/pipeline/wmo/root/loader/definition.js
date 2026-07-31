class WMORootDefinition {

  constructor(path, data) {
    this.path = path;
    this.rootID = data.MOHD.rootID;
    this.header = {
      flags: data.MOHD.flags,
      ambientColor: data.MOHD.ambientColor
    };

    this.groupInfo = data.MOGI.groups;
    console.log('Definition', data)
    this.materials = data.MOMT.materials;
    this.texturePaths = data.MOTX.filenames;

    this.doodadSets = data.MODS.sets;
    this.doodadEntries = data.MODD.doodads;

    this.summarizeGroups(data);

    this.createPortals(data);
    this.createLights(data);
    this.createFogs(data);
    this.createBoundingBox(data.MOHD);
  }

  /**
   * MFOG records, staged into the shape `fog.ts`'s `stageMfog`/`WmoFogRamp` consume
   * (`{ color: [r,g,b] 0..1, end, startScalar }`).
   *
   * Each MFOG record packs TWO fog blocks -- index 0 is FOG, index 1 is UWFOG (underwater).
   * This client has no submersion state, so underwater fog is out of scope; only block 0 is
   * read. Kept positionally aligned with MFOG (one entry per record, none skipped) since a
   * group's MOGP.fogOffsets indexes this array directly -- see WMOGroupDefinition.fogOffsets.
   * Resolving those offsets against this array (including what an all-zero or out-of-range
   * index means) is the camera-in-interior fog consumer's job, not this loader's.
   *
   * `pos`/`radiusInner`/`radiusOuter`/`flags` are carried through un-transformed -- WMO local
   * space, matching MOLT (see `createLights` above) -- because the selection law
   * (`samples/benilla/crates/benilla/src/wmo_portal/fog.rs::select_wmo_fog`, ported as
   * `fog.ts`'s `selectWmoFogTarget`) needs the camera position and each record's radius band to
   * pick which positioned record engages, not just the first offset that happens to resolve.
   */
  createFogs(data) {
    const fogs = this.fogs = [];

    if (!data.MFOG || !data.MFOG.fogs) {
      return;
    }

    for (const record of data.MFOG.fogs) {
      const fog = record.fogs[0];

      // CImVector is {b, g, r, a} in memory, so as a little-endian uint32 red lands at >> 16.
      // Same unpacking createLights uses above for MOLT colour.
      const r = (fog.color >> 16) & 0xff;
      const g = (fog.color >> 8) & 0xff;
      const b = fog.color & 0xff;

      fogs.push({
        color: [r / 255, g / 255, b / 255],
        end: fog.end,
        startScalar: fog.start_scalar,
        pos: { x: record.pos.x, y: record.pos.y, z: record.pos.z },
        radiusInner: record.smaller_radius,
        radiusOuter: record.larger_radius,
        flags: record.flag_infinite_radius
      });
    }
  }

  /**
   * MOLT point lights, converted once into the shape the renderer wants.
   *
   * Kept in WMO local space -- the handler transforms them to world space when the root view exists,
   * since only then is the placement known. Types other than omni are skipped: spot and directional
   * lights need cone/orientation handling the shaders do not have, and ambient lights are already
   * covered by the group's baked vertex colours.
   */
  createLights(data) {
    const lights = this.lights = [];

    if (!data.MOLT || !data.MOLT.lights) {
      return;
    }

    // A WMO group's MOLR chunk references lights by their raw index into THIS MOLT array. To keep
    // those refs valid, `lights` stays positionally aligned with MOLT -- a light this loop skips
    // pushes `null` rather than being omitted, leaving a hole instead of shifting every index after
    // it. Consumers (wmo-lights.ts, MapLight) skip the holes themselves.
    for (const light of data.MOLT.lights) {
      // Omni only (type 0).
      if (light.type !== 0) {
        lights.push(null);
        continue;
      }

      // CImVector is {b, g, r, a} in memory, so as a little-endian uint32 red lands at >> 16.
      // Same unpacking MapLight uses for the light band colours.
      const r = (light.color >> 16) & 0xff;
      const g = (light.color >> 8) & 0xff;
      const b = light.color & 0xff;

      // A zero attenuation end would light the entire model uniformly, so treat it as disabled.
      if (!(light.attenEnd > 0)) {
        lights.push(null);
        continue;
      }

      lights.push({
        position: { x: light.position.x, y: light.position.y, z: light.position.z },
        color: { r: r / 255, g: g / 255, b: b / 255 },
        intensity: light.intensity,
        attenStart: light.attenStart,
        attenEnd: light.attenEnd
      });
    }
  }

  createBoundingBox(mohd) {
    this.boundingBox = {};
    this.boundingBox.min = mohd.minBoundingBox;
    this.boundingBox.max = mohd.maxBoundingBox;
  }

  createPortals(data) {
    const portalCount = data.MOPT.portals.length;
    const portalVertexCount = data.MOPV.vertices.length;

    this.portalRefs = data.MOPR.references;

    const portals = this.portals = [];
    this.assignPortals(portalCount, data.MOPT, portals);

    const portalNormals = this.portalNormals = new Float32Array(3 * portalCount);
    this.assignPortalNormals(portalCount, data.MOPT, portalNormals);

    const portalConstants = this.portalConstants = new Float32Array(1 * portalCount);
    this.assignPortalConstants(portalCount, data.MOPT, portalConstants);

    const portalVertices = this.portalVertices = new Float32Array(3 * portalVertexCount);
    this.assignPortalVertices(portalVertexCount, data.MOPV, portalVertices);
  }

  assignPortals(portalCount, mopt, attribute) {
    for (let index = 0; index < portalCount; ++index) {
      const portal = mopt.portals[index];

      attribute.push({
        vertexOffset: portal.vertexOffset,
        vertexCount: portal.vertexCount
      });
    }
  }

  assignPortalNormals(portalCount, mopt, attribute) {
    for (let index = 0; index < portalCount; ++index) {
      const portal = mopt.portals[index];
      const normal = portal.plane.normal;

      attribute.set([normal[0], normal[1], normal[2]], index * 3);
    }
  }

  assignPortalConstants(portalCount, mopt, attribute) {
    for (let index = 0; index < portalCount; ++index) {
      const portal = mopt.portals[index];
      const constant = portal.plane.constant;

      attribute.set([constant], index);
    }
  }

  assignPortalVertices(vertexCount, mopv, attribute) {
    for (let index = 0; index < vertexCount; ++index) {
      const vertex = mopv.vertices[index];

      attribute.set([vertex[0], vertex[1], vertex[2]], index * 3);
    }
  }

  summarizeGroups(data) {
    this.groupCount = data.MOGI.groups.length;
    this.interiorGroupCount = 0;
    this.exteriorGroupCount = 0;

    this.interiorGroupIndices = [];
    this.exteriorGroupIndices = [];

    // Separate group indices by interior/exterior flag. This allows us to queue exterior groups to
    // load before interior groups.
    for (let index = 0; index < this.groupCount; ++index) {
      const group = data.MOGI.groups[index];
      
      if (group.interior) {
        this.interiorGroupIndices.push(index);
        this.interiorGroupCount++;
      } else {
        this.exteriorGroupIndices.push(index);
        this.exteriorGroupCount++;
      }
    }
  }

  // Returns an array of references to typed arrays that we'd like to transfer across worker
  // boundaries.
  get transferable() {
    const list = [];

    list.push(this.portalNormals.buffer);
    list.push(this.portalConstants.buffer);
    list.push(this.portalVertices.buffer);

    return list;
  }

}

export default WMORootDefinition;
