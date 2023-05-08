import * as THREE from 'three';

import DBC from '../../pipeline/dbc';
import Default from './default';
import Tables from './tables';

/*

  -- Time of Day Chart --

  HH:mm - hh:mm   - hmin - progress

  00:00 - 12:00am -    0 - 0.0
  03:00 -  3:00am -  360 - 0.125
  06:00 -  6:00am -  720 - 0.25
  09:00 -  9:00am - 1080 - 0.375
  12:00 - 12:00pm - 1440 - 0.5
  15:00 -  3:00pm - 1800 - 0.625
  18:00 -  6:00pm - 2160 - 0.75
  21:00 -  9:00pm - 2520 - 0.875
  24:00 - 12:00am - 2880 - 1.0

*/

class WorldLight {

  static tables = Tables;

  static overrideTime = null;

  static dayNightProgression = 0.0;

  static sunDirection = {
    phi: 0.0,
    theta: 0.0,
    vector: {
      raw: new THREE.Vector3(),
      transformed: new THREE.Vector3()
    }
  };

  static selfIlluminatedScalar = 0.0;

  static active = {
    sources: [],
    blend: null
  };

  static next = {
    sources: [],
    blend: null
  };

  static currentMapDbc = {
    mapId: null,
    records: [],
    defaultValue: null,
  }

  static scene = null;

  static uniforms = {
    // [dir.x, dir.y, dir.z, unused]
    sunParams:          new THREE.Uniform(new Float32Array(Default.sunParams)),

    // [r, g, b, a]
    sunAmbientColor:    new THREE.Uniform(new Float32Array(Default.sunAmbientColor)),

    // [r, g, b, a]
    sunDiffuseColor:    new THREE.Uniform(new Float32Array(Default.sunDiffuseColor)),

    // [start, end, unused, unused]
    fogParams:          new THREE.Uniform(new Float32Array(Default.fogParams)),

    // [r, g, b, a]
    fogColor:           new THREE.Uniform(new Float32Array(Default.fogColor))
  };

  static savedParams = {
    sunAmbientColor: null,
    sunDiffuseColor: null,
  }

  static update(camera, mapID, time = null) {
    // console.log(camera, mapID, time)
    const { x, y, z } = window['player'].position;

    let queryTime;

    if (this.overrideTime !== null) {
      queryTime = this.overrideTime;
    } else if (time !== null) {
      queryTime = time;
    } else {
      queryTime = this.currentLightTime();
    }

    this.dayNightProgression = queryTime / 2880.0;
    
    this.updateSunDirection(camera);
    this.updateSelfIlluminatedScalar();
    this.query(mapID, x, y, z, queryTime).then(({records, queryPosition}) => {
      const results = records.map(record => {
        const distance = record.worldPosition.distanceTo(queryPosition) * 36.0;
            
        let factor = 1.0;

        if (distance > record.fallOffStart && distance < record.fallOffEnd) {
          factor = 1 - ((distance - record.fallOffStart) / (record.fallOffEnd - record.fallOffStart))
        }

        // else if (distance < record.fallOffStart) {
        //   factor = 1;
        // }
        
        return {
          ...record,
          factor,
          distance
        }
      })
      .filter(record => record.fallOffEnd > record.distance);

      // this.sortLights(results);
      
      // const blend = this.blendLights(results);
      
      this.updateUniforms(results);
      // console.log("Loaded", results)

      // this.active.sources = results;
      // this.active.blend = blend;
    });
  }

