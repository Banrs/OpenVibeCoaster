import * as THREE from "three";
import { sampleCompiledTrack } from "@openvibecoaster/core";
import type { CompiledTrackData, Vec3, Quat } from "@openvibecoaster/core";
import {
  addMeshDisposables,
  collectFromGroups,
  disposeSets,
} from "./dispose.js";

export const TRAIN_CAR_COUNT = 6;
export const CAR_PITCH_M = 3.4;

export interface CarTransform {
  position: Vec3;
  quaternion: Quat;
}

function quatFromBasis(tangent: Vec3, normal: Vec3, binormal: Vec3): Quat {
  // Build rotation matrix columns: tangent (Z forward), normal (Y up), binormal (X right)
  // Three uses Y-up, we map train forward along tangent, up along normal.
  // Matrix is column-major for THREE.Matrix4
  const m = new THREE.Matrix4();
  // X = binormal, Y = normal, Z = tangent
  m.set(
    binormal[0],
    normal[0],
    tangent[0],
    0,
    binormal[1],
    normal[1],
    tangent[1],
    0,
    binormal[2],
    normal[2],
    tangent[2],
    0,
    0,
    0,
    0,
    1,
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w] as Quat;
}

export function getCarTransforms(
  data: CompiledTrackData,
  frontDistance: number,
  carCount: number = TRAIN_CAR_COUNT,
  carPitch: number = CAR_PITCH_M,
): CarTransform[] {
  // Legacy fallback: reconstruct spacing from pitch (deprecated – retained only for degenerate/legacy empty timelines)
  const total = data.totalLength;
  if (total <= 1e-9) {
    return Array.from({ length: carCount }, () => ({
      position: [0, 0, 0] as Vec3,
      quaternion: [0, 0, 0, 1] as Quat,
    }));
  }
  const clamp = (d: number): number => Math.max(0, Math.min(total, d));
  const result: CarTransform[] = [];
  for (let i = 0; i < carCount; i++) {
    const distance = clamp(frontDistance - i * carPitch);
    const t = total === 0 ? 0 : distance / total;
    const sample = sampleCompiledTrack(data, t);
    const upOffset = 0.55;
    const pos: Vec3 = [
      sample.position[0] + sample.normal[0] * upOffset,
      sample.position[1] + sample.normal[1] * upOffset,
      sample.position[2] + sample.normal[2] * upOffset,
    ] as unknown as Vec3;
    const quat = quatFromBasis(sample.tangent, sample.normal, sample.binormal);
    result.push({ position: pos, quaternion: quat });
  }
  return result;
}

export function getCarTransformsFromCars(
  cars: readonly {
    position: Vec3;
    tangent: Vec3;
    normal: Vec3;
    binormal: Vec3;
  }[],
): CarTransform[] {
  const result: CarTransform[] = [];
  for (const car of cars) {
    const upOffset = 0.55;
    const pos: Vec3 = [
      car.position[0] + car.normal[0] * upOffset,
      car.position[1] + car.normal[1] * upOffset,
      car.position[2] + car.normal[2] * upOffset,
    ] as unknown as Vec3;
    const quat = quatFromBasis(car.tangent, car.normal, car.binormal);
    result.push({ position: pos, quaternion: quat });
  }
  return result;
}

export interface TrainGroup {
  group: THREE.Group;
  cars: THREE.Group[];
}

function createSingleCarMesh(): THREE.Group {
  const car = new THREE.Group();
  car.name = "car";
  let bodyGeom: THREE.BufferGeometry | null = null;
  let bodyMat: THREE.Material | null = null;
  let roofGeom: THREE.BufferGeometry | null = null;
  let roofMat: THREE.Material | null = null;
  let wheelGeom: THREE.BufferGeometry | null = null;
  let wheelMat: THREE.Material | null = null;
  try {
    bodyGeom = new THREE.BoxGeometry(1.4, 0.55, 2.6);
    bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3a7bff,
      roughness: 0.45,
      metalness: 0.18,
    });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(0, 0.45, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    car.add(body);
    bodyGeom = null;
    bodyMat = null;

    roofGeom = new THREE.BoxGeometry(1.35, 0.08, 2.4);
    roofMat = new THREE.MeshStandardMaterial({
      color: 0x1e2d4a,
      roughness: 0.7,
    });
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(0, 0.78, 0);
    car.add(roof);
    roofGeom = null;
    roofMat = null;

    wheelGeom = new THREE.CylinderGeometry(0.22, 0.22, 1.25, 10);
    wheelGeom.rotateZ(Math.PI / 2);
    wheelMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1e,
      roughness: 0.9,
    });
    const wheelF = new THREE.Mesh(wheelGeom, wheelMat);
    wheelF.position.set(0, -0.02, 0.8);
    const wheelR = wheelF.clone();
    wheelR.position.set(0, -0.02, -0.8);
    car.add(wheelF, wheelR);
    wheelGeom = null;
    wheelMat = null;

    car.userData.isCar = true;
    return car;
  } catch (e) {
    const geoms = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    if (bodyGeom) geoms.add(bodyGeom);
    if (roofGeom) geoms.add(roofGeom);
    if (wheelGeom) geoms.add(wheelGeom);
    if (bodyMat) mats.add(bodyMat);
    if (roofMat) mats.add(roofMat);
    if (wheelMat) mats.add(wheelMat);
    for (const child of car.children) {
      addMeshDisposables(
        child as unknown as {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        },
        geoms,
        mats,
      );
    }
    disposeSets(geoms, mats);
    throw e;
  }
}

export function createTrainGroup(): TrainGroup {
  const group = new THREE.Group();
  group.name = "train";
  const cars: THREE.Group[] = [];
  let currentCar: THREE.Group | null = null;
  try {
    for (let i = 0; i < TRAIN_CAR_COUNT; i++) {
      const car = createSingleCarMesh();
      currentCar = car;
      // Slight color variation front vs rear for recognizability
      if (i === 0) {
        const body = car.children[0] as THREE.Mesh;
        (body.material as THREE.MeshStandardMaterial).color.set(0x4f8cff);
      } else if (i === TRAIN_CAR_COUNT - 1) {
        const body = car.children[0] as THREE.Mesh;
        (body.material as THREE.MeshStandardMaterial).color.set(0x2f6feb);
      }
      cars.push(car);
      group.add(car);
      currentCar = null;
    }
    group.userData.isTrain = true;
    return { group, cars };
  } catch (e) {
    const toDispose: THREE.Group[] = [...cars];
    if (currentCar && !cars.includes(currentCar)) toDispose.push(currentCar);
    const geoms = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    collectFromGroups(toDispose, geoms, mats);
    disposeSets(geoms, mats);
    throw e;
  }
}

export function updateTrainTransforms(
  group: TrainGroup,
  transforms: CarTransform[],
): void {
  for (let i = 0; i < group.cars.length; i++) {
    const car = group.cars[i]!;
    const tr = transforms[i];
    if (!tr) {
      car.visible = false;
      continue;
    }
    car.visible = true;
    car.position.set(
      tr.position[0] ?? 0,
      tr.position[1] ?? 0,
      tr.position[2] ?? 0,
    );
    car.quaternion.set(
      tr.quaternion[0] ?? 0,
      tr.quaternion[1] ?? 0,
      tr.quaternion[2] ?? 0,
      tr.quaternion[3] ?? 1,
    );
  }
}
