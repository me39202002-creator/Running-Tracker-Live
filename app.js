console.log("app.js 初始化中...");

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-app.js";
import { getDatabase, ref, set, onChildAdded, onChildChanged, onChildRemoved, onDisconnect, remove } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyDoNzC4Prw6LzkcEFvaCN7Qcrz1Hol7Img",
    authDomain: "running-gps-tracker-c78e6.firebaseapp.com",
    databaseURL: "https://running-gps-tracker-c78e6-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "running-gps-tracker-c78e6",
    storageBucket: "running-gps-tracker-c78e6.firebasestorage.app",
    messagingSenderId: "721138080520",
    appId: "1:721138080520:web:0ac52121dd9639413baabd"
};

const AppState = {
    roomId: new URLSearchParams(window.location.search).get('room') || 'room_' + Math.random().toString(36).substring(2, 9),
    runner: {
        id: 'runner_' + Math.random().toString(36).substring(2, 9),
        name: '匿名跑者',
        iconUrl: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
        lat: null,
        lng: null,
        accuracy: null,
        distance: 0,
        pace: '定位中...',
        lastPosition: null 
    },
    gps: {
        watchId: null,
        timeoutId: null,
        wakeLock: null,
        lastSyncTime: 0,
        SYNC_INTERVAL_MS: 3000,
        MAX_ACCURACY_METERS: 25,
        MIN_DISTANCE_KM: 0.003,
        WINDOW_SIZE: 5,
        history: []
    },
    mapInstance: null,
    markers: {} 
};

async function generateShortUrl(longUrl) {
    try {
        const response = await fetch(`https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`);
        const data = await response.json();
        if (data && data.shorturl) {
            return data.shorturl;
        }
        return longUrl;
    } catch (error) {
        console.error("is.gd 短網址生成失敗：", error);
        return longUrl;
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function formatPace(paceInMinutes) {
    const mins = Math.floor(paceInMinutes);
    const secs = Math.floor((paceInMinutes - mins) * 60);
    return `${mins}'${secs.toString().padStart(2, '0')}"`;
}

function computeSmoothedPace(hardwareSpeed, history) {
    // 優先使用 GPS 晶片都卜勒速度 (單位: m/s)，大於 0.5 m/s (約 1.8 km/h) 視為移動中
    if (typeof hardwareSpeed === 'number' && hardwareSpeed >= 0.5) {
        const paceMins = (1000 / hardwareSpeed) / 60;
        if (paceMins >= 2.0 && paceMins <= 30.0) {
            return formatPace(paceMins);
        }
    }

    // 若瀏覽器未提供硬體速度，使用滑動視窗首尾座標計算平均配速
    if (history.length >= 2) {
        const oldest = history[0];
        const newest = history[history.length - 1];
        const totalDistKm = calculateDistance(oldest.lat, oldest.lng, newest.lat, newest.lng);
        const totalTimeMins = (newest.timestamp - oldest.timestamp) / 60000;

        if (totalDistKm > 0.005 && totalTimeMins > 0) {
            const windowPace = totalTimeMins / totalDistKm;
            if (windowPace >= 2.0 && windowPace <= 30.0) {
                return formatPace(windowPace);
            }
        }
    }
    return null;
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            AppState.gps.wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.warn("無法啟用螢幕常亮鎖：", err.message);
        }
    }
}