  static query(mapID, x, y, z, time) {
    const queryPosition = new THREE.Vector3(x, y, z);

    if (this.currentMapDbc.mapId === mapID) {
      return Promise.resolve({
        records: this.currentMapDbc.records,
        queryPosition
      })
    } else {
      this.currentMapDbc.mapId = mapID;
      return DBC.load('Light').then((dbc) => {
        return dbc.records
          .filter(x => x.mapID === mapID)
          .map(record => {
            const { position } = record;
            const worldPosition = new THREE.Vector3(
              17066.666 - (position.z / 36.0),
              17066.666 - (position.x / 36.0),
              position.y / 36.0
            );
            // if (percentageDistance > 1) {
            //   percentageDistance = 1;
            // }

            return {
              ...record,
              worldPosition,
              light: record,
              colors: [],
              floats: []
            }
          })
      }).then((results) => {
        return DBC.load('LightParams').then((dbc) => {
          for (const result of results) {
            result.params = dbc[result.light.skyFogID];
          }

          return results;
        });
      }).then((results) => {
        return DBC.load('LightIntBand').then((dbc) => {
          for (const result of results) {
            const offset = (result.light.skyFogID * 18) - 17;
            const max = offset + 18;

            for (let i = offset; i < max; ++i) {
              result.colors.push(this.colorForTime(dbc[i], time));
            }
          }

          return results;
        });
      }).then((results) => {
        return DBC.load('LightFloatBand').then((dbc) => {
          for (const result of results) {
            const offset = (result.light.skyFogID * 6) - 5;
            const max = offset + 6;

            for (let i = offset; i < max; ++i) {
              result.floats.push(this.floatForTime(dbc[i], time));
            }
          }

          return results;
        })
        // .then(records => {
        //   records.forEach(record => {
        //     if (!record.helper && this.scene) {
        //       // Start fallloff
        //       const startFalloffGeometry = new THREE.SphereGeometry( record.fallOffStart / 36 ); 
        //       const startFalloffMaterial = new THREE.MeshBasicMaterial( {color: 0x00ff00, side: THREE.DoubleSide, opacity: 0.1, transparent: true} );
        //       const startFalloffSphere = new THREE.Mesh( startFalloffGeometry, startFalloffMaterial ); 
        //       // End Falloff
        //       const endFalloffGeometry = new THREE.SphereGeometry( record.fallOffEnd / 36 ); 
        //       const endFalloffMaterial = new THREE.MeshBasicMaterial( {color: 0xff0000, side: THREE.DoubleSide, opacity: 0.1, transparent: true} );
        //       const endFalloffsSphere = new THREE.Mesh( endFalloffGeometry, endFalloffMaterial ); 
    
              
        //       record.helper = startFalloffSphere;
        //       record.helper1= endFalloffsSphere;
        //       this.scene.add( record.helper );
        //       this.scene.add( record.helper1 );
              
        //       record.helper.position.set(record.worldPosition.x, record.worldPosition.y, record.worldPosition.z);
        //       record.helper1.position.set(record.worldPosition.x, record.worldPosition.y, record.worldPosition.z);
        //     }
        //   })

        //   return records;
        // });
      }).then(records => {
        this.currentMapDbc.records = records;
        this.currentMapDbc.defaultValue = records.find((r) => 
          r.position.x === 0 && 
          r.position.y === 0 && 
          r.position.z === 0
        ) || records[0];

        return {
          records,
          queryPosition
        }
      })
    }
  }

  static updateUniforms(results) {
    if (!results.length) return;
    // const blend = this.blendLights(results);
    // const currentParams = results[1];
    // const nextParams = results[0];
    // let dist = Math.abs(1 - nextParams.percentageDistance - currentParams.percentageDistance) / 2;
    // if (dist > 1) {
    //   dist = 1;
    // }


    
    
    // const curr = this.active.blend;
    // const next = blend;

    // if (next?.distance > next?.fallOffStart) {
    //   this.next.sources = results;
    //   this.next.blend = blend;
    //   if (next.distance > next.fallOffEnd) {
    //     this.active.sources = results;
    //     this.active.blend = blend;
    //   }
    // }

    // if (!next) {
    //   this.next.sources = this.active.sources;
    //   this.next.blend = this.active.blend;
    // }
    // global.safePrint(results.map(x => x.factor))
    this.updateLightUniforms(results);
    this.updateFogUniforms(results);
    
  }

