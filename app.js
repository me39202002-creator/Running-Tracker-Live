import { initializeApp } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-app.js";
import { getDatabase, ref, set, onValue, onDisconnect, remove } from "https://www.gstatic.com/firebasejs/10.5.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyDoNzC4Prw6LzkcEFvaCN7Qcrz1Hol7Img",
    authDomain: "running-gps-tracker-c78e6.firebaseapp.com",
    databaseURL: "https://running-gps-tracker-c78e6-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "running-gps-tracker-c78e6",
    storageBucket: "running-gps-tracker-c78e6.firebasestorage.app",
    messagingSenderId: "721138080520",
    appId: "1:721138080520:web:0ac52121dd9639413baabd"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// 處理房間 ID (從網址取得，若無則自動產生一個新的)
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room');
if (!roomId) {
    roomId = 'room_' + Math.random().toString(36).substring(2, 9);
}

const myName = prompt("請輸入您的跑者暱稱：", "KEN-LEE") || "匿名跑者";
const myId = 'runner_' + Math.random().toString(36).substring(2, 9);
// 資料庫路徑改為：rooms/房間代號/runners/跑者代號
const myRef = ref(db, `rooms/${roomId}/runners/${myId}`);

// 斷線時自動移除
onDisconnect(myRef).remove();

let map;
let partnerMarkers = {}; 
let watchId = null;
let sharingTimeout = null;

// UI 元素
const openShareBtn = document.getElementById('openShareBtn');
const shareModal = document.getElementById('shareModal');
const closeShareBtn = document.getElementById('closeShareBtn');
const startShareBtn = document.getElementById('startShareBtn');
const shareLinkInput = document.getElementById('shareLinkInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const activeShareBadge = document.getElementById('activeShareBadge');
const stopShareBtn = document.getElementById('stopShareBtn');

// 產生專屬分享連結
const currentUrl = new URL(window.location.href);
currentUrl.searchParams.set('room', roomId);
shareLinkInput.value = currentUrl.href;

// 介面操作綁定
openShareBtn.addEventListener('click', () => shareModal.classList.remove('hidden'));
closeShareBtn.addEventListener('click', () => shareModal.classList.add('hidden'));

copyLinkBtn.addEventListener('click', () => {
    shareLinkInput.select();
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
        const originalText = copyLinkBtn.innerText;
        copyLinkBtn.innerText = '已複製!';
        setTimeout(() => copyLinkBtn.innerText = originalText, 2000);
    });
});

startShareBtn.addEventListener('click', () => {
    const durationMinutes = parseInt(document.getElementById('shareDuration').value);
    startSharing(durationMinutes);
    shareModal.classList.add('hidden');
});

stopShareBtn.addEventListener('click', stopSharing);

window.initMap = function() {
    const initialCenter = { lat: 25.055, lng: 121.510 };
    map = new google.maps.Map(document.getElementById('map'), {
        zoom: 16, center: initialCenter, mapTypeId: 'roadmap', disableDefaultUI: true, zoomControl: true       
    });

    // 預設不分享，但可以下載房間內其他人的位置
    const roomRef = ref(db, `rooms/${roomId}/runners`);
    onValue(roomRef, (snapshot) => {
        const allRunnersData = snapshot.val() || {};
        updateMapMarkers(allRunnersData);
    });
};

// 開始分享位置
function startSharing(durationMinutes) {
    if (!("geolocation" in navigator)) {
        alert("你的裝置不支援 GPS");
        return;
    }

    // 若已經在追蹤，先清除
    if (watchId) navigator.geolocation.clearWatch(watchId);
    if (sharingTimeout) clearTimeout(sharingTimeout);

    activeShareBadge.classList.remove('hidden');

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            const currentLat = position.coords.latitude;
            const currentLng = position.coords.longitude;
            set(myRef, {
                name: myName, lat: currentLat, lng: currentLng, pace: '計算中...', timestamp: Date.now()
            });
            map.setCenter({ lat: currentLat, lng: currentLng });
        },
        (error) => console.error("GPS 失敗：", error.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    // 設定時效自動停止 (如果 duration > 0)
    if (durationMinutes > 0) {
        sharingTimeout = setTimeout(() => {
            stopSharing();
            alert("分享時間已到，已自動停止分享位置。");
        }, durationMinutes * 60 * 1000);
    }
}

// 停止分享位置
function stopSharing() {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (sharingTimeout) {
        clearTimeout(sharingTimeout);
        sharingTimeout = null;
    }
    remove(myRef); // 從雲端刪除自己的標記
    activeShareBadge.classList.add('hidden');
    alert("已停止分享位置。");
}

function updateMapMarkers(runnersData) {
    const activeIds = Object.keys(runnersData);
    for (let id in partnerMarkers) {
        if (!activeIds.includes(id)) {
            partnerMarkers[id].marker.setMap(null); 
            delete partnerMarkers[id];
        }
    }
    for (let id in runnersData) {
        createOrUpdateMarker(id, runnersData[id]);
    }
}

function createOrUpdateMarker(id, partner) {
    const position = { lat: partner.lat, lng: partner.lng };
    const infoContent = `
        <div class="p-2 min-w-[140px]">
            <h3 class="font-bold text-base text-gray-800 mb-1 border-b pb-1">
                ${escapeHTML(partner.name)} ${id === myId ? '<span class="text-xs text-red-500">(我)</span>' : ''}
            </h3>
            <div class="mt-2 space-y-1">
                <p class="text-sm text-gray-600">配速：<span class="font-semibold text-blue-600">${escapeHTML(partner.pace)} /km</span></p>
            </div>
        </div>
    `;
    if (partnerMarkers[id]) {
        partnerMarkers[id].marker.setPosition(position);
        partnerMarkers[id].infoWindow.setContent(infoContent);
    } else {
        const marker = new google.maps.Marker({ position: position, map: map, title: partner.name });
        const infoWindow = new google.maps.InfoWindow({ content: infoContent });
        infoWindow.open(map, marker);
        marker.addListener('click', () => infoWindow.open(map, marker));
        partnerMarkers[id] = { marker, infoWindow };
    }
}

function escapeHTML(str) {
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

function loadGoogleMaps() {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=AIzaSyDlZZObJLVB69jtS8wvlAHWEKgcZlEC63I&callback=initMap`;
    script.async = true; script.defer = true;
    document.head.appendChild(script);
}

loadGoogleMaps();