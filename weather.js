// ========================================================
// weather.js — 天气预报：AMap.Weather 插件（实时 + 3 天预报），右上角面板
// 城市默认「成都市」，可在 config.json 的 weather.city 覆盖
// ========================================================

export function initWeather() {
    const panel = document.getElementById('weather-panel');
    if (!panel) return;
    const deg = (t) => String(t == null ? '--' : t).replace('℃', '').replace('°', '');
    const emoji = (w) => {
        const s = (w || '');
        if (s.includes('雪')) return '❄️';
        if (s.includes('雷')) return '⛈️';
        if (s.includes('雨')) return '🌧️';
        if (s.includes('雾') || s.includes('霾')) return '🌫️';
        if (s.includes('阴')) return '☁️';
        if (s.includes('云')) return '⛅';
        if (s.includes('晴')) return '☀️';
        return '🌤️';
    };
    let live = null;      // QWeather /v7/weather/now 的 now 对象
    let forecasts = [];   // QWeather /v7/weather/3d 的 daily 数组
    function render() {
        if (!live && forecasts.length === 0) { panel.style.display = 'none'; return; }
        let head, detail;
        if (live) {
            head = '<div class="w-head"><span class="w-emoji">' + emoji(live.text) + '</span>' +
                   '<span class="w-temp">' + deg(live.temp) + '°</span>' +
                   '<span class="w-cond">' + (live.text || '') + '</span></div>';
        } else {
            head = '<div class="w-head"><span class="w-emoji">🌤️</span><span class="w-cond">场馆天气</span></div>';
        }
        let inner = '';
        if (live) {
            inner += '<div class="w-city">📍 场馆实时</div>' +
                     '<div class="w-meta">' + (live.windDir || '') + ' ' + (live.windScale || '') + '级 · 湿度 ' + (live.humidity || '--') + '%</div>';
        }
        let fc = '';
        forecasts.forEach(f => {
            fc += '<div class="w-frow"><span class="w-fdate">' + (f.fxDate || '').slice(5) + '</span>' +
                  '<span class="w-fcond">' + emoji(f.textDay) + ' ' + (f.textDay || '') + '</span>' +
                  '<span class="w-ftemp">' + deg(f.tempMin) + '~' + deg(f.tempMax) + '°</span></div>';
        });
        if (fc) inner += '<div class="w-forecast">' + fc + '</div>';
        if (inner) detail = '<div class="w-detail">' + inner + '</div>';
        else detail = '';
        panel.innerHTML = head + detail;
        panel.style.display = 'block';
    }
    // 服务端代理和风天气 QWeather（key 只在 .env，前端不接触）
    async function load() {
        try {
            const [nowRes, fcRes] = await Promise.all([
                fetch('/api/weather?type=now', { cache: 'no-store' }),
                fetch('/api/weather?type=3d', { cache: 'no-store' }),
            ]);
            const nowJson = await nowRes.json();
            const fcJson = await fcRes.json();
            if (nowJson && nowJson.code === '200' && nowJson.now) live = nowJson.now;
            else console.warn('⚠️ 天气实时数据获取失败', nowJson);
            if (fcJson && fcJson.code === '200' && fcJson.daily) forecasts = fcJson.daily.slice(0, 3);
            else console.warn('⚠️ 天气预报数据获取失败', fcJson);
        } catch (err) {
            console.warn('⚠️ 天气请求失败', err.message);
        }
        render();
    }
    load();
    setInterval(load, 30 * 60 * 1000);   // 每 30 分钟刷新一次
    panel.addEventListener('click', () => panel.classList.toggle('expanded'));
}