  static updateLightUniforms(results) {
    const colors = results.map(x => ({
      vector: x.colors[0],
      factor: x.factor
    }));
    // Diffuse Color
    // const currentDiffuseColor = currentParams.colors[0];
    // const nextDiffuseColor = nextParams.colors[0];
    
    // const diffuseColor = this.lerpVectors(currentDiffuseColor, nextDiffuseColor, dist);
    const diffuseColor = lerpManyVectors(colors, this.currentMapDbc.defaultValue?.colors[0] || Default.sunDiffuseColor);

    this.uniforms.sunDiffuseColor.value.set([
      diffuseColor[0] / 255.0,
      diffuseColor[1] / 255.0,
      diffuseColor[2] / 255.0,
      diffuseColor[3] / 255.0
    ], 0);

    // Ambient Color

    // const currentAmbientColor = currentParams.colors[1];
    // const nextAmbientColor = nextParams.colors[1];
    const ambientColors = results.map(x => ({
      id: x.id,
      vector: x.colors[1],
      factor: x.factor
    }));

    const ambientColor = lerpManyVectors(ambientColors, this.currentMapDbc.defaultValue?.colors[1] || Default.sunAmbientColor);

    this.uniforms.sunAmbientColor.value.set([
      ambientColor[0] / 255.0,
      ambientColor[1] / 255.0,
      ambientColor[2] / 255.0,
      ambientColor[3] / 255.0
    ], 0);
  }

  static updateFogUniforms(results) {
    // Fog Params

    const floats0 = results.map(x => ({
      value: x.floats[0],
      factor: x.factor
    }));
    
    const floats1 = results.map(x => ({
      value: x.floats[1],
      factor: x.factor
    }));

    const interpolatedFloatsParams = {
      0: lerpManyFloats(floats0, this.currentMapDbc.defaultValue?.floats[0]),
      1: lerpManyFloats(floats1, this.currentMapDbc.defaultValue?.floats[1]),
    };
    const fogEnd = Math.min(interpolatedFloatsParams[0] / 36.0, 400.0);
    const fogScalar = interpolatedFloatsParams[1];
    const fogStart = fogEnd * fogScalar;
    const fogRange = fogEnd - fogStart;

    this.uniforms.fogParams.value[0] = -(1.0 / fogRange);
    this.uniforms.fogParams.value[1] = (1.0 / fogRange) * fogEnd;
    this.uniforms.fogParams.value[2] = 1.0;
    this.uniforms.fogParams.value[3] = 0.0;

    // Fog Color
    const fogColors = results.map(x => ({
      vector: x.colors[7],
      factor: x.factor
    }));
    // const currentFogColor = currentParams.colors[7];
    // const nextFogColor = nextParams.colors[7];
    // const fogColor =  this.lerpVectors(currentFogColor, nextFogColor, dist);
    const fogColor = lerpManyVectors(fogColors, this.currentMapDbc.defaultValue?.colors[7] || Default.fogColor);
    this.uniforms.fogColor.value.set([
      fogColor[0] / 255.0,
      fogColor[1] / 255.0,
      fogColor[2] / 255.0,
      fogColor[3] / 255.0
    ], 0);
  }

  static blendLights(results) {
    return results[0];
  }

    /**
   * Update the sun direction for the given camera and the current day night progression value.
   *
   * Note that the actual client seems to transform the sun direction using the view matrix of
   * the camera.
   *
   * In Wowser, we apply lighting in model space, and thus do not make use of the transformed
   * direction vector.
   *
   */
  static updateSunDirection(camera) {
    const viewMatrix = camera.matrixWorldInverse;

    const phiTable = this.tables.directionPhiTable;
    const thetaTable = this.tables.directionThetaTable;

    const phi = this.interpolateDayNightTable(phiTable, 4, this.dayNightProgression);
    const theta = this.interpolateDayNightTable(thetaTable, 4, this.dayNightProgression);

    this.sunDirection.phi = phi;
    this.sunDirection.theta = theta;

    const vector = this.getVanillaSunDirection(phi, theta);
    const transformedVector = vector.clone().transformDirection(viewMatrix).normalize();

    this.sunDirection.vector.raw.copy(vector);
    this.sunDirection.vector.transformed.copy(transformedVector);

    // Update uniform
    this.uniforms.sunParams.value.set([
      vector.x,
      vector.y,
      vector.z,
    ], 0);
  }

