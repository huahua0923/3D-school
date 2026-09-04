// ========================================================
// config.js — 全局配置加载 + 品牌 Logo 明暗自适应底色
// ========================================================
import { state } from './state.js';

export const DEFAULT_CONFIG = {
    geo: { amapKey: '', amapSecurityCode: '', center: [116.3894, 39.9976], zoom: 17, pitch: 55, rotation: 20, mapStyle: 'amap://styles/dark' },
    brand: { name: '', subtitle: '', logo: '', logoText: '' },
    areas: [],
    groundSize: 200, fogColor: '#0a0e17', fogNear: 60, fogFar: 220,
    building: {
        main: { w: 40, d: 60, h: 18, color: '#1e2d5a', pos: [0, 0, 0], name: '', rotation: 0, modelUrl: '', modelScale: 1 },
        subs: [],
        roadWidth: 8,
    },
    markers: {},
    routes: {},
    parking: [],
    particles: { count: 0, spread: 90, height: 35 },
    camera: {
        fov: 42, near: 0.5, far: 400,
        initial: { pos: [70, 50, 80], target: [0, 4, 0] },
        presets: {},
        tweenMs: 1400, orbitDamping: 0.08, minDist: 12, maxDist: 160, maxPolarFactor: 0.46,
    },
    features: {
        indoor:         { enabled: true, layerHeight: 4 },
        routeNav:       { enabled: true, defaultTravelMode: 'walking', guideFollow: true, navMarkersOnly: true },
        weather:        { enabled: true, refreshMin: 30 },
        nearby:         { enabled: true, radius: 2000 },
        measure:        { enabled: true },
        loca:           { enabled: true },
        buildingSwitch: { enabled: true },
        autoRotate:     { enabled: true },
    },
};

export async function loadConfig() {
    try {
        const resp = await fetch('/config.json');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        state.CONFIG = await resp.json();
        if (state.CONFIG.camera.maxPolarFactor) {
            state.CONFIG.camera.maxPolar = Math.PI * state.CONFIG.camera.maxPolarFactor;
        }
        console.log('✅ 配置已加载');
        // 应用品牌配置
        if (state.CONFIG.brand) {
            document.title = (state.CONFIG.brand.name || '3D 智慧导览') + ' · ' + (state.CONFIG.brand.subtitle || '');
            document.getElementById('loader-sub').textContent = state.CONFIG.brand.subtitle || '';
            const logoImgVal = state.CONFIG.brand.logo || '';
            const logoTextVal = state.CONFIG.brand.logoText || '';
            const isImgLogo = /^(data:image|https?:\/\/)/i.test(logoImgVal);
            const lb = document.getElementById('loader-brand');
            if (lb) lb.textContent = (logoTextVal ? logoTextVal + ' ' : '') + (state.CONFIG.brand.name || '');
            const logoEl = document.getElementById('sb-logo');
            logoEl.textContent = '';
            if (isImgLogo) {
                const img = document.createElement('img');
                img.src = logoImgVal;
                img.alt = 'logo';
                img.onload = () => applyLogoBg(img);
                if (img.complete) applyLogoBg(img);
                logoEl.appendChild(img);
            }
            if (logoTextVal) {
                const span = document.createElement('span');
                span.textContent = logoTextVal;
                logoEl.appendChild(span);
            }
            if (!isImgLogo && !logoTextVal) {
                logoEl.textContent = '🏟️';
            }
            document.getElementById('sb-title').textContent = state.CONFIG.brand.name || '';
            document.getElementById('sb-sub').textContent = state.CONFIG.brand.subtitle || '';
            const loaderLogoEl = document.getElementById('loader-logo');
            if (loaderLogoEl) {
                loaderLogoEl.textContent = '';
                if (isImgLogo) {
                    const limg = document.createElement('img');
                    limg.src = logoImgVal;
                    limg.alt = 'logo';
                    limg.onload = () => applyLogoBg(limg);
                    if (limg.complete) applyLogoBg(limg);
                    loaderLogoEl.appendChild(limg);
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ 使用默认配置:', err.message);
        state.CONFIG = DEFAULT_CONFIG;
        state.CONFIG.camera.maxPolar = Math.PI * (state.CONFIG.camera.maxPolarFactor || 0.46);
    }
}

// 根据 logo 图片明暗自动选底色：浅色 logo → 深底，深色 logo → 白底
function applyLogoBg(img) {
    try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 10) {
                sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                n++;
            }
        }
        if (!n) return;
        if (sum / n > 165) {
            img.style.background = '#0b1220';
            img.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.12)';
        } else {
            img.style.background = '#ffffff';
        }
    } catch (e) { /* 保持默认白底 */ }
}
