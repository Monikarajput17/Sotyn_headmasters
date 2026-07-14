// Client-side push notification helper. Registers the service worker,
// asks for browser permission, subscribes to push, and sends the
// subscription to the backend. Auto-runs on login.

import api from '../api';

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('SW register failed:', err);
    return null;
  }
}

export async function getPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

export async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  const r = await Notification.requestPermission();
  return r;
}

// Top-level entry point: register SW, request permission if needed,
// subscribe, send to backend. Returns { ok, reason }.
export async function enablePushNotifications(deviceLabel) {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: 'sw_register_failed' };
  // Wait for SW to be ready (active worker controlling the page)
  await navigator.serviceWorker.ready;

  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'permission_denied' };

  // Get VAPID public key
  let publicKey;
  try {
    const r = await api.get('/push/vapid');
    publicKey = r.data.publicKey;
  } catch (err) {
    return { ok: false, reason: 'vapid_fetch_failed' };
  }
  if (!publicKey) return { ok: false, reason: 'no_vapid_key' };

  // Subscribe via PushManager
  let sub;
  try {
    // Re-use existing subscription if any
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
  } catch (err) {
    return { ok: false, reason: 'subscribe_failed', error: err.message };
  }

  const json = sub.toJSON();
  try {
    await api.post('/push/subscribe', {
      endpoint: json.endpoint,
      keys: json.keys,
      device_label: deviceLabel || guessDeviceLabel(),
    });
  } catch (err) {
    return { ok: false, reason: 'backend_save_failed', error: err.response?.data?.error || err.message };
  }

  return { ok: true, endpoint: json.endpoint };
}

export async function disablePushNotifications() {
  if (!('serviceWorker' in navigator)) return { ok: false };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { ok: true };
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true };
  try {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
  } catch {}
  await sub.unsubscribe();
  return { ok: true };
}

function guessDeviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone / iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

// Ensure SW handles 'navigate' messages it receives from notificationclick
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) {
      try {
        window.location.assign(e.data.url);
      } catch {}
    }
  });
}
