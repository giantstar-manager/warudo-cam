(function attachRTC(globalScope) {
  'use strict';

  var ICE_TIMEOUT_MS = 10000;
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:YOUR_TURN_SERVER:443?transport=tcp', username: 'TURN_USER', credential: 'TURN_PASS' }
  ];

  var peer = null;
  var localStream = null;
  var remoteStream = null;
  var restartAttempted = false;
  var stateCallbacks = [];
  var remoteTrackCallbacks = [];

  function requirePeer() {
    if (!peer) throw new Error('Peer connection is not created. Call createPeer() first.');
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
    for (var i = 0; i < stateCallbacks.length; i += 1) {
      try {
        stateCallbacks[i](state);
      } catch (err) {
        setTimeout(function crash() { throw err; }, 0);
      }
    }
  }

  function maybeRestart(state) {
    if (state !== 'disconnected' || !peer || restartAttempted) return;
    restartAttempted = true;
    try { peer.restartIce(); } catch (_ignore) {}
  }

  function updateState() {
    var state = normalizeState();
    emitState(state);
    maybeRestart(state);
  }

  function wirePeerEvents() {
    peer.addEventListener('connectionstatechange', updateState);
    peer.addEventListener('iceconnectionstatechange', updateState);
    peer.addEventListener('track', function onTrack(event) {
      if (!event.track || event.track.kind !== 'video') return;
      if (event.streams && event.streams[0]) {
        remoteStream = event.streams[0];
      } else {
        if (!remoteStream) remoteStream = new MediaStream();
        remoteStream.addTrack(event.track);
      }
      for (var i = 0; i < remoteTrackCallbacks.length; i += 1) {
        try {
          remoteTrackCallbacks[i](remoteStream, event.track, event);
        } catch (err) {
          setTimeout(function crash() { throw err; }, 0);
        }
      }
    });
  }

  function getH264Codecs() {
    if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return null;
    var caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !caps.codecs || !caps.codecs.length) return null;

    var h264 = [];
    var others = [];
    for (var i = 0; i < caps.codecs.length; i += 1) {
      var codec = caps.codecs[i];
      if (codec && codec.mimeType && /video\/h264/i.test(codec.mimeType)) h264.push(codec);
      else others.push(codec);
    }
    if (!h264.length) return null;
    return h264.concat(others);
  }

  function preferH264() {
    if (!peer) return false;
    var ordered = getH264Codecs();
    if (!ordered) return false;

    var transceivers = peer.getTransceivers();
    var applied = false;
    for (var i = 0; i < transceivers.length; i += 1) {
      var tr = transceivers[i];
      if (!tr || typeof tr.setCodecPreferences !== 'function') continue;
      var senderVideo = !!(tr.sender && tr.sender.track && tr.sender.track.kind === 'video');
      var receiverVideo = !!(tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video');
      if (!senderVideo && !receiverVideo && tr.mid === null) continue;
      try {
        tr.setCodecPreferences(ordered);
        applied = true;
      } catch (_ignore) {}
    }
    return applied;
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

  async function getCamera(deviceId) {
    return navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: 1920,
        height: 1080,
        frameRate: 30
      },
      audio: false
    });
  }

  function createPeer(isCaller, stream) {
    if (peer) close();

    peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream = stream || null;
    remoteStream = new MediaStream();
    restartAttempted = false;
    wirePeerEvents();

    if (isCaller && localStream) {
      var tracks = localStream.getVideoTracks();
      for (var i = 0; i < tracks.length; i += 1) peer.addTrack(tracks[i], localStream);
    }

    emitState('new');
    return peer;
  }

  async function createOffer() {
    requirePeer();
    preferH264();
    var offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    preferH264();
    await waitForIce(peer, ICE_TIMEOUT_MS);
    return (peer.localDescription && peer.localDescription.sdp) || '';
  }

  async function createAnswer(remoteOfferSDP) {
    requirePeer();
    await peer.setRemoteDescription({ type: 'offer', sdp: remoteOfferSDP });
    preferH264();
    var answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    preferH264();
    await waitForIce(peer, ICE_TIMEOUT_MS);
    return (peer.localDescription && peer.localDescription.sdp) || '';
  }

  async function setRemoteAnswer(answerSDP) {
    requirePeer();
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSDP });
  }

  function getConnectionState() {
    return normalizeState();
  }

  function onRemoteTrack(callback) {
    if (typeof callback !== 'function') throw new Error('onRemoteTrack callback must be a function.');
    remoteTrackCallbacks.push(callback);
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
    if (peer) {
      var senders = peer.getSenders();
      for (var i = 0; i < senders.length; i += 1) if (senders[i].track) senders[i].track.stop();

      var receivers = peer.getReceivers();
      for (var r = 0; r < receivers.length; r += 1) if (receivers[r].track) receivers[r].track.stop();

      peer.close();
      peer = null;
    }

    if (localStream) {
      var tracks = localStream.getTracks();
      for (var t = 0; t < tracks.length; t += 1) tracks[t].stop();
      localStream = null;
    }

    remoteStream = null;
    restartAttempted = false;
    emitState('closed');
  }

  globalScope.RTC = {
    listCameras: listCameras,
    getCamera: getCamera,
    createPeer: createPeer,
    createOffer: createOffer,
    createAnswer: createAnswer,
    setRemoteAnswer: setRemoteAnswer,
    getConnectionState: getConnectionState,
    onRemoteTrack: onRemoteTrack,
    onStateChange: onStateChange,
    close: close
  };
})(window);
