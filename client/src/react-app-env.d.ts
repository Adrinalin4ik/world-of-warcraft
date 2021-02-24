/// <reference types="node" />
/// <reference types="react" />
/// <reference types="react-dom" />
/// <reference types="three" />

declare module 'browserify-zlib';

declare module 'byte-buffer' {
  export default class ByteBuffer {
    static HEADER_SIZE: number;
    static LITTLE_ENDIAN: number;
    static BIG_ENDIAN: number;
    constructor(source?:ArrayBuffer, order?: number, implicitGrowth?: boolean)
    buffer: ArrayBuffer;
    view: NodeJS.ArrayBufferView;
    raw: Uint8Array[];
    readByte(order?):number;
    readUnsignedByte(order?):number;
    readShort(order?):number;
    readUnsignedShort(order?):number;
    readInt(order?):number;
    readUnsignedInt(order?):number;
    readFloat(order?):number;
    readDouble(order?):number;
    readCString(order?):number;
    writeByte(number: number):number;
    write(number: number):number;
    writeUnsignedByte(number: number):number;
    writeUnsignedByte(number: number):number;
    writeShort(number: number):number;
    writeUnsignedShort(number: number):number;
    writeInt(number: number):number;
    writeUnsignedInt(number: number):number;
    writeFloat(number: number):number;
    writeDouble(number: number):number;
    writeCString(str: string): number;
    toHex(spacer: string):string;
    toASCII(spacer: string, align: boolean, unknown: string):string;
    clone(): ByteBuffer;
    clip(begin: number, end: number): ByteBuffer;
    append(bytes: number): ByteBuffer;
    read(method: string, bytes?: number): ByteBuffer;
    length: number;
  }
}

declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV: 'development' | 'production' | 'test';
    readonly PUBLIC_URL: string;
  }
}

declare module '*.bmp' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  import * as React from 'react';

  export const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;

  const src: string;
  export default src;
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.scss' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.sass' {
  const classes: { readonly [key: string]: string };
  export default classes;
}


declare module 'easy-mediasoup-v3-client';
declare module 'react-joystick';
// Type definitions for Physijs
// Project: http://chandlerprall.github.io/Physijs/
// Definitions by: Satoru Kimura <https://github.com/gyohk>
// Definitions: https://github.com/borisyankov/DefinitelyTyped


/// <reference path="../threejs/three.d.ts" />

declare module 'stats-js';

declare module 'physijs-webpack' {
  export function noConflict(): Object;
  export function createMaterial(material: THREE.Material, friction?: number, restitution?: number): Material;

  export interface Material extends THREE.Material {
    _physijs: {
      id: number;
      friction: number;
      restriction: number
    };
  }

  export interface Constraint {
    getDefinition(): any;
  }

  export interface PointConstraintDefinition {
    type: string;
    id: number;
    objecta: THREE.Object3D;
    objectb: THREE.Object3D;
    positiona: THREE.Vector3;
    positionb: THREE.Vector3;
  }

  export class PointConstraint implements Constraint {
    constructor(objecta: THREE.Object3D, objectb: THREE.Object3D, position?: THREE.Vector3);

    getDefinition(): PointConstraintDefinition;
  }

  export interface HingeConstraintDefinition {
    type: string;
    id: number;
    objecta: THREE.Object3D;
    objectb: THREE.Object3D;
    positiona: THREE.Vector3;
    positionb: THREE.Vector3;
    axis: THREE.Vector3;
  }

  export class HingeConstraint implements Constraint {
    constructor(objecta: THREE.Object3D, objectb: THREE.Object3D, position: THREE.Vector3, axis?: THREE.Vector3);

    getDefinition(): HingeConstraintDefinition;
    setLimits(low: number, high: number, bias_factor: number, relaxation_factor: number): void;
    enableAngularMotor(velocity: number, acceleration: number): void;
    disableMotor(): void;
  }

  export interface SliderConstraintDefinition {
    type: string;
    id: number;
    objecta: THREE.Object3D;
    objectb: THREE.Object3D;
    positiona: THREE.Vector3;
    positionb: THREE.Vector3;
    axis: THREE.Vector3;
  }

  export class SliderConstraint implements Constraint {
    constructor(objecta: THREE.Object3D, objectb: THREE.Object3D, position: THREE.Vector3, axis?: THREE.Vector3);

    getDefinition(): SliderConstraintDefinition;
    setLimits(lin_lower: number, lin_upper: number, ang_lower: number, ang_upper: number): void;
    setRestitution(linear: number, angular: number): void;
    enableLinearMotor(velocity: number, acceleration: number): void;
    disableLinearMotor(): void;
    enableAngularMotor(velocity: number, acceleration: number): void;
    disableAngularMotor(): void;
  }

  export interface ConeTwistConstraintDefinition {
    type: string;
    id: number;
    objecta: THREE.Object3D;
    objectb: THREE.Object3D;
    positiona: THREE.Vector3;
    positionb: THREE.Vector3;
    axisa: THREE.Vector3;
    axisb: THREE.Vector3;
  }

  export class ConeTwistConstraint implements Constraint {
    constructor(objecta: THREE.Object3D, objectb: THREE.Object3D, position: THREE.Vector3);

