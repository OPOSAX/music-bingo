'use strict';

// Recorte de app/src/config.template.js de B-Talk: solo lo que necesita el SFU del modo concierto.

const os = require('os');

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vnet|vEthernet|vboxnet|VirtualBox|VMware|vmnet|tap|tun|wg|zt|tailscale|utun|awdl|llw|bridge|Loopback|Pseudo-Interface|WSL|Hyper-V)/i;

function subnetRank(ip) {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
}

function listIPv4Candidates() {
    const ifaces = os.networkInterfaces();
    const out = [];
    for (const name in ifaces) {
        if (VIRTUAL_IFACE.test(name)) continue;
        for (const { address, family, internal } of ifaces[name]) {
            if (internal || family !== 'IPv4') continue;
            out.push({ iface: name, address, rank: subnetRank(address) });
        }
    }
    out.sort((a, b) => a.rank - b.rank);
    return out;
}

function getIPv4() {
    const candidates = listIPv4Candidates();
    if (candidates.length > 0) return candidates[0].address;
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
        for (const { address, family, internal } of ifaces[name]) {
            if (family === 'IPv4' && !internal) return address;
        }
    }
    return '0.0.0.0';
}

// BTALK_ANNOUNCED_IP: IP que mediasoup anuncia como candidato ICE. Obligatoria en Docker bridge y en VPS con NAT.
const IPv4 = process.env.BTALK_ANNOUNCED_IP || getIPv4();
const numWorkers = Number(process.env.MEDIASOUP_WORKERS) || Math.min(os.cpus().length, 4);
const rtcMinPort = Number(process.env.RTC_MIN_PORT) || 40000;
const rtcMaxPort = Number(process.env.RTC_MAX_PORT) || 40100;

module.exports = {
    console: {
        timeZone: process.env.TZ || 'UTC',
        debug: process.env.NODE_ENV !== 'production' || process.env.DEBUG === 'true',
        colors: process.env.NO_COLOR ? false : true,
    },
    announcedAddress: IPv4,
    listIPv4Candidates,
    mediasoup: {
        numWorkers,
        worker: {
            logLevel: 'error',
            logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'rtx', 'bwe', 'score', 'sctp'],
            rtcMinPort,
            rtcMaxPort,
        },
        router: {
            // Sin observador de nivel: el nivel lo mide el motor de audio del DJ.
            audioLevelObserverEnabled: false,
            activeSpeakerObserverEnabled: false,
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
            ],
        },
        webRtcServerActive: false,
        webRtcServerOptions: { listenInfos: [] },
        webRtcTransport: {
            listenInfos: [
                { protocol: 'udp', ip: '0.0.0.0', announcedAddress: IPv4, portRange: { min: rtcMinPort, max: rtcMaxPort } },
                { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: IPv4, portRange: { min: rtcMinPort, max: rtcMaxPort } },
            ],
            initialAvailableOutgoingBitrate: 600000,
            minimumAvailableOutgoingBitrate: 300000,
            maxSctpMessageSize: 262144,
            maxIncomingBitrate: 256000,
        },
    },
};
