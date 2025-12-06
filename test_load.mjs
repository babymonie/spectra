import exclusive from './exclusiveAudio.js';

(async () => {
  try {
    console.log('isSupported:', exclusive.isSupported ? exclusive.isSupported() : false);
    const devs = exclusive.getDevices ? exclusive.getDevices() : [];
    console.log('devices count:', Array.isArray(devs) ? devs.length : typeof devs);
    console.log('devices sample:', devs && devs.length ? devs.slice(0,3) : devs);
  } catch (e) {
    console.error('Error loading exclusiveAudio:', e);
    process.exitCode = 2;
  }
})();
