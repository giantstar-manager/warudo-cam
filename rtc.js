(function attachRTC(globalScope) {
  'use strict';

  var ICE_TIMEOUT_MS = 10000;
  var ICE_RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
  var MAX_ICE_RESTARTS = 5;
  var MAX_RECONNECT_CYCLES = 3;
  var DEFAULT_BITRATE = 12000000;
  var MIN_BITRATE = 8000000;
  var DEFAULT_CODEC = 'vp9';
  var DEFAULT_STATS_INTERVAL_MS = 2000;
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:YOUR_TURN_SERVER:443?transport=tcp', username: 'TURN_USER', credential: 'TURN_PASS' }
  ];

  var peer = null;
  var localStream = null;
  var remoteStream = null;
  var callerMode = false;
  var restartCount = 0;
  var restartTimer = null;
  var reconnectCount = 0;
  var reconnectInProgress = false;
  var lastRemoteDescription = null;
  var rtcConfig = {
    codec: DEFAULT_CODEC,
    bitrate: DEFAULT_BITRATE
  };
  var stateCallbacks = [];
  var remoteTrackCallbacks = [];
  var reconnectCallbacks = [];
  var reconnectFailedCallbacks = [];
  var statsCallbacks = [];
  var statsTimer = null;
  var statsPrev = null;
  var statsIntervalMs = DEFAULT_STATS_INTERVAL_MS;

  function requirePeer() {
    if (!peer) throw new Error('Peer connection is not created. Call createPeer() first.');
  }

  function cloneDescription(description) {
    if (!description || !description.type || !description.sdp) return null;
    return { type: description.type, sdp: description.sdp };
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function emitCallbacks(list, payload) {
    for (var i = 0; i < list.length; i += 1) {
      try {
        list[i](payload);
      } catch (err) {
        setTimeout(function crash() { throw err; }, 0);
      }
    }
  }

  function setTrackHint(track) {
    if (!track || track.kind !== 'video') return;
    try { track.contentHint = 'detail'; } catch (_ignore) {}
  }

  function applyTrackHints(stream) {
    if (!stream || !stream.getVideoTracks) return;
    var tracks = stream.getVideoTracks();
    for (var i = 0; i < tracks.length; i += 1) setTrackHint(tracks[i]);
  }

  function addLocalTracks(pc, stream) {
    if (!pc || !stream || !stream.getVideoTracks) return;
    var tracks = stream.getVideoTracks();
    for (var i = 0; i < tracks.length; i += 1) {
      setTrackHint(tracks[i]);
      pc.addTrack(tracks[i], stream);
    }
  }

  function teardownPeer(stopPeerTracks) {
    clearRestartTimer();
    if (!peer) return;

    if (stopPeerTracks) {
      var senders = peer.getSenders();
      for (var i = 0; i < senders.length; i += 1) {
        if (senders[i].track) senders[i].track.stop();
      }

      var receivers = peer.getReceivers();
      for (var r = 0; r < receivers.length; r += 1) {
        if (receivers[r].track) receivers[r].track.stop();
      }
    }

    peer.close();
    peer = null;
  }

  function codecRank(codec, codecName) {
    if (!codec || !codec.mimeType) return 0;
    var mimeType = codec.mimeType.toLowerCase();
    var fmtp = (codec.sdpFmtpLine || '').toLowerCase();

    if (codecName === 'h264' && mimeType.indexOf('video/h264') === 0) {
      var rank = 100;
      if (fmtp.indexOf('profile-level-id=640033') !== -1) rank += 40;
      else if (fmtp.indexOf('profile-level-id=6400') !== -1) rank += 30;
      else if (fmtp.indexOf('profile-level-id=4d') !== -1) rank += 10;
      return rank;
    }

    if (codecName === 'vp9' && mimeType.indexOf('video/vp9') === 0) {
      var vp9Rank = 100;
      if (fmtp.indexOf('profile-id=0') !== -1) vp9Rank += 40;
      else if (fmtp.indexOf('profile-id=2') !== -1) vp9Rank -= 20;
      else if (!fmtp) vp9Rank += 30;
      return vp9Rank;
    }

    return 0;
  }

  function getOrderedCodecs(codecName) {
    if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return null;
    var caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !caps.codecs || !caps.codecs.length) return null;

    var target = String(codecName || DEFAULT_CODEC).toLowerCase();
    var preferred = [];
    var others = [];

    for (var i = 0; i < caps.codecs.length; i += 1) {
      var codec = caps.codecs[i];
      if (!codec || !codec.mimeType) {
        others.push(codec);
        continue;
      }

      var mimeType = codec.mimeType.toLowerCase();
      var isTarget = (target === 'h264' && mimeType.indexOf('video/h264') === 0) || (target === 'vp9' && mimeType.indexOf('video/vp9') === 0);
      if (isTarget) preferred.push(codec);
      else others.push(codec);
    }

    if (!preferred.length) return null;

    preferred.sort(function byRank(a, b) {
      return codecRank(b, target) - codecRank(a, target);
    });

    return preferred.concat(others);
  }

  function applyCodecPreference(pc) {
    if (!pc) return false;
    var ordered = getOrderedCodecs(rtcConfig.codec);
    if (!ordered) return false;

    var transceivers = pc.getTransceivers();
    var applied = false;
    for (var i = 0; i < transceivers.length; i += 1) {
      var tr = transceivers[i];
      if (!tr || typeof tr.setCodecPreferences !== 'function') continue;

      var senderVideo = !!(tr.sender && tr.sender.track && tr.sender.track.kind === 'video');
      var receiverVideo = !!(tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video');
      if (!senderVideo && !receiverVideo && tr.mid !== null) continue;

      try {
        tr.setCodecPreferences(ordered);
        applied = true;
      } catch (_ignore) {}
    }

    return applied;
  }

  async function applySenderParameters(pc) {
    if (!pc) return;
    var senders = pc.getSenders();
    var maxBitrate = rtcConfig.bitrate;
    var minBitrate = MIN_BITRATE;
    if (maxBitrate < minBitrate) maxBitrate = minBitrate;

    for (var i = 0; i < senders.length; i += 1) {
      var sender = senders[i];
      if (!sender || !sender.track || sender.track.kind !== 'video') continue;

      setTrackHint(sender.track);

      if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') continue;

      try {
        var params = sender.getParameters() || {};
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];

        for (var e = 0; e < params.encodings.length; e += 1) {
          if (!params.encodings[e]) params.encodings[e] = {};
          params.encodings[e].maxBitrate = maxBitrate;
          params.encodings[e].minBitrate = minBitrate;
          params.encodings[e].degradationPreference = 'maintain-resolution';
        }

        params.degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
      } catch (_ignore) {}
    }
  }

  async function applyMediaTuning(pc) {
    applyCodecPreference(pc);
    await applySenderParameters(pc);
  }

  function normalizeState() {
    if (!peer) return 'closed';
    var cs = peer.connectionState;
    if (cs === 'new' || cs === 'connecting' || cs === 'connected' || cs === 'disconnected' || cs === 'failed' || cs === 'closed') {
      return cs;
    }
    var ice = peer.iceConnectionState;
    if (ice === 'checking') return 'connecting';
    if (ice === 'connected' || ice === 'completed') return 'connected';
    if (ice === 'disconnected') return 'disconnected';
    if (ice === 'failed') return 'failed';
    if (ice === 'closed') return 'closed';
    return 'new';
  }

  function emitState(state) {
    emitCallbacks(stateCallbacks, state);
  }

  function scheduleIceRestart() {
    if (!peer || restartTimer || restartCount >= MAX_ICE_RESTARTS) return;

    var thisPeer = peer;
    var attempt = restartCount;
    var delay = ICE_RESTART_BACKOFF_MS[attempt] || ICE_RESTART_BACKOFF_MS[ICE_RESTART_BACKOFF_MS.length - 1];
    restartCount += 1;

    restartTimer = setTimeout(function restartLater() {
      restartTimer = null;
      if (!peer || thisPeer !== peer) return;

      try {
        peer.restartIce();
      } catch (_ignore) {}

      applyMediaTuning(peer);
    }, delay);
  }

  async function rebuildPeerFromRemoteDescription() {
    var description = cloneDescription(lastRemoteDescription);
    if (!description) throw new Error('No remote SDP available for reconnect.');

    teardownPeer(false);
    remoteStream = new MediaStream();
    peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    wirePeerEvents();

    if (localStream) addLocalTracks(peer, localStream);
    applyCodecPreference(peer);

    if (description.type === 'offer') {
      await peer.setRemoteDescription(description);
      applyCodecPreference(peer);
      var answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      applyCodecPreference(peer);
      await waitForIce(peer, ICE_TIMEOUT_MS);
    } else if (description.type === 'answer') {
      var offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
      applyCodecPreference(peer);
      await waitForIce(peer, ICE_TIMEOUT_MS);
      await peer.setRemoteDescription(description);
    } else {
      throw new Error('Unsupported remote SDP type: ' + description.type);
    }

    await applySenderParameters(peer);
  }

  function emitReconnect(payload) {
    emitCallbacks(reconnectCallbacks, payload);
  }

  function emitReconnectFailed(payload) {
    emitCallbacks(reconnectFailedCallbacks, payload);
  }

  function triggerReconnect(reason) {
    if (reconnectInProgress) return;
    if (reconnectCount >= MAX_RECONNECT_CYCLES) {
      emitReconnectFailed({ attempts: reconnectCount, reason: reason || 'failed' });
      return;
    }

    reconnectInProgress = true;
    reconnectCount += 1;
    var attempt = reconnectCount;
    emitReconnect({ attempt: attempt, maxAttempts: MAX_RECONNECT_CYCLES, reason: reason || 'failed' });

    rebuildPeerFromRemoteDescription().then(function onOk() {
      reconnectInProgress = false;
      applyMediaTuning(peer);
    }).catch(function onFail(err) {
      reconnectInProgress = false;
      if (reconnectCount >= MAX_RECONNECT_CYCLES) {
        emitReconnectFailed({ attempts: reconnectCount, reason: reason || 'failed', error: String(err && err.message ? err.message : err) });
        return;
      }

      var delay = ICE_RESTART_BACKOFF_MS[Math.min(attempt - 1, ICE_RESTART_BACKOFF_MS.length - 1)] || 1000;
      setTimeout(function retryReconnect() {
        triggerReconnect(reason || 'failed');
      }, delay);
    });
  }

  function updateState() {
    var state = normalizeState();
    emitState(state);

    if (state === 'connected') {
      restartCount = 0;
      reconnectCount = 0;
      reconnectInProgress = false;
      clearRestartTimer();
      applyMediaTuning(peer);
      return;
    }

    if (state === 'disconnected' || state === 'failed') {
      if (restartCount < MAX_ICE_RESTARTS) {
        scheduleIceRestart();
      } else if (state === 'failed') {
        triggerReconnect('failed');
      }
    }
  }

  function wirePeerEvents() {
    if (!peer) return;

    var thisPeer = peer;
    function onStateEvent() {
      if (!peer || thisPeer !== peer) return;
      updateState();
    }

    peer.addEventListener('connectionstatechange', onStateEvent);
    peer.addEventListener('iceconnectionstatechange', onStateEvent);
    peer.addEventListener('track', function onTrack(event) {
      if (!peer || thisPeer !== peer) return;
      if (!event.track || event.track.kind !== 'video') return;
      if (event.streams && event.streams[0]) {
        remoteStream = event.streams[0];
      } else {
        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
      }
      emitCallbacks(remoteTrackCallbacks, [remoteStream, event.track, event]);
    });
  }

  function waitForIce(pc, timeoutMs) {
    return new Promise(function resolveWhenReady(resolve) {
      if (!pc) return resolve('');
      if (pc.iceGatheringState === 'complete') return resolve((pc.localDescription && pc.localDescription.sdp) || '');

      var done = false;
      var timer = null;

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onGathering);
        pc.removeEventListener('icecandidate', onCandidate);
        resolve((pc.localDescription && pc.localDescription.sdp) || '');
      }

      function onGathering() {
        if (pc.iceGatheringState === 'complete') finish();
      }

      function onCandidate(event) {
        if (!event.candidate) finish();
      }

      timer = setTimeout(finish, timeoutMs);
      pc.addEventListener('icegatheringstatechange', onGathering);
      pc.addEventListener('icecandidate', onCandidate);
    });
  }

  async function listCameras() {
    var devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(function isVideoInput(device) { return device.kind === 'videoinput'; })
      .map(function asSimple(device) { return { deviceId: device.deviceId, label: device.label || '' }; });
  }

  async function getCameraWithConstraints(constraints) {
    var stream = await navigator.mediaDevices.getUserMedia(constraints);
    applyTrackHints(stream);
    return stream;
  }

  async function getCamera(deviceId) {
    var exactConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { exact: 1920 },
        height: { exact: 1080 },
        frameRate: { exact: 30 }
      },
      audio: false
    };

    var idealConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    };

    try {
      return await getCameraWithConstraints(exactConstraints);
    } catch (_ignore) {
      return getCameraWithConstraints(idealConstraints);
    }
  }

  function createPeer(isCaller, stream) {
    if (peer) close();

    callerMode = !!isCaller;
    peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream = stream || null;
    remoteStream = new MediaStream();
    restartCount = 0;
    reconnectCount = 0;
    reconnectInProgress = false;
    clearRestartTimer();
    wirePeerEvents();

    applyTrackHints(localStream);
    if (callerMode && localStream) {
      addLocalTracks(peer, localStream);
    }

    applyMediaTuning(peer);
    emitState('new');
    return peer;
  }

  async function createOffer() {
    requirePeer();
    applyCodecPreference(peer);
    var offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    applyCodecPreference(peer);
    await waitForIce(peer, ICE_TIMEOUT_MS);
    await applySenderParameters(peer);
    return (peer.localDescription && peer.localDescription.sdp) || '';
  }

  async function createAnswer(remoteOfferSDP) {
    requirePeer();
    lastRemoteDescription = { type: 'offer', sdp: remoteOfferSDP };
    await peer.setRemoteDescription(lastRemoteDescription);
    applyCodecPreference(peer);
    var answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    applyCodecPreference(peer);
    await waitForIce(peer, ICE_TIMEOUT_MS);
    await applySenderParameters(peer);
    return (peer.localDescription && peer.localDescription.sdp) || '';
  }

  async function setRemoteAnswer(answerSDP) {
    requirePeer();
    lastRemoteDescription = { type: 'answer', sdp: answerSDP };
    await peer.setRemoteDescription(lastRemoteDescription);
    await applySenderParameters(peer);
  }

  function configure(options) {
    var next = options || {};

    if (typeof next.codec !== 'undefined') {
      var codecValue = String(next.codec || '').toLowerCase();
      if (codecValue !== 'vp9' && codecValue !== 'h264') {
        throw new Error('codec must be either "vp9" or "h264".');
      }
      rtcConfig.codec = codecValue;
    }

    if (typeof next.bitrate !== 'undefined') {
      var bitrateValue = Number(next.bitrate);
      if (!isFinite(bitrateValue) || bitrateValue <= 0) {
        throw new Error('bitrate must be a positive number.');
      }
      if (bitrateValue < MIN_BITRATE) bitrateValue = MIN_BITRATE;
      rtcConfig.bitrate = Math.round(bitrateValue);
    }

    if (peer) {
      applyMediaTuning(peer);
    }

    return getConfig();
  }

  function getConfig() {
    return {
      codec: rtcConfig.codec,
      bitrate: rtcConfig.bitrate
    };
  }

  function parseCodecName(mimeType) {
    if (!mimeType) return '';
    var slash = mimeType.indexOf('/');
    var codec = slash >= 0 ? mimeType.slice(slash + 1) : mimeType;
    return String(codec).toUpperCase();
  }

  function parseStatsReport(report, previous) {
    var outbound = null;
    var inbound = null;
    var remoteInbound = null;
    var selectedCandidatePair = null;
    var codecById = {};

    report.forEach(function eachStat(stat) {
      if (!stat || !stat.type) return;

      if (stat.type === 'codec') {
        codecById[stat.id] = stat.mimeType || stat.name || '';
        return;
      }

      if (stat.type === 'outbound-rtp' && stat.kind === 'video' && !stat.isRemote) {
        outbound = stat;
        return;
      }

      if (stat.type === 'inbound-rtp' && stat.kind === 'video' && !stat.isRemote) {
        inbound = stat;
        return;
      }

      if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
        remoteInbound = stat;
        return;
      }

      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
        selectedCandidatePair = stat;
      }
    });

    var ts = (outbound && outbound.timestamp) || (inbound && inbound.timestamp) || Date.now();
    var deltaSec = 0;
    if (previous && previous.timestamp && ts > previous.timestamp) {
      deltaSec = (ts - previous.timestamp) / 1000;
    }

    var sendBitrate = 0;
    var recvBitrate = 0;

    if (deltaSec > 0 && outbound && typeof outbound.bytesSent === 'number' && typeof previous.outboundBytes === 'number') {
      var sentDelta = outbound.bytesSent - previous.outboundBytes;
      if (sentDelta > 0) sendBitrate = Math.round((sentDelta * 8) / deltaSec);
    }

    if (deltaSec > 0 && inbound && typeof inbound.bytesReceived === 'number' && typeof previous.inboundBytes === 'number') {
      var recvDelta = inbound.bytesReceived - previous.inboundBytes;
      if (recvDelta > 0) recvBitrate = Math.round((recvDelta * 8) / deltaSec);
    }

    var bitrate = sendBitrate && recvBitrate ? sendBitrate + recvBitrate : (sendBitrate || recvBitrate || 0);

    var resolution = { w: 0, h: 0 };
    if (outbound && outbound.frameWidth && outbound.frameHeight) {
      resolution.w = outbound.frameWidth;
      resolution.h = outbound.frameHeight;
    } else if (inbound && inbound.frameWidth && inbound.frameHeight) {
      resolution.w = inbound.frameWidth;
      resolution.h = inbound.frameHeight;
    }

    var fps = 0;
    if (outbound && typeof outbound.framesPerSecond === 'number') {
      fps = outbound.framesPerSecond;
    } else if (inbound && typeof inbound.framesPerSecond === 'number') {
      fps = inbound.framesPerSecond;
    } else if (deltaSec > 0 && outbound && typeof outbound.framesEncoded === 'number' && typeof previous.outboundFrames === 'number') {
      var frameDeltaOut = outbound.framesEncoded - previous.outboundFrames;
      if (frameDeltaOut >= 0) fps = frameDeltaOut / deltaSec;
    } else if (deltaSec > 0 && inbound && typeof inbound.framesDecoded === 'number' && typeof previous.inboundFrames === 'number') {
      var frameDeltaIn = inbound.framesDecoded - previous.inboundFrames;
      if (frameDeltaIn >= 0) fps = frameDeltaIn / deltaSec;
    }

    var packetLoss = 0;
    if (inbound) {
      var packetsLost = typeof inbound.packetsLost === 'number' ? inbound.packetsLost : 0;
      var packetsReceived = typeof inbound.packetsReceived === 'number' ? inbound.packetsReceived : 0;
      var totalPackets = packetsLost + packetsReceived;
      if (totalPackets > 0) {
        packetLoss = (packetsLost / totalPackets) * 100;
      }
    }

    var codec = '';
    if (outbound && outbound.codecId && codecById[outbound.codecId]) codec = parseCodecName(codecById[outbound.codecId]);
    else if (inbound && inbound.codecId && codecById[inbound.codecId]) codec = parseCodecName(codecById[inbound.codecId]);

    var jitter = inbound && typeof inbound.jitter === 'number' ? inbound.jitter : 0;
    var roundTripTime = remoteInbound && typeof remoteInbound.roundTripTime === 'number'
      ? remoteInbound.roundTripTime
      : (selectedCandidatePair && typeof selectedCandidatePair.currentRoundTripTime === 'number' ? selectedCandidatePair.currentRoundTripTime : 0);

    return {
      stats: {
        bitrate: Math.max(0, Math.round(bitrate)),
        resolution: { w: resolution.w || 0, h: resolution.h || 0 },
        fps: Math.max(0, Number(fps) || 0),
        packetLoss: Math.max(0, Number(packetLoss) || 0),
        codec: codec || '',
        jitter: Math.max(0, Number(jitter) || 0),
        roundTripTime: Math.max(0, Number(roundTripTime) || 0)
      },
      next: {
        timestamp: ts,
        outboundBytes: outbound && typeof outbound.bytesSent === 'number' ? outbound.bytesSent : null,
        inboundBytes: inbound && typeof inbound.bytesReceived === 'number' ? inbound.bytesReceived : null,
        outboundFrames: outbound && typeof outbound.framesEncoded === 'number' ? outbound.framesEncoded : null,
        inboundFrames: inbound && typeof inbound.framesDecoded === 'number' ? inbound.framesDecoded : null
      }
    };
  }

  async function pollStats() {
    if (!peer) return;
    var thisPeer = peer;

    try {
      var report = await thisPeer.getStats();
      if (!peer || thisPeer !== peer) return;

      var parsed = parseStatsReport(report, statsPrev || {});
      statsPrev = parsed.next;
      emitCallbacks(statsCallbacks, parsed.stats);
    } catch (_ignore) {}
  }

  function startStats(intervalMs) {
    statsIntervalMs = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : DEFAULT_STATS_INTERVAL_MS;
    stopStats();
    statsPrev = null;

    statsTimer = setInterval(function onTick() {
      pollStats();
    }, statsIntervalMs);

    pollStats();
  }

  function stopStats() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    statsPrev = null;
  }

  function onStats(callback) {
    if (typeof callback !== 'function') throw new Error('onStats callback must be a function.');
    statsCallbacks.push(callback);
  }

  function onReconnect(callback) {
    if (typeof callback !== 'function') throw new Error('onReconnect callback must be a function.');
    reconnectCallbacks.push(callback);
  }

  function onReconnectFailed(callback) {
    if (typeof callback !== 'function') throw new Error('onReconnectFailed callback must be a function.');
    reconnectFailedCallbacks.push(callback);
  }

  function getConnectionState() {
    return normalizeState();
  }

  function onRemoteTrack(callback) {
    if (typeof callback !== 'function') throw new Error('onRemoteTrack callback must be a function.');
    remoteTrackCallbacks.push(function relay(payload) {
      callback(payload[0], payload[1], payload[2]);
    });
    if (remoteStream && remoteStream.getVideoTracks().length > 0) {
      callback(remoteStream, remoteStream.getVideoTracks()[0], null);
    }
  }

  function onStateChange(callback) {
    if (typeof callback !== 'function') throw new Error('onStateChange callback must be a function.');
    stateCallbacks.push(callback);
    callback(normalizeState());
  }

  function close() {
    stopStats();
    teardownPeer(true);

    if (localStream) {
      var tracks = localStream.getTracks();
      for (var t = 0; t < tracks.length; t += 1) tracks[t].stop();
      localStream = null;
    }

    remoteStream = null;
    lastRemoteDescription = null;
    restartCount = 0;
    reconnectCount = 0;
    reconnectInProgress = false;
    clearRestartTimer();
    emitState('closed');
  }

  globalScope.RTC = {
    configure: configure,
    getConfig: getConfig,
    listCameras: listCameras,
    getCamera: getCamera,
    createPeer: createPeer,
    createOffer: createOffer,
    createAnswer: createAnswer,
    setRemoteAnswer: setRemoteAnswer,
    getConnectionState: getConnectionState,
    onRemoteTrack: onRemoteTrack,
    onStateChange: onStateChange,
    startStats: startStats,
    stopStats: stopStats,
    onStats: onStats,
    onReconnect: onReconnect,
    onReconnectFailed: onReconnectFailed,
    close: close
  };
})(window);
