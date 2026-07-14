// Small header button that lets users turn on / off push notifications
// for the current device. Phone, laptop, desktop — each device gets
// its own subscription. Mam can also click "Test" to verify.

import { useState, useEffect } from 'react';
import { FiBell, FiBellOff } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../api';
import { pushSupported, enablePushNotifications, disablePushNotifications, getPermissionState } from '../lib/push';

export default function EnablePushButton() {
  const [state, setState] = useState('loading'); // loading | unsupported | denied | off | on
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    if (!pushSupported()) { setState('unsupported'); return; }
    const perm = await getPermissionState();
    if (perm === 'denied') { setState('denied'); return; }
    // Check if a subscription exists for this device
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      setState(sub && perm === 'granted' ? 'on' : 'off');
    } catch {
      setState('off');
    }
  };

  useEffect(() => { refresh(); }, []);

  const turnOn = async () => {
    const r = await enablePushNotifications();
    if (r.ok) {
      toast.success('Push notifications enabled on this device');
      refresh();
    } else if (r.reason === 'permission_denied') {
      toast.error('You blocked notifications. Open browser settings → Site Settings → Notifications → Allow.', { duration: 6000 });
      setState('denied');
    } else {
      toast.error(`Failed: ${r.reason}${r.error ? ` (${r.error})` : ''}`, { duration: 6000 });
    }
  };

  const turnOff = async () => {
    await disablePushNotifications();
    toast.success('Push disabled on this device');
    refresh();
  };

  const test = async () => {
    try {
      const r = await api.post('/push/test', { message: 'Test from Sotyn.Headmasters — your devices are connected ✓' });
      toast.success(`Sent — ${r.data.sent} of ${r.data.total} devices`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  if (state === 'loading') return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`p-2 rounded-lg hover:bg-gray-100 flex-shrink-0 ${state === 'on' ? 'text-emerald-600' : 'text-gray-500'}`}
        title={state === 'on' ? 'Push ON for this device' : 'Push OFF — click to enable'}
        aria-label={state === 'on' ? 'Push notifications on — manage' : 'Push notifications off — enable'}
      >
        {state === 'on' ? <FiBell size={20} /> : <FiBellOff size={20} />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-72 bg-white border rounded-lg shadow-lg z-40 p-3 text-sm">
            <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-2">
              <FiBell className="text-blue-600" /> Push Notifications
            </h4>
            {state === 'unsupported' && (
              <p className="text-xs text-amber-700">This browser doesn't support push notifications. Try Chrome / Edge / Firefox / Safari 16.4+.</p>
            )}
            {state === 'denied' && (
              <p className="text-xs text-red-700">Permission was blocked. Open browser site settings → Notifications → Allow, then refresh.</p>
            )}
            {state === 'off' && (
              <>
                <p className="text-xs text-gray-600 mb-2">Get instant alerts on this device when delegations, payments, tickets, scorecard updates and announcements happen.</p>
                <button onClick={turnOn} className="btn btn-primary w-full text-sm">Enable on this device</button>
              </>
            )}
            {state === 'on' && (
              <>
                <p className="text-xs text-emerald-700 mb-2">✓ Active on this device. You'll get alerts even when the Sotyn.Headmasters tab is closed.</p>
                <div className="flex gap-2">
                  <button onClick={test} className="btn btn-secondary flex-1 text-xs">Send Test</button>
                  <button onClick={turnOff} className="btn btn-danger flex-1 text-xs">Disable</button>
                </div>
              </>
            )}
            <p className="text-[10px] text-gray-400 mt-2 border-t pt-2">Each device (phone, laptop, desktop) needs to be enabled separately.</p>
          </div>
        </>
      )}
    </div>
  );
}