  static updateSelfIlluminatedScalar() {
    const sidnTable = this.tables.sidnTable;
    const factor = this.dayNightProgression;

    this.selfIlluminatedScalar = this.interpolateDayNightTable(sidnTable, 4, factor);
  }

  static revertUniforms() {
    this.uniforms.sunParams.value.set(Default.sunParams, 0);
    this.uniforms.sunDiffuseColor.value.set(Default.sunDiffuseColor, 0);
    this.uniforms.sunAmbientColor.value.set(Default.sunAmbientColor, 0);
    this.uniforms.fogParams.value.set(Default.fogParams, 0);
    this.uniforms.fogColor.value.set(Default.fogColor, 0);
  }

  /**
   * Returns number of half minutes since midnight.
   */
  static currentLightTime() {
    const d = new Date();

    const msSinceMidnight = d.getTime() - d.setHours(0,0,0,0);

    return Math.round(msSinceMidnight / 1000.0 / 30.0);
  }

  static colorForTime(table, time) {
    return this.interpolateLightTable(table, time, this.lerpVectors, this.bgraIntegerToRGBAVector);
  }

  static floatForTime(table, time) {
    return this.interpolateLightTable(table, time, this.lerpFloats);
  }

  static interpolateLightTable(table, time, lerp, transform = null) {
    const { entryCount, times, values } = table;

    if (entryCount === 0) {
      return transform ? transform(0) : 0;
    } else if (entryCount === 1) {
      return transform ? transform(values[0]) : 0;
    }

    let v1;
    let v2;
    let t1;
    let t2;

    for (let i = 0; i < entryCount; ++i) {
      // Wrap at end
      if (i + 1 >= entryCount) {
        v1 = values[i];
        v2 = values[0];
        t1 = times[i];
        t2 = times[0] + 2880;

        break;
      }

      // Found matching stops
      if (times[i] <= time && times[i + 1] >= time) {
        v1 = values[i];
        v2 = values[i + 1];
        t1 = times[i];
        t2 = times[i + 1];

        break;
      }
    }

    const tdiff = t2 - t1;

    if (tdiff < 0.001) {
      return transform ? transform(v1) : v1;
    }

    const factor = (time - t1) / tdiff;

    if (transform) {
      v1 = transform(v1);
      v2 = transform(v2);
    }

    return lerp(v1, v2, factor);
  }

  static lerpVectors(v1, v2, factor) {
    const result = [];

    for (let i = 0, c = v1.length; i < c; ++i) {
      result[i] = Math.round(((1.0 - factor) * v1[i]) + (factor * v2[i]));
    }

    return result;
  }

  static lerpFloats(v1, v2, factor) {
    return ((1.0 - factor) * v1) + (factor * v2);
  }

  static bgraIntegerToRGBAVector(value) {
    const v = [];

    v[0] = (value >> 16) & 0xFF;
    v[1] = (value >>  8) & 0xFF;
    v[2] = (value >>  0) & 0xFF;
    v[3] = (value >> 24) & 0xFF;

    return v;
  }

  static sortLights(results) {
    results.sort((a, b) => {
      if (a.percentageDistance > b.percentageDistance) {
        return -1;
      } else if (b.percentageDistance > a.percentageDistance) {
        return 1;
      } else {
        return 0;
      }
    });
  }

  static interpolateDayNightTable(table, size, distance) {
    // Clamp
    distance = Math.min(Math.max(distance, 0.0), 1.0);

    let d1;
    let d2;
    let v1;
    let v2;

    for (let i = 0; i < size; ++i) {
      // Wrap at end
      if (i + 1 >= size) {
        d1 = table[i * 2];
        d2 = table[0] + 1.0;

        v1 = table[i * 2 + 1];
        v2 = table[0 + 1];

        break;
      }

      // Found matching stops
      if (table[i * 2] <= distance && table[(i + 1) * 2] >= distance) {
        d1 = table[i * 2];
        d2 = table[(i + 1) * 2];

        v1 = table[i * 2 + 1];
        v2 = table[(i + 1) * 2 + 1];

        break;
      }
    }

    const diff = d2 - d1;

    if (diff < 0.001) {
      return v1;
    }

    const factor = (distance - d1) / diff;

    return this.lerpFloats(v1, v2, factor);
  }

