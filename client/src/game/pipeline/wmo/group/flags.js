const flags = {
  // MOGP/MOGI SHOW_SKYBOX (celestial-sky plan, Task 6 Step 2): this group draws its root's MOSB model
  // as the sky in place of the gradient dome. Tested on the groups the camera's portal flood REACHES,
  // never on the group the camera stands in -- see `pipeline/sky/skybox/wmo-resolve.ts`'s own doc
  // comment and benilla `wmo_sky.rs`'s module header for why that distinction is load-bearing.
  SHOW_SKYBOX: 0x40000
};

export default flags;
