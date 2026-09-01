// ============================================================
// editor-geo.js — 高德地图 SDK 加载 + 地理范围点选/对位/设置弹窗
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import { state, setState, showToast } from './editor-state.js';
import { scaleFromBounds, boundsFromScale, defaultGeoBounds, ensureGeoBounds } from './editor-geometry.js';
import { startCalibrate } from './editor-elements.js';

// —— 在地图上点选地理范围（自动获取经纬度） ——
export function loadAmap() {
  if (state._amapPromise) return state._amapPromise;
  state._amapPromise = (async () => {
    if (window.AMap) return window.AMap;
    const cfg = state.geoConfig || {};
    let key = cfg.amapKey || '';
    let sec = cfg.amapSecurityCode || '';
    // 优先用服务端 .env 注入的高德 Key/安全密钥（高德官方建议：key 不进仓库）
    try {
      const r = await fetch('/api/amap');
      const d = await r.json();
      if (d && d.key) key = d.key;
      if (d && d.securityJsCode) sec = d.securityJsCode;
    } catch (_) { /* 回退到 config.json */ }
    if (sec) window._AMapSecurityConfig = { securityJsCode: sec };
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + key;
      s.onload = () => window.AMap ? resolve() : reject(new Error('AMap 未加载'));
      s.onerror = () => reject(new Error('地图 SDK 加载失败'));
      document.head.appendChild(s);
    });
    return window.AMap;
  })();
  return state._amapPromise;
}

