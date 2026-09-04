// ========================================================
// three-scene.js — THREE.JS 场景初始化（GLCustomLayer 共享上下文）
// 坐标统一: x=east, y=north, z=UP (Amap 原生约定)
// camera.up = (0,0,1) 由 getCameraParams 提供
// ========================================================
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { state } from './state.js';
import { localToLngLat, METERS_PER_DEG_LAT } from './coords.js';

const raycaster = new THREE.Raycaster();

export function setupThreeScene(map) {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
        state.CONFIG.camera.fov, window.innerWidth / window.innerHeight, 1, 1 << 30);

    let renderer;
    const customCoords = map.customCoords;
    customCoords.setCenter(state.CONFIG.geo.center);

    // CSS2D Renderer — separate DOM canvas for labels
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'fixed';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    labelRenderer.domElement.style.zIndex = '5';
    document.body.appendChild(labelRenderer.domElement);

    // Promise: resolves in GLCustomLayer.init with coordinate helpers
    let initResolve;
    const waitForInit = () => new Promise(r => { initResolve = r; });

    // GLCustomLayer: Three.js 共享 Amap 的 WebGL 上下文
    let firstFrame = true;
    const gllayer = new AMap.GLCustomLayer({
        zIndex: 10,
        init: (gl) => {
            renderer = new THREE.WebGLRenderer({
                context: gl,
                premultipliedAlpha: false,
            });
            renderer.autoClear = false;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            // 关键：GLCustomLayer 共享 GL 上下文，渲染器尺寸必须与地图视口一致，
            // 否则每帧 viewport 会被重置为默认 300×150，悬浮层随之错位/漂移
            renderer.setSize(window.innerWidth, window.innerHeight);

            // 计算缩放（init 后 lngLatToCoord 才可靠）
            let lpm;
            try {
                const [cx0, cy0] = customCoords.lngLatToCoord([state.CONFIG.geo.center[0], state.CONFIG.geo.center[1]]);
                const [cx1, cy1] = customCoords.lngLatToCoord([state.CONFIG.geo.center[0], state.CONFIG.geo.center[1] + 0.001]);
                lpm = Math.abs(cy1 - cy0) / (0.001 * METERS_PER_DEG_LAT);
                if (!lpm || lpm <= 0) lpm = 1;
                console.log('📐 Amap缩放(init): 1米 =', lpm.toFixed(4), '局部单位, cx0=', cx0, 'cy0=', cy0);
            } catch (e) {
                console.warn('⚠️ 缩放计算失败:', e.message);
                lpm = 1;
            }

            // 本地米 → Amap 内部 3D 坐标
            const lta = (localX, localZ, heightM) => {
                const [lng, lat] = localToLngLat(localX, localZ, state.CONFIG.geo.center);
                const coord = customCoords.lngLatToCoord([lng, lat]);
                return { x: coord[0], y: coord[1], z: heightM * lpm };
            };

            initResolve({ localToAmap: lta, localPerMeter: lpm });
            console.log('✅ Three.js GLCustomLayer init (共享上下文)');
        },
        render: () => {
            const params = customCoords.getCameraParams();
            if (!params || !params.position) return;

            if (firstFrame) {
                firstFrame = false;
                console.log('📷 Amap相机:', JSON.stringify({
                    pos: params.position.map(v=>+v.toFixed(1)),
                    lookAt: params.lookAt.map(v=>+v.toFixed(1)),
                    up: params.up.map(v=>+v.toFixed(2)),
                    fov: params.fov, near: params.near, far: params.far
                }));
            }

            camera.near = params.near || 1;
            camera.far = params.far || 1 << 30;
            camera.fov = params.fov || state.CONFIG.camera.fov;

            // 高德官方 GLCustomLayer + Three.js 同步相机：position/up/lookAt 交给 THREE 计算矩阵
            camera.position.set(params.position[0], params.position[1], params.position[2]);
            camera.up.set(params.up[0], params.up[1], params.up[2]);
            camera.lookAt(params.lookAt[0], params.lookAt[1], params.lookAt[2]);
            camera.updateProjectionMatrix();

            // 渲染 Three.js 场景
            // 高德官方写法：世界坐标（lngLatToCoord）在创建时算一次锚定即可——它基于 setCenter 的固定坐标系，
            // 缩放/平移/旋转/俯仰都稳定；相机每帧由 getCameraParams 同步，悬浮层因此始终贴地、不随鼠标漂移
            renderer.resetState();
            renderer.render(scene, camera);
            renderer.resetState();

            // 渲染 CSS2D 标签
            labelRenderer.render(scene, camera);
        },
    });

    map.add(gllayer);

    // Lighting
    scene.add(new THREE.AmbientLight(0x8899bb, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(80, 120, 60);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8899cc, 0.5);
    fill.position.set(-40, 80, -50);
    scene.add(fill);

    return { scene, camera, renderer, labelRenderer, customCoords, map, waitForInit };
}