    getDefinition(): ConeTwistConstraintDefinition;
    setLimit(x: number, y: number, z: number): void;
    enableMotor(): void;
    setMaxMotorImpulse(max_impulse: number): void;
    setMotorTarget(target: THREE.Vector3): void;
    setMotorTarget(target: THREE.Euler): void;
    setMotorTarget(target: THREE.Matrix4): void;
    disableMotor(): void;

  }

  export interface DOFConstraintDefinition {
    type: string;
    id: number;
    objecta: THREE.Object3D;
    objectb: THREE.Object3D;
    positiona: THREE.Vector3;
    positionb: THREE.Vector3;
    axisa: THREE.Vector3;
    axisb: THREE.Vector3;
  }

  export class DOFConstraint implements Constraint {
    constructor(objecta: THREE.Object3D, objectb: THREE.Object3D, position?: THREE.Vector3);

    getDefinition(): DOFConstraintDefinition;
    setLinearLowerLimit(limit: THREE.Vector3): void;
    setLinearUpperLimit(limit: THREE.Vector3): void;
    setAngularLowerLimit(limit: THREE.Vector3): void;
    setAngularUpperLimit(limit: THREE.Vector3): void;
    enableAngularMotor(which: number): void;
    configureAngularMotor(which: number, low_angle: number, high_angle: number, velocity: number, max_force: number): void;
    disableAngularMotor(which: number): void;
  }
  export var scripts: {
    worker: string;
    ammo: string;
  };

  export interface SceneParameters {
    ammo?: string;
    fixedTimeStep?: number;
    rateLimit?: boolean;
  }

  export class Scene extends THREE.Scene {
    constructor(param?: SceneParameters);

    addConstraint(constraint: Constraint, show_marker?: boolean): void;
    onSimulationResume(): void;
    removeConstraint(constraint: Constraint): void;
    execute(cmd: string, params: any): void;
    add(object: THREE.Object3D): void;
    remove(object: THREE.Object3D): void;
    setFixedTimeStep(fixedTimeStep: number): void;
    setGravity(gravity): void;
    simulate(timeStep?: number, maxSubSteps?: number): boolean;


    // Eventable mixins
    addEventListener(event_name: string, callback: (event: any) => void): void;
    removeEventListener(event_name: string, callback: (event: any) => void): void;
    dispatchEvent(event_name: string): void;

    // (extends from Object3D)
    dispatchEvent(event: { type: string; target: any; }): void;
  }

  export class Mesh extends THREE.Mesh {
    constructor(geometry: THREE.Geometry, material?: THREE.Material, mass?: number);

    applyCentralImpulse(force: THREE.Vector3): void;
    applyImpulse(force: THREE.Vector3, offset: THREE.Vector3): void;
    applyCentralForce(force: THREE.Vector3): void;
    applyForce(force: THREE.Vector3, offset: THREE.Vector3): void;
    getAngularVelocity(): THREE.Vector3;
    setAngularVelocity(velocity: THREE.Vector3): void;
    getLinearVelocity(): THREE.Vector3;
    setLinearVelocity(velocity: THREE.Vector3): void;
    setAngularFactor(factor: THREE.Vector3): void;
    setLinearFactor(factor: THREE.Vector3): void;
    setDamping(linear: number, angular: number): void;
    setCcdMotionThreshold(threshold: number): void;
    setCcdSweptSphereRadius(radius: number): void;


    // Eventable mixins
    addEventListener(event_name: string, callback: (event: any) => void): void;
    removeEventListener(event_name: string, callback: (event: any) => void): void;
    dispatchEvent(event_name: string): void;

    // (extends from Object3D)
    dispatchEvent(event: { type: string; target: any; }): void;
  }

  export class PlaneMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);

  }

  export class HeightfieldMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number, xdiv?: number, ydiv?: number);
  }

  export class BoxMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class SphereMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class CylinderMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class CapsuleMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class ConeMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class ConcaveMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class ConvexMesh extends Mesh {
    constructor(geometry: THREE.Geometry, material: THREE.Material, mass?: number);
  }

  export class Vehicle {
    constructor(mesh: Mesh, tuning?: VehicleTuning);

    mesh: THREE.Mesh;
    wheels: THREE.Mesh[];

    addWheel(wheel_geometry: THREE.Geometry, wheel_material: THREE.Material, connection_point: THREE.Vector3, wheel_direction: THREE.Vector3, wheel_axle: THREE.Vector3, suspension_rest_length: number, wheel_radius: number, is_front_wheel: boolean, tuning?: VehicleTuning): void;
    setSteering(amount: number, wheel?: THREE.Mesh): void;
    setBrake(amount: number, wheel?: THREE.Mesh): void;
    applyEngineForce(amount: number, wheel?: THREE.Mesh): void;
  }

  export class VehicleTuning {
    constructor(suspension_stiffness?: number, suspension_compression?: number, suspension_damping?: number, max_suspension_travel?: number, friction_slip?: number, max_suspension_force?: number);

    suspension_stiffness: number;
    suspension_compression: number;
    suspension_damping: number;
    max_suspension_travel: number;
    friction_slip: number;
    max_suspension_force: number;
  }
}