export function showGeoPicker(onPick) {
  const center = (state.geoConfig && Array.isArray(state.geoConfig.center) && state.geoConfig.center.length >= 2) ? state.geoConfig.center : state.defaultCenter;
  const zoom = (state.geoConfig && state.geoConfig.zoom) || 16;
  const mapStyle = (state.geoConfig && state.geoConfig.mapStyle) || 'amap://styles/normal';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="position:relative;width:min(94vw,1100px);height:min(88vh,720px);background:#0d1117;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.08);background:#111827;">
        <span style="font-weight:700;color:#e0e0f0;font-size:0.9rem;">🖱️ 在地图上点选范围</span>
        <span id="geo-pick-hint" style="font-size:0.8rem;color:#9aa;flex:1;"></span>
        <button id="geo-pick-reset" class="toolbar-btn" style="font-size:0.75rem;">重新选点</button>
        <button id="geo-pick-cancel" class="toolbar-btn" style="font-size:0.75rem;">取消</button>
        <button id="geo-pick-ok" class="toolbar-btn primary" style="font-size:0.75rem;" disabled>确定</button>
      </div>
      <div id="geo-pick-map" style="flex:1;min-height:0;"></div>
    </div>`;
  document.body.appendChild(overlay);

  const hint = overlay.querySelector('#geo-pick-hint');
  const okBtn = overlay.querySelector('#geo-pick-ok');
  overlay.querySelector('#geo-pick-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  loadAmap().then(AMap => {
    const map = new AMap.Map('geo-pick-map', { viewMode: '2D', center, zoom, mapStyle });
    const pts = [];
    const markers = [];
    let rect = null;
    hint.textContent = '点击地图上的第一个角点（例如左上角）';

    map.on('click', e => {
      if (pts.length >= 2) return;
      pts.push([e.lnglat.getLng(), e.lnglat.getLat()]);
      markers.push(new AMap.Marker({ position: e.lnglat, map }));
      if (pts.length === 1) {
        hint.textContent = '已选第一个角点，请点击第二个角点（例如右下角）';
      } else {
        hint.textContent = '已选两个角点，点「确定」使用此范围';
        const lngs = [pts[0][0], pts[1][0]], lats = [pts[0][1], pts[1][1]];
        const nw = [Math.min(...lngs), Math.max(...lats)];
        const se = [Math.max(...lngs), Math.min(...lats)];
        rect = new AMap.Polygon({ path: [nw, [se[0], nw[1]], se, [nw[0], se[1]]], strokeColor: '#ffd400', strokeWeight: 2, fillColor: '#ffd400', fillOpacity: 0.15, map });
        okBtn.disabled = false;
      }
    });

    overlay.querySelector('#geo-pick-reset').onclick = () => {
      markers.forEach(m => m.setMap(null)); markers.length = 0;
      pts.length = 0;
      if (rect) { rect.setMap(null); rect = null; }
      okBtn.disabled = true;
      hint.textContent = '点击地图上的第一个角点（例如左上角）';
    };
    overlay.querySelector('#geo-pick-ok').onclick = () => {
      if (pts.length < 2) return;
      const lngs = [pts[0][0], pts[1][0]], lats = [pts[0][1], pts[1][1]];
      onPick({ nw: [Math.min(...lngs), Math.max(...lats)], se: [Math.max(...lngs), Math.min(...lats)] });
      overlay.remove();
    };
  }).catch(err => {
    hint.textContent = '❌ ' + err.message;
  });
}

// —— 所见即所得对位：底图半透明叠加到地图，点击定位 + 拖手柄微调 + 滑块缩放 ——
export function showGeoAlign(onPick) {
  const imgDataUrl = state.backgroundImage;
  if (!imgDataUrl) { alert('请先导入底图（🖼️ 导入图片）'); return; }
  const imgW = state.imageWidth || 1200;
  const imgH = state.imageHeight || 800;
  const gb = ensureGeoBounds();
  const center0 = [(gb.nw[0] + gb.se[0]) / 2, (gb.nw[1] + gb.se[1]) / 2];
  const width0 = Math.max(gb.se[0] - gb.nw[0], 1e-6);

  const zoom = (state.geoConfig && state.geoConfig.zoom) || 16;
  const mapStyle = (state.geoConfig && state.geoConfig.mapStyle) || 'amap://styles/normal';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="position:relative;width:min(96vw,1200px);height:min(92vh,780px);background:#0d1117;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.5);">
      <div style="padding:10px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(255,255,255,0.08);background:#111827;flex-wrap:wrap;">
        <span style="font-weight:700;color:#e0e0f0;font-size:0.9rem;">🎯 地图对位</span>
        <span id="geo-align-hint" style="font-size:0.76rem;color:#9aa;flex:1;min-width:220px;">点击地图 → 移动中心；拖 🟡 手柄 → 微调；缩放/旋转可拖动或直接输入数值</span>
        <label style="font-size:0.75rem;color:#9aa;display:flex;align-items:center;gap:6px;">底图缩放
          <input id="geo-align-scale" type="range" min="20" max="500" value="100" style="width:100px;accent-color:#3b82f6;" />
          <input id="geo-align-scale-val" type="number" min="20" max="500" value="100" style="width:58px;background:#1f2937;border:1px solid rgba(255,255,255,0.15);color:#e0e0f0;border-radius:4px;padding:2px 4px;font-size:0.72rem;" />%
        </label>
        <label style="font-size:0.75rem;color:#9aa;display:flex;align-items:center;gap:6px;">旋转
          <input id="geo-align-rotate" type="range" min="-180" max="180" value="0" step="0.5" style="width:90px;accent-color:#f59e0b;" />
          <input id="geo-align-rotate-val" type="number" min="-180" max="180" step="0.5" value="0" style="width:58px;background:#1f2937;border:1px solid rgba(255,255,255,0.15);color:#e0e0f0;border-radius:4px;padding:2px 4px;font-size:0.72rem;" />°
        </label>
        <button id="geo-align-reset" class="toolbar-btn" style="font-size:0.75rem;">重置</button>
        <button id="geo-align-cancel" class="toolbar-btn" style="font-size:0.75rem;">取消</button>
        <button id="geo-align-ok" class="toolbar-btn primary" style="font-size:0.75rem;">✅ 确定使用</button>
      </div>
      <div id="geo-align-map" style="flex:1;min-height:0;position:relative;overflow:hidden;">
        <img id="geo-align-img" style="position:absolute;opacity:0.55;pointer-events:none;z-index:30;box-shadow:0 0 0 2px #ffd400;transform-origin:center;" />
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const mapEl = overlay.querySelector('#geo-align-map');
  const img = overlay.querySelector('#geo-align-img');
  const hint = overlay.querySelector('#geo-align-hint');
  const scaleEl = overlay.querySelector('#geo-align-scale');
  const scaleVal = overlay.querySelector('#geo-align-scale-val');
  const rotateEl = overlay.querySelector('#geo-align-rotate');
  const rotateVal = overlay.querySelector('#geo-align-rotate-val');
  img.src = imgDataUrl;

  overlay.querySelector('#geo-align-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  loadAmap().then(AMap => {
    const map = new AMap.Map(mapEl, { viewMode: '2D', center: center0, zoom, mapStyle, pitch: 0, rotation: 0 });

    let center = [...center0];
    let widthDeg = width0;
    let rotation = gb.rotation || 0;
    rotateEl.value = rotation; rotateVal.value = rotation;

    // 纬度跨度按图片宽高比 + 墨卡托 cos 修正，保证底图在地图上显示为正确宽高比、不变形
    function heightDeg() {
      return widthDeg * (imgH / imgW) * Math.cos(center[1] * Math.PI / 180);
    }
    function positionImg() {
      const hD = heightDeg();
      const nw = [center[0] - widthDeg / 2, center[1] + hD / 2];
      const se = [center[0] + widthDeg / 2, center[1] - hD / 2];
      const pNW = map.lngLatToContainer(new AMap.LngLat(nw[0], nw[1]));
      const pSE = map.lngLatToContainer(new AMap.LngLat(se[0], se[1]));
      img.style.left = pNW.x + 'px';
      img.style.top = pNW.y + 'px';
      img.style.width = Math.max(1, pSE.x - pNW.x) + 'px';
      img.style.height = Math.max(1, pSE.y - pNW.y) + 'px';
      img.style.transform = 'rotate(' + rotation + 'deg)';
    }

    // 中心手柄（可拖拽，微调平移）
    const centerMarker = new AMap.Marker({
      position: center0,
      draggable: true,
      map,
      zIndex: 40,
      content: '<div style="width:22px;height:22px;border-radius:50%;background:#ffd400;border:3px solid #fff;box-shadow:0 0 10px rgba(0,0,0,0.7);cursor:move;"></div>',
      offset: new AMap.Pixel(-11, -11),
    });
    centerMarker.on('dragging', e => {
      center = [e.lnglat.getLng(), e.lnglat.getLat()];
      positionImg();
    });

    // 点击地图：底图中心直接跳过去（快速定位）
    map.on('click', e => {
      center = [e.lnglat.getLng(), e.lnglat.getLat()];
      centerMarker.setPosition([center[0], center[1]]);
      positionImg();
    });

    // 底图缩放（滑块拖动 / 数字框输入，双向同步）
    const applyScale = v => { widthDeg = width0 * (v / 100); scaleEl.value = v; scaleVal.value = v; positionImg(); };
    scaleEl.addEventListener('input', () => applyScale(Number(scaleEl.value)));
    scaleVal.addEventListener('input', () => applyScale(Math.min(500, Math.max(20, Number(scaleVal.value) || 100))));

    // 底图旋转（滑块拖动 / 数字框输入，双向同步；用于对齐非正北朝向的平面图）
    const applyRotation = v => { rotation = v; rotateEl.value = v; rotateVal.value = v; positionImg(); };
    rotateEl.addEventListener('input', () => applyRotation(Number(rotateEl.value)));
    rotateVal.addEventListener('input', () => applyRotation(Math.min(180, Math.max(-180, Number(rotateVal.value) || 0))));

    overlay.querySelector('#geo-align-reset').onclick = () => {
      center = [...center0]; widthDeg = width0; rotation = gb.rotation || 0;
      scaleEl.value = 100; scaleVal.value = 100;
      rotateEl.value = rotation; rotateVal.value = rotation;
      centerMarker.setPosition([center[0], center[1]]);
      positionImg();
    };

    // 地图移动/缩放后，重新贴底图（底图固定在地理坐标上，跟随地图）
    map.on('moveend', positionImg);
    map.on('zoomend', positionImg);

    overlay.querySelector('#geo-align-ok').onclick = () => {
      const hD = heightDeg();
      onPick({ nw: [center[0] - widthDeg / 2, center[1] + hD / 2], se: [center[0] + widthDeg / 2, center[1] - hD / 2], rotation });
      overlay.remove();
    };

    // 首次定位（地图容器就绪后）
    map.on('complete', positionImg);
    setTimeout(positionImg, 250);
  }).catch(err => {
    hint.textContent = '❌ ' + err.message;
  });
}

export function showGeoBoundsModal() {
  const gb = ensureGeoBounds();
  const imgW = state.imageWidth || 1200;
  const imgH = state.imageHeight || 800;
  const imgAr = imgW / imgH;
  const midLng = (gb.nw[0] + gb.se[0]) / 2;
  const midLat = (gb.nw[1] + gb.se[1]) / 2;
  const { mpp: curMpp } = scaleFromBounds(gb, imgW);
  const curWM = imgW * curMpp, curHM = imgH * curMpp;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box"><h2>🌐 地理范围</h2>
    <p style="color:#8888aa;font-size:0.8rem;margin-bottom:12px;">设定本方案对应真实地图的经纬度范围与比例尺（1 像素 = 多少米），保存后 3D 主地图按此范围展示线/框/文字，并保持图片宽高比不变形。</p>

    <div style="background:#111827;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:12px;margin-bottom:12px;">
      <div style="font-size:0.8rem;font-weight:600;color:#e0e0f0;margin-bottom:8px;">⚡ 真实尺寸标定（推荐）</div>
      <div class="geo-grid">
        <label>中心 经度<input type="number" id="geo-c-lng" step="0.00001" value="${midLng.toFixed(5)}"></label>
        <label>中心 纬度<input type="number" id="geo-c-lat" step="0.00001" value="${midLat.toFixed(5)}"></label>
        <label>实地宽度(米)<input type="number" id="geo-width" step="1" min="1" value="${curWM.toFixed(1)}" placeholder="例如 80"></label>
        <label>实地高度(米)<input type="number" id="geo-height" step="1" min="1" value="${curHM.toFixed(1)}" placeholder="按比例自动"></label>
      </div>
      <div id="geo-scale-readout" style="font-size:0.78rem;color:#8888aa;margin:8px 0;"></div>
      <button class="toolbar-btn primary" id="geo-apply-scale" style="width:100%;justify-content:center;">应用比例尺</button>
    </div>

    <button class="toolbar-btn" id="geo-calibrate" style="width:100%;justify-content:center;">📏 参考线标定（画一段已知长度的线）</button>

    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-panel);">
      <div style="font-size:0.78rem;color:#8888aa;margin-bottom:8px;">手动范围（高级）</div>
      <div class="geo-grid">
        <label>西北角 经度<input type="number" id="geo-nw-lng" step="0.00001" value="${gb.nw[0]}"></label>
        <label>西北角 纬度<input type="number" id="geo-nw-lat" step="0.00001" value="${gb.nw[1]}"></label>
        <label>东南角 经度<input type="number" id="geo-se-lng" step="0.00001" value="${gb.se[0]}"></label>
        <label>东南角 纬度<input type="number" id="geo-se-lat" step="0.00001" value="${gb.se[1]}"></label>
        <label>旋转角度(度)<input type="number" id="geo-rotation" step="0.5" value="${gb.rotation || 0}"></label>
      </div>
      <button class="toolbar-btn" id="geo-align" style="margin-top:12px;width:100%;justify-content:center;">🎯 在地图上对位（拖拽/缩放底图，所见即所得）</button>
      <button class="toolbar-btn" id="geo-pick" style="margin-top:6px;width:100%;justify-content:center;">🖱️ 点选两个角点（备用）</button>
      <div id="geo-distort" style="margin-top:10px;font-size:0.78rem;color:#8888aa;line-height:1.5;"></div>
    </div>

    <div class="actions">
      <button class="toolbar-btn" id="geo-default">恢复默认</button>
      <button class="toolbar-btn" id="geo-cancel">取消</button>
      <button class="toolbar-btn primary" id="geo-save">确定</button>
    </div></div>`;
  document.body.appendChild(overlay);
  const nwLng = overlay.querySelector('#geo-nw-lng'), nwLat = overlay.querySelector('#geo-nw-lat');
  const seLng = overlay.querySelector('#geo-se-lng'), seLat = overlay.querySelector('#geo-se-lat');
  const rotationEl = overlay.querySelector('#geo-rotation');
  const distortEl = overlay.querySelector('#geo-distort');
  const widthEl = overlay.querySelector('#geo-width');
  const heightEl = overlay.querySelector('#geo-height');
  const readoutEl = overlay.querySelector('#geo-scale-readout');

  function readBounds() {
    return {
      nw: [Number(nwLng.value), Number(nwLat.value)],
      se: [Number(seLng.value), Number(seLat.value)],
      rotation: Number(rotationEl.value) || 0,
    };
  }
  function updateDistortHint() {
    const { nw, se } = readBounds();
    if (nw.some(isNaN) || se.some(isNaN) || se[0] <= nw[0] || nw[1] <= se[1]) {
      distortEl.innerHTML = '⚠️ 经纬度范围无效';
      return;
    }
    const dLng = se[0] - nw[0], dLat = nw[1] - se[1];
    const mid = (nw[1] + se[1]) / 2;
    const groundAr = (dLng * Math.cos(mid * Math.PI / 180)) / dLat;
    const ratio = groundAr / imgAr;
    const pct = Math.abs(1 - ratio) * 100;
    if (pct < 1) distortEl.innerHTML = '✅ 经纬度跨度比与图片宽高比一致，无变形';
    else distortEl.innerHTML = `⚠️ 会拉伸变形约 <b>${pct.toFixed(0)}%</b>（地面宽高比 ${groundAr.toFixed(2)} vs 图片 ${imgAr.toFixed(2)}），建议点「应用比例尺」`;
  }
  // 真实尺寸：宽/高按图片比例联动
  function updateScaleReadout() {
    const wM = Number(widthEl.value), hM = Number(heightEl.value);
    if (isFinite(wM) && wM > 0 && isFinite(hM) && hM > 0) {
      const mpp = wM / imgW;
      readoutEl.innerHTML = `每像素 ≈ <b>${(mpp * 100).toFixed(2)} cm</b> · 整图 ≈ 宽 <b>${wM.toFixed(1)} m</b> × 高 <b>${hM.toFixed(1)} m</b>`;
    } else {
      readoutEl.innerHTML = '输入宽度或高度后自动计算比例尺';
    }
  }
  widthEl.addEventListener('input', () => {
    const wM = Number(widthEl.value);
    if (isFinite(wM) && wM > 0) heightEl.value = (wM / imgAr).toFixed(2);
    updateScaleReadout();
  });
  heightEl.addEventListener('input', () => {
    const hM = Number(heightEl.value);
    if (isFinite(hM) && hM > 0) widthEl.value = (hM * imgAr).toFixed(2);
    updateScaleReadout();
  });

  ['geo-nw-lng', 'geo-nw-lat', 'geo-se-lng', 'geo-se-lat'].forEach(id => {
    overlay.querySelector('#' + id).addEventListener('input', updateDistortHint);
  });

  // 应用比例尺：由 center + 宽度 → 等比 nw/se
  overlay.querySelector('#geo-apply-scale').onclick = () => {
    const clng = Number(overlay.querySelector('#geo-c-lng').value);
    const clat = Number(overlay.querySelector('#geo-c-lat').value);
    const wM = Number(widthEl.value) || (Number(heightEl.value) * imgAr);
    if ([clng, clat, wM].some(isNaN) || wM <= 0) { alert('请输入有效的中心与实地宽度/高度'); return; }
    const nb = boundsFromScale([clng, clat], wM / imgW, imgW, imgH, Number(rotationEl.value) || 0);
    nwLng.value = nb.nw[0]; nwLat.value = nb.nw[1]; seLng.value = nb.se[0]; seLat.value = nb.se[1];
    updateDistortHint();
  };

  // 参考线标定：关弹窗 → 画布上画两个点
  overlay.querySelector('#geo-calibrate').onclick = () => {
    overlay.remove();
    startCalibrate();
  };

  overlay.querySelector('#geo-align').onclick = () => {
    showGeoAlign(({ nw, se, rotation }) => {
      nwLng.value = nw[0]; nwLat.value = nw[1]; seLng.value = se[0]; seLat.value = se[1];
      rotationEl.value = rotation || 0;
      updateDistortHint();
    });
  };
  overlay.querySelector('#geo-pick').onclick = () => {
    showGeoPicker(({ nw, se }) => {
      // 点选两角：保持中心 + 宽度，高度按图片比例强制等比（避免拉伸变形）
      const center = [(nw[0] + se[0]) / 2, (nw[1] + se[1]) / 2];
      const { mpp } = scaleFromBounds({ nw, se }, imgW);
      const nb = boundsFromScale(center, mpp, imgW, imgH, Number(rotationEl.value) || 0);
      nwLng.value = nb.nw[0]; nwLat.value = nb.nw[1]; seLng.value = nb.se[0]; seLat.value = nb.se[1];
      updateDistortHint();
    });
  };
  overlay.querySelector('#geo-default').onclick = () => {
    const d = defaultGeoBounds();
    nwLng.value = d.nw[0]; nwLat.value = d.nw[1]; seLng.value = d.se[0]; seLat.value = d.se[1];
    rotationEl.value = 0;
    updateDistortHint();
  };
  overlay.querySelector('#geo-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#geo-save').onclick = () => {
    const nw = [Number(nwLng.value), Number(nwLat.value)];
    const se = [Number(seLng.value), Number(seLat.value)];
    if (nw.some(isNaN) || se.some(isNaN)) { alert('请输入有效经纬度'); return; }
    if (se[0] <= nw[0] || nw[1] <= se[1]) { alert('请确保东南角经度大于西北角经度、西北角纬度大于东南角纬度'); return; }
    const rotation = Number(rotationEl.value) || 0;
    // 归一化：始终存等比范围 + center + 每像素米数（宽度方向为准），保证旋转/比例正确、不变形
    const center = [(nw[0] + se[0]) / 2, (nw[1] + se[1]) / 2];
    const { mpp } = scaleFromBounds({ nw, se, rotation }, imgW);
    const nb = boundsFromScale(center, mpp, imgW, imgH, rotation);
    setState({ geoBounds: nb, geoBoundsExplicit: true });
    overlay.remove();
    showToast('✅ 地理范围与比例尺已设置');
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  updateDistortHint();
  updateScaleReadout();
}