  /**
   * Best guess at how the 1.12 client calculated light direction for the sun.
   *
   * Spherical to cartesian conversion
   *
   * This function makes use of spherical coordinates, but rendering involves cartesian
   * coordinates. The client converts the spherical coordinates represented in the phi and
   * theta tables into cartesian coordinates using the approach outlined here:
   *
   * - https://en.wikipedia.org/wiki/Spherical_coordinate_system#Cartesian_coordinates
   *
   */
  static getVanillaSunDirection(phi, theta) {
    const cartX = Math.sin(theta) * Math.cos(phi);
    const cartY = Math.sin(theta) * Math.sin(phi);
    const cartZ = Math.cos(theta);

    const dir = new THREE.Vector3(-cartX, cartY, cartZ);

    return dir;
  }

  /**
   * Light direction for the sun as calculated in the Wrath of the Lich King client. Output
   * values have been compared against the actual client for several arbitrary points of time.
   *
   * This function can be found at offset 7EEA90 in the 3.3.5a client.
   *
   */
  static getWrathSunDirection(phi, theta) {
    const v14 = phi * (1 / Math.PI);
    const v4 = v14 - 0.5;

    const v17 = 1.0 - v4 * ((6.0 - 4.0 * v4) * v4);
    const v15 = 1.0 - v14 * ((6.0 - 4.0 * v14) * v14);

    const v7 = theta * (1 / Math.PI)
    const v8 = v7 - 0.5;

    const v16 = 1.0 - v8 * ((6.0 - 4.0 * v8) * v8);
    const v11 = 1.0 - v8 * ((6.0 - 4.0 * v8) * v8);

    const dir = new THREE.Vector3(v11 * v17, v16 * v17, v15);

    return dir;
  }

}

export default WorldLight;


// function lerpManyVectors(colors, defaultVector) {
//   // let resultColor = defaultVector;
//   // defaultVector = [255,255,255,0];
//   const results = [];
//   for (let i=0; i<colors.length; i++) {
//     const currColor = colors[i];
//     // const nextColor = colors[i+1];
//     const bakedVector = WorldLight.lerpVectors(defaultVector, currColor.vector, currColor.factor);
//     // const bakedVector = rgbaToRgb(defaultVector, currColor.vector, currColor.factor);
//     results.push(bakedVector);
//   };

  
//   // return resultColor;
//   return averageVector(results);
// }
// function lerpManyVectors(colors: [{vector: [], factor: number, id: number}], defaultVector) {
//   // defaultVector = averageVector(colors.map(x => x.vector));
//   // defaultVector = [255, 255, 255, 0];
//   // defaultVector = [255/2, 255/2, 255/2, 0];
//   // let resultColor = defaultVector;
//   const results = [];
//   if (colors.length <= 1) {
//     return colors[0].vector;
//   } 

//   for (let i=0; i<colors.length-1; i++) {
//     const currColor = colors[i];
//     const nextColor = colors[i+1];
//     // const computedFactor = colors.reduce((acc, x, accIndex) => {
//     //   if (accIndex !== i) {
//     //     return acc + x.factor;
//     //   } else {
//     //     return acc;
//     //   }
//     // }, 0) / (colors.length)
//     // console.log(computedFactor - currColor.factor)
//     // resultColor = WorldLight.lerpVectors(resultColor, currColor.vector, currColor.factor / 2);
//     const factor = Math.abs(currColor.factor - nextColor.factor);
//     const bakedVector = WorldLight.lerpVectors(currColor.vector, nextColor.vector, factor);
//     // const bakedVector = rgbaToRgb(defaultVector, currColor.vector, currColor.factor);
//     results.push({id: currColor.id, factor: factor, vector:bakedVector});
//   };

  
//   // return resultColor;
//   const res = averageVector(results.map(x => x.vector));