function releaseWakeLock() {
    if (AppState.gps.wakeLock) {
        AppState.gps.wakeLock.release();
        AppState.gps.wakeLock = null;
    }
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const myRunnerRef = ref(db, `rooms/${AppState.roomId}/runners/${AppState.runner.id}`);
const roomRunnersRef = ref(db, `rooms/${AppState.roomId}/runners`);

onDisconnect(myRunnerRef).remove();

const UI = {
    nameModal: document.getElementById('nameModal'),
    runnerNameInput: document.getElementById('runnerNameInput'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),
    iconSelect: document.getElementById('iconSelect'),
    openShareBtn: document.getElementById('openShareBtn'),
    shareModal: document.getElementById('shareModal'),
    closeShareBtn: document.getElementById('closeShareBtn'),
    startShareBtn: document.getElementById('startShareBtn'),
    shareDuration: document.getElementById('shareDuration'),
    shareLinkInput: document.getElementById('shareLinkInput'),
    copyLinkBtn: document.getElementById('copyLinkBtn'),
    activeShareBadge: document.getElementById('activeShareBadge'),
    stopShareBtn: document.getElementById('stopShareBtn')
};

function initApp() {
    bindEvents();
    loadGoogleMaps();
}

function bindEvents() {
    UI.joinRoomBtn.addEventListener('click', () => {
        const inputName = UI.runnerNameInput.value.trim();
        if (inputName) AppState.runner.name = inputName;
        UI.nameModal.classList.add('hidden');
    });

    UI.iconSelect.addEventListener('change', (e) => {
        AppState.runner.iconUrl = e.target.value;
        syncPositionToCloud(true); 
    });

    UI.openShareBtn.addEventListener('click', async () => {
        UI.shareModal.classList.remove('hidden');
        
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('room', AppState.roomId);
        const longUrl = currentUrl.href;

        UI.shareLinkInput.value = "正在產生短網址...";
        const shortUrl = await generateShortUrl(longUrl);
        UI.shareLinkInput.value = shortUrl;
    });

    UI.closeShareBtn.addEventListener('click', () => UI.shareModal.classList.add('hidden'));

    UI.copyLinkBtn.addEventListener('click', () => {
        UI.shareLinkInput.select();
        navigator.clipboard.writeText(UI.shareLinkInput.value).then(() => {
            const originalText = UI.copyLinkBtn.innerText;
            UI.copyLinkBtn.innerText = '已複製!';
            setTimeout(() => UI.copyLinkBtn.innerText = originalText, 2000);
        });
    });

    UI.startShareBtn.addEventListener('click', () => {
        startSharing(parseInt(UI.shareDuration.value));
        UI.shareModal.classList.add('hidden');
    });

    UI.stopShareBtn.addEventListener('click', stopSharing);
}

function startSharing(durationMinutes) {
    if (!("geolocation" in navigator)) {
        alert("你的裝置不支援 GPS");
        return;
    }

    stopSharing(); 
    UI.activeShareBadge.classList.remove('hidden');
    requestWakeLock();

    AppState.runner.distance = 0;
    AppState.runner.pace = '定位中...';
    AppState.runner.lastPosition = null;
    AppState.gps.history = [];

    AppState.gps.watchId = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude: currentLat, longitude: currentLng, accuracy, speed } = position.coords;
            const now = Date.now();

            // 邊界過濾：丟棄誤差半徑超過 25 公尺的粗略定位訊號
            if (accuracy > AppState.gps.MAX_ACCURACY_METERS) {
                console.warn(`略過低精度訊號: 誤差 ${Math.round(accuracy)}m`);
                return;
            }

            AppState.runner.accuracy = Math.round(accuracy);

            if (AppState.runner.lastPosition) {
                const dist = calculateDistance(
                    AppState.runner.lastPosition.lat, AppState.runner.lastPosition.lng,
                    currentLat, currentLng
                );
                const timeDiffSec = (now - AppState.runner.lastPosition.timestamp) / 1000;

                // 動態防漂移：移動距離需大於 3 公尺，且大於當前誤差半徑的 20%
                const minValidDistKm = Math.max(AppState.gps.MIN_DISTANCE_KM, (accuracy * 0.2) / 1000);

                if (dist >= minValidDistKm) {
                    AppState.runner.distance += dist;
                    AppState.runner.lastPosition = { lat: currentLat, lng: currentLng, timestamp: now };

                    AppState.gps.history.push({ lat: currentLat, lng: currentLng, timestamp: now });
                    if (AppState.gps.history.length > AppState.gps.WINDOW_SIZE) {
                        AppState.gps.history.shift();
                    }

                    const smoothedPace = computeSmoothedPace(speed, AppState.gps.history);
                    if (smoothedPace) {
                        AppState.runner.pace = smoothedPace;
                    }
                } else if (timeDiffSec > 12) {
                    AppState.runner.pace = '靜止中';
                    AppState.runner.lastPosition.timestamp = now;
                    AppState.gps.history = [{ lat: currentLat, lng: currentLng, timestamp: now }];
                }
            } else {
                AppState.runner.lastPosition = { lat: currentLat, lng: currentLng, timestamp: now };
                AppState.gps.history.push({ lat: currentLat, lng: currentLng, timestamp: now });
                AppState.runner.pace = '準備起跑';
            }

            AppState.runner.lat = currentLat;
            AppState.runner.lng = currentLng;
            
            if (AppState.mapInstance) {
                AppState.mapInstance.setCenter({ lat: currentLat, lng: currentLng });
            }
            syncPositionToCloud();
        },
        (error) => console.error("GPS 失敗：", error.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    if (durationMinutes > 0) {
        AppState.gps.timeoutId = setTimeout(() => {
            stopSharing();
            alert("分享時間已到，已自動停止分享位置。");
        }, durationMinutes * 60 * 1000);
    }
}