/** Create venue buildings */
export function buildVenue(scene, localToAmap) {
    const S = localToAmap(0, 1, 0).y - localToAmap(0, 0, 0).y; // scale: 1 meter in Amap units
    const clickables = [];

    const main = state.CONFIG.building.main;
    let amap = null, col = null, w = 0, d = 0, h = 0;
    if (main) {
        w = main.w; d = main.d; h = main.h;
        amap = localToAmap(main.pos[0], main.pos[2], 0);
        col = new THREE.Color(main.color);
        // 点击进入室内：打标签（name 匹配室内方案 building 字段）
        const [bLng, bLat] = localToLngLat(main.pos[0], main.pos[2], state.CONFIG.geo.center);

        if (main.modelUrl) {
            // 外部 GLB 模型（SketchUp 导出）替换程序化方块
            loadBuildingModel(scene, main, amap, col, bLng, bLat, w, d, h, S);
        } else {
            addBoxMain(scene, main, amap, col, bLng, bLat, w, d, h, S);
        }
    }

    // Sub buildings
    for (const sb of state.CONFIG.building.subs) {
        const _sc = new THREE.Color(sb.color);
        const mat = new THREE.MeshStandardMaterial({
            color: _sc, roughness: 0.45, metalness: 0.15, transparent: true, opacity: 0.8,
            emissive: _sc, emissiveIntensity: 0.3,
        });
        const sa = localToAmap(sb.x, sb.z, 0);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(sb.w * S, sb.d * S, sb.h * S), mat);
        mesh.position.set(sa.x, sa.y, sa.z + sb.h * S / 2);
        mesh.castShadow = true; mesh.receiveShadow = true;
        scene.add(mesh);
    }

    // Venue ground highlight（主建筑存在且未删除道路时才渲染）
    if (main && state.CONFIG.building.roadVisible !== false) {
        const rw = state.CONFIG.building.roadWidth || 8;
        const glowGeo = new THREE.PlaneGeometry((w + rw * 2 + 10) * S, (d + rw * 2 + 10) * S);
        const glowMat = new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false,
        });
        const glowPlane = new THREE.Mesh(glowGeo, glowMat);
        glowPlane.position.set(amap.x, amap.y, 0.02);
        scene.add(glowPlane);
    }

    return { clickables };
}

/** 主建筑方块（无模型时的兜底）：紫色体块 + 轻微自发光，对齐 Loca cadmall 深色商场风格 */
function addBoxMain(scene, main, amap, col, bLng, bLat, w, d, h, S) {
    const mainMat = new THREE.MeshStandardMaterial({
        color: col, roughness: 0.5, metalness: 0.15,
        emissive: col, emissiveIntensity: 0.35,
    });
    const mainMesh = new THREE.Mesh(new THREE.BoxGeometry(w * S, d * S, (h || 10) * S), mainMat);
    mainMesh.position.set(amap.x, amap.y, amap.z + (h || 10) * S / 2);
    if (main.rotation) mainMesh.rotation.z = THREE.MathUtils.degToRad(main.rotation);
    mainMesh.castShadow = true; mainMesh.receiveShadow = true;
    mainMesh.userData.building = { name: main.name || '', lng: bLng, lat: bLat };
    scene.add(mainMesh);
    state.buildingMeshes.push(mainMesh);
}

/** 加载外部 GLB 模型替换主建筑方块；失败自动回退方块 */
async function loadBuildingModel(scene, main, amap, col, bLng, bLat, w, d, h, S) {
    try {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(main.modelUrl);
        const model = gltf.scene;

        // 贴地 + 水平居中：模型本地 Y-up 空间里 Y 是上，X/Z 是水平
        const box = new THREE.Box3().setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.x -= c.x;
        model.position.y -= box.min.y;   // 底部贴地（Y=0）
        model.position.z -= c.z;

        // 轴修正：glTF 是 Y-up，场景是 Z-up → 绕 X 转 +90° 让「上」对齐
        const axisFix = new THREE.Group();
        axisFix.rotation.x = Math.PI / 2;
        axisFix.add(model);

        // 锚点：米制坐标定位 + 绕竖直轴旋转 + 缩放（补偿 SketchUp 单位差异）
        const anchor = new THREE.Group();
        anchor.position.set(amap.x, amap.y, amap.z);
        anchor.rotation.z = THREE.MathUtils.degToRad(main.rotation || 0);
        anchor.scale.setScalar(main.modelScale || 1);
        anchor.add(axisFix);

        model.traverse(node => {
            if (node.isMesh) {
                node.castShadow = true; node.receiveShadow = true;
                node.userData.building = { name: main.name || '', lng: bLng, lat: bLat };
                state.buildingMeshes.push(node);
            }
        });

        scene.add(anchor);
    } catch (err) {
        console.error('⚠️ GLB 模型加载失败，回退方块:', err);
        addBoxMain(scene, main, amap, col, bLng, bLat, w, d, h, S);
    }
}

/** 拾取主建筑：ndcX/ndcY ∈ [-1,1]，命中返回 {name,lng,lat}，否则 null */
export function pickBuilding(ndcX, ndcY) {
    if (!state.threeCtx || !state.threeCtx.camera || !state.buildingMeshes.length) return null;
    const camera = state.threeCtx.camera;
    camera.updateMatrixWorld();
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    const hits = raycaster.intersectObjects(state.buildingMeshes, false);
    if (!hits.length) return null;
    const b = hits[0].object.userData.building;
    return (b && b.name) ? b : null;
}