//   global.safePrint(JSON.stringify({final: res, results:results.map(x => ({id:x.id, factor:x.factor, color:x.vector}))},null, 1));

//   return res;
// }

function lerpManyVectors(colors: [{vector: any[], factor: number, id: number}], defaultVector) {
  // defaultVector = averageVector(colors.map(x => x.vector));
  // defaultVector = [255, 255, 255, 0];
  // defaultVector = [255/2, 255/2, 255/2, 0];
  // let resultColor = defaultVector;
  colors.sort((a, b) => {
    if (a.factor > b.factor) {
      return -1;
    } else if (b.factor > a.factor) {
      return 1;
    } else {
      return 0;
    }
  });

  const primaryColor = colors[0];
  
  // console.log(primaryColor.id, primaryColor.factor)

  let resultVector =  WorldLight.lerpVectors(defaultVector, primaryColor.vector, primaryColor.factor);

  for (let i=0; i<colors.length; i++) {
    const nextColor = colors[i];
    if (nextColor.id !== primaryColor.id) {
      // console.log(nextColor.id, primaryColor.id);
      const factor = nextColor.factor;
      resultVector = WorldLight.lerpVectors(resultVector, nextColor.vector, factor);
    }
  }

  return resultVector;
  // const results = [];
  // if (colors.length <= 1) {
  //   return colors[0].vector;
  // } 

  // for (let i=0; i<colors.length-1; i++) {
  //   const currColor = colors[i];
  //   const nextColor = colors[i+1];
  //   // const computedFactor = colors.reduce((acc, x, accIndex) => {
  //   //   if (accIndex !== i) {
  //   //     return acc + x.factor;
  //   //   } else {
  //   //     return acc;
  //   //   }
  //   // }, 0) / (colors.length)
  //   // console.log(computedFactor - currColor.factor)
  //   // resultColor = WorldLight.lerpVectors(resultColor, currColor.vector, currColor.factor / 2);
  //   const factor = Math.abs(currColor.factor - nextColor.factor);
  //   const bakedVector = WorldLight.lerpVectors(currColor.vector, nextColor.vector, factor);
  //   // const bakedVector = rgbaToRgb(defaultVector, currColor.vector, currColor.factor);
  //   results.push({id: currColor.id, factor: factor, vector:bakedVector});
  // };

  
  // return resultColor;
  // const res = averageVector(results.map(x => x.vector));

  // global.safePrint(JSON.stringify({final: res, results:results.map(x => ({id:x.id, factor:x.factor, color:x.vector}))},null, 1));

  // return res;
}

const averageVector = (vectors) => {
  const res = vectors.reduce((acc,cur) => {
    acc[0] += cur[0]
    acc[1] += cur[1]
    acc[2] += cur[2]
    acc[3] += cur[3]
    return acc
  },[0,0,0,0]).map(cur => Math.round(cur / vectors.length))
  return res;
}

const averageFloat = (floats) => {
  const res = floats.reduce((acc, cur) => acc + cur, 0) / floats.length
  return res;
}

function lerpManyFloats(values, defaultValue) {
  let resultValue = values[0];
  const results = [];
  for (let i=0; i<values.length; i++) {
    const currValue = values[i];
    const bakedValue = WorldLight.lerpFloats(defaultValue, currValue.value, currValue.factor);
    results.push(bakedValue);
  }
  return averageFloat(results);
}

function rgbaToRgb(defaultVector, vector, factor) {
  const alpha = 1 - factor;
  const red = Math.round((factor * (vector[0] / 255) + (alpha * (defaultVector[0] / 255))) * 255);
  const green = Math.round((factor * (vector[1] / 255) + (alpha * (defaultVector[1] / 255))) * 255);
  const blue = Math.round((factor * (vector[2] / 255) + (alpha * (defaultVector[2] / 255))) * 255);
  return [red, green, blue]
}