function stopSharing() {
    if (AppState.gps.watchId) {
        navigator.geolocation.clearWatch(AppState.gps.watchId);
        AppState.gps.watchId = null;
    }
    if (AppState.gps.timeoutId) {
        clearTimeout(AppState.gps.timeoutId);
        AppState.gps.timeoutId = null;
    }
    releaseWakeLock();
    remove(myRunnerRef); 
    UI.activeShareBadge.classList.add('hidden');
}

function syncPositionToCloud(force = false) {
    if (!AppState.runner.lat || !AppState.runner.lng) return;

    const now = Date.now();
    if (!force && (now - AppState.gps.lastSyncTime < AppState.gps.SYNC_INTERVAL_MS)) {
        return; 
    }

    AppState.gps.lastSyncTime = now;
    set(myRunnerRef, {
        name: AppState.runner.name,
        lat: AppState.runner.lat,
        lng: AppState.runner.lng,
        accuracy: AppState.runner.accuracy,
        pace: AppState.runner.pace,
        distance: AppState.runner.distance,
        iconUrl: AppState.runner.iconUrl,
        timestamp: now
    });
}

window.initMap = function() {
    AppState.mapInstance = new google.maps.Map(document.getElementById('map'), {
        zoom: 16, 
        center: { lat: 25.055, lng: 121.510 }, 
        mapTypeId: 'roadmap', 
        disableDefaultUI: true, 
        zoomControl: true       
    });

    onChildAdded(roomRunnersRef, (snapshot) => {
        createOrUpdateMarker(snapshot.key, snapshot.val());
    });

    onChildChanged(roomRunnersRef, (snapshot) => {
        createOrUpdateMarker(snapshot.key, snapshot.val());
    });

    onChildRemoved(roomRunnersRef, (snapshot) => {
        const id = snapshot.key;
        if (AppState.markers[id]) {
            AppState.markers[id].marker.setMap(null);
            delete AppState.markers[id];
        }
    });
};

function createOrUpdateMarker(id, partnerData) {
    const position = { lat: partnerData.lat, lng: partnerData.lng };
    const markerIcon = partnerData.iconUrl || 'https://maps.google.com/mapfiles/ms/icons/red-dot.png';
    const isMe = id === AppState.runner.id;
    const displayDistance = partnerData.distance ? partnerData.distance.toFixed(2) : "0.00";
    const accuracyText = partnerData.accuracy ? `±${partnerData.accuracy}m` : '';

    const infoContent = `
        <div class="p-2 min-w-[150px]">
            <h3 class="font-bold text-base text-gray-800 mb-1 border-b pb-1 flex justify-between items-center">
                <span>${escapeHTML(partnerData.name)} ${isMe ? '<span class="text-xs text-red-500">(我)</span>' : ''}</span>
                <span class="text-[10px] text-gray-400 font-normal">${escapeHTML(accuracyText)}</span>
            </h3>
            <div class="mt-2 space-y-1">
                <p class="text-sm text-gray-600 flex justify-between">
                    <span>里程：</span>
                    <span class="font-semibold text-green-600">${displayDistance} km</span>
                </p>
                <p class="text-sm text-gray-600 flex justify-between">
                    <span>配速：</span>
                    <span class="font-semibold text-blue-600">${escapeHTML(partnerData.pace || '定位中...')}</span>
                </p>
            </div>
        </div>
    `;

    if (AppState.markers[id]) {
        AppState.markers[id].marker.setPosition(position);
        AppState.markers[id].marker.setIcon(markerIcon);
        AppState.markers[id].infoWindow.setContent(infoContent);
    } else {
        const marker = new google.maps.Marker({ 
            position, 
            map: AppState.mapInstance, 
            title: partnerData.name,
            icon: markerIcon
        });
        const infoWindow = new google.maps.InfoWindow({ content: infoContent });
        
        infoWindow.open(AppState.mapInstance, marker);
        marker.addListener('click', () => infoWindow.open(AppState.mapInstance, marker));
        
        AppState.markers[id] = { marker, infoWindow };
    }
}

function escapeHTML(str) {
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

function loadGoogleMaps() {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=AIzaSyDlZZObJLVB69jtS8wvlAHWEKgcZlEC63I&callback=initMap`;
    script.async = true; 
    script.defer = true;
    document.head.appendChild(script);
}

initApp();