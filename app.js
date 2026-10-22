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
        distance: 0,
        pace: '計算中...',
        lastPosition: null 
    },
    gps: {
        watchId: null,
        timeoutId: null,
        lastSyncTime: 0,
        SYNC_INTERVAL_MS: 3000 
    },
    mapInstance: null,
    markers: {} 
};

// --- API 與純函數區塊 (Pure Functions) ---

// 替換為免金鑰、無 CORS 限制的 TinyURL API
// --- 透過 CORS Proxy 繞過瀏覽器限制並呼叫 TinyURL ---
async function generateShortUrl(longUrl) {
    try {
        const response = await fetch(`https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`);
        const data = await response.json();
        
        // 如果成功回傳，提取短網址
        if (data && data.shorturl) {
            return data.shorturl;
        }
        return longUrl; // 若失敗，自動退回長連結
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

// --- Firebase 初始化 ---
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

    // 點擊分享按鈕時，自動呼叫 TinyURL 轉短網址
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

    AppState.runner.distance = 0;
    AppState.runner.pace = '計算中...';
    AppState.runner.lastPosition = null;

    AppState.gps.watchId = navigator.geolocation.watchPosition(
        (position) => {
            const currentLat = position.coords.latitude;
            const currentLng = position.coords.longitude;
            const now = Date.now();

            if (AppState.runner.lastPosition) {
                const dist = calculateDistance(
                    AppState.runner.lastPosition.lat, AppState.runner.lastPosition.lng,
                    currentLat, currentLng
                );
                
                const timeDiffMins = (now - AppState.runner.lastPosition.timestamp) / 60000;

                if (dist > 0.001) {
                    AppState.runner.distance += dist;
                    const rawPace = timeDiffMins / dist;
                    
                    if (rawPace > 2.0 && rawPace < 50.0) {
                        AppState.runner.pace = formatPace(rawPace);
                    }
                    AppState.runner.lastPosition = { lat: currentLat, lng: currentLng, timestamp: now };
                } else if (timeDiffMins > 0.25) {
                    AppState.runner.pace = '靜止中...';
                    AppState.runner.lastPosition.timestamp = now;
                }
            } else {
                AppState.runner.lastPosition = { lat: currentLat, lng: currentLng, timestamp: now };
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

    const infoContent = `
        <div class="p-2 min-w-[140px]">
            <h3 class="font-bold text-base text-gray-800 mb-1 border-b pb-1">
                ${escapeHTML(partnerData.name)} ${isMe ? '<span class="text-xs text-red-500">(我)</span>' : ''}
            </h3>
            <div class="mt-2 space-y-1">
                <p class="text-sm text-gray-600 flex justify-between">
                    <span>里程：</span>
                    <span class="font-semibold text-green-600">${displayDistance} km</span>
                </p>
                <p class="text-sm text-gray-600 flex justify-between">
                    <span>配速：</span>
                    <span class="font-semibold text-blue-600">${escapeHTML(partnerData.pace || '計算中...')}</span>
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