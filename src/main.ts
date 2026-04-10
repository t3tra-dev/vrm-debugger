import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
} from "@pixiv/three-vrm-animation";

const DB_NAME = "vrm-debugger";
const STORE_NAME = "animations";
let db: IDBDatabase;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, {
        keyPath: "id",
        autoIncrement: true,
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(): Promise<{ id: number; name: string; blob: Blob }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () =>
      resolve(req.result as { id: number; name: string; blob: Blob }[]);
    req.onerror = () => reject(req.error);
  });
}

function dbAdd(name: string, blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).add({ name, blob });
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const container = document.getElementById("canvas-container") as HTMLDivElement;
const vrmInfoEl = document.getElementById("vrm-info") as HTMLDivElement;
const animListEl = document.getElementById("animation-list") as HTMLDivElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const btnLoadVRM = document.getElementById("btn-load-vrm") as HTMLButtonElement;
const btnLoadVRMA = document.getElementById(
  "btn-load-vrma",
) as HTMLButtonElement;
const inputVRM = document.getElementById("input-vrm") as HTMLInputElement;
const inputVRMA = document.getElementById("input-vrma") as HTMLInputElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 1.2, 4.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.update();

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(1, 3, 2);
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0x9999cc, 0.4);
fillLight.position.set(-1, 1, -2);
scene.add(fillLight);

const gridHelper = new THREE.GridHelper(10, 20, 0x333333, 0x222222);
scene.add(gridHelper);

let currentVRM: VRM | null = null;
let mixer: THREE.AnimationMixer | null = null;
let currentAction: THREE.AnimationAction | null = null;
let activeIndex = -1;
const timer = new THREE.Timer();

interface AnimEntry {
  id: number;
  name: string;
  blob: Blob;
  clip: THREE.AnimationClip | null;
}
const animEntries: AnimEntry[] = [];

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

function setLoading(on: boolean): void {
  loadingEl.classList.toggle("hidden", !on);
}

async function blobToClip(blob: Blob, vrm: VRM): Promise<THREE.AnimationClip> {
  const url = URL.createObjectURL(blob);
  try {
    const gltf = await loader.loadAsync(url);
    const vrmAnimations: any[] = gltf.userData.vrmAnimations ?? [];
    if (vrmAnimations.length === 0)
      throw new Error("VRMAnimationデータが見つかりません");
    return createVRMAnimationClip(vrmAnimations[0], vrm);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function rebuildClips(): Promise<void> {
  if (!currentVRM) return;
  for (const entry of animEntries) {
    try {
      entry.clip = await blobToClip(entry.blob, currentVRM);
    } catch {
      entry.clip = null;
    }
  }
}

async function loadVRM(file: File): Promise<void> {
  setLoading(true);
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("VRMデータが見つかりません");

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);

    if (currentVRM) {
      scene.remove(currentVRM.scene);
      VRMUtils.deepDispose(currentVRM.scene);
    }

    stopAnimation();
    currentVRM = vrm;
    scene.add(vrm.scene);

    if (vrm.lookAt) {
      const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      lookAtProxy.name = "VRMLookAtQuaternionProxy";
      vrm.scene.add(lookAtProxy);
    }

    mixer = new THREE.AnimationMixer(vrm.scene);

    await rebuildClips();

    updateVRMInfo(file.name);
    renderAnimList();
  } catch (e) {
    console.error(e);
    alert(`VRM 読み込みエラー: ${(e as Error).message}`);
  } finally {
    URL.revokeObjectURL(url);
    setLoading(false);
  }
}

async function loadVRMA(file: File): Promise<void> {
  setLoading(true);
  try {
    const blob = new Blob([await file.arrayBuffer()], {
      type: "model/gltf-binary",
    });
    const id = await dbAdd(file.name, blob);
    const clip = currentVRM ? await blobToClip(blob, currentVRM) : null;
    animEntries.push({ id, name: file.name, blob, clip });
    renderAnimList();
  } catch (e) {
    console.error(e);
    alert(`VRMA 読み込みエラー: ${(e as Error).message}`);
  } finally {
    setLoading(false);
  }
}

async function deleteAnimation(index: number): Promise<void> {
  const entry = animEntries[index];
  if (!entry) return;
  await dbDelete(entry.id);
  if (activeIndex === index) stopAnimation();
  animEntries.splice(index, 1);

  if (activeIndex > index) activeIndex--;
  renderAnimList();
}

function playAnimation(index: number): void {
  const entry = animEntries[index];
  if (!mixer || !entry?.clip) return;

  currentAction?.fadeOut(0.3);
  currentAction = mixer.clipAction(entry.clip);
  currentAction.reset().fadeIn(0.3).play();
  activeIndex = index;

  btnStop.style.display = "block";
  renderAnimList();
}

function stopAnimation(): void {
  currentAction?.fadeOut(0.3);
  currentAction = null;
  activeIndex = -1;
  btnStop.style.display = "none";
  renderAnimList();
}

function updateVRMInfo(name: string): void {
  vrmInfoEl.innerHTML = `<span class="tag">${name}</span>`;
}

function renderAnimList(): void {
  if (animEntries.length === 0) {
    animListEl.innerHTML = '<p class="empty-state">アニメーションなし</p>';
    return;
  }

  animListEl.innerHTML = animEntries
    .map(
      (entry, i) => `
    <div class="anim-entry${i === activeIndex ? " is-active" : ""}">
      <span class="anim-name" title="${entry.name}">${entry.name}</span>
      <button class="btn btn-play${i === activeIndex ? " is-active" : ""}" data-index="${i}">▶</button>
      <button class="btn btn-delete" data-index="${i}" title="削除">×</button>
    </div>`,
    )
    .join("");

  animListEl.querySelectorAll<HTMLButtonElement>(".btn-play").forEach((btn) => {
    btn.addEventListener("click", () => {
      playAnimation(Number(btn.dataset.index));
    });
  });

  animListEl
    .querySelectorAll<HTMLButtonElement>(".btn-delete")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        void deleteAnimation(Number(btn.dataset.index));
      });
    });
}

btnLoadVRM.addEventListener("click", () => inputVRM.click());
btnLoadVRMA.addEventListener("click", () => inputVRMA.click());

inputVRM.addEventListener("change", async () => {
  const file = inputVRM.files?.[0];
  if (file) await loadVRM(file);
  inputVRM.value = "";
});

inputVRMA.addEventListener("change", async () => {
  const files = Array.from(inputVRMA.files ?? []);
  for (const file of files) await loadVRMA(file);
  inputVRMA.value = "";
});

btnStop.addEventListener("click", stopAnimation);

async function restoreAnimations(): Promise<void> {
  const rows = await dbGetAll();
  for (const row of rows) {
    const clip = currentVRM
      ? await blobToClip(row.blob, currentVRM).catch(() => null)
      : null;
    animEntries.push({ id: row.id, name: row.name, blob: row.blob, clip });
  }
  renderAnimList();
}

function onResize(): void {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener("resize", onResize);
onResize();

function animate(): void {
  requestAnimationFrame(animate);
  timer.update();
  const delta = timer.getDelta();
  currentVRM?.update(delta);
  mixer?.update(delta);
  controls.update();
  renderer.render(scene, camera);
}

animate();

db = await openDB();
await restoreAnimations();
