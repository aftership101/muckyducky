const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname,'..');
const js = fs.readFileSync(path.join(root,'app.js'),'utf8');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const presence=fs.readFileSync(path.join(root,'presence.js'),'utf8');

test('JavaScript parses', () => assert.doesNotThrow(() => new vm.Script(js)));
test('all required interface controls exist', () => {
  for (const id of ['dot','status','timer','password','setup','callBtn','muteBtn','endBtn','scanBtn','restoreBtn','error','localState','remoteState','diagnostics','remoteAudio']) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
});
test('one password input, no extra settings', () => {
  assert.equal((html.match(/<input\b/g)||[]).length,1);
  assert.doesNotMatch(html,/micSelect|copyLogBtn|inviteInput/);
});
test('native voice noise reduction and speech hint are requested', () => {
  assert.match(js,/constraints\.noiseSuppression=true/);
  assert.match(js,/voice\.contentHint='speech'/);
  assert.match(js,/capture=await navigator\.mediaDevices\.getUserMedia/);
});
test('explicit remote hangup is handled immediately', () => {
  assert.match(js,/m\.type==='exit'/);
  assert.match(js,/holdRemote=true;closeMedia\(\)/);
});
test('heartbeat absence alone cannot remove active audio', () => {
  assert.doesNotMatch(js,/quality==='dead'&&Date\.now\(\)-lastRemote>/);
  assert.match(js,/inspectAudio\(\)/);
});
test('recovery timers and stale-session protections are present', () => {
  assert.match(js,/sessionId=/);
  assert.match(js,/ticket!==epoch/);
  assert.match(js,/clearTimers\(\)/);
  assert.match(js,/nextRetry/);
});
test('no embedded PIN or hardcoded shared secret', () => {
  assert.doesNotMatch(js, /['"]0120['"]/);
  assert.match(js,/crypto\.subtle\.digest/);
});
test('no unexpected external dependencies other than PeerJS', () => {
  const src=[...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(src.length,4);
  assert.match(src[0],/^https:\/\/cdn\.jsdelivr\.net\/npm\/peerjs@/);
  assert.match(src[1],/^app\.js\?v=/);
  assert.match(src[2],/^presence\.js\?v=/);
});

test('audio-session interruptions do not trigger microphone reacquisition', () => {
  assert.match(js,/if\(old&&old\.readyState==='live'&&\(!force\|\|!old\.muted\)\)return/);
  assert.match(js,/scheduleMicRecovery\('health check'\)/);
  assert.match(js,/microphone interrupted by another app or system; preserving call/);
});
test('a missing heartbeat and silent RTP alone get a longer grace period', () => {
  assert.match(js,/media\?\.peerConnection&&\['failed','closed'\]\.includes\(media\.peerConnection\.connectionState\)/);
  assert.match(js,/\['failed','closed'\]/);
  assert.doesNotMatch(js,/quality==='dead'\|\|/);
});
test('session status includes page visibility and microphone interruption', () => {
  assert.match(js,/pageHidden:document\.hidden/);
  assert.match(js,/micInterrupted:!!track\(\)\?\.muted/);
});

test('microphone permission failures show direct-browser guidance', () => {
  assert.match(html,/id="browserLink"/);
  assert.match(js,/e\?\.name==='NotAllowedError'/);
  assert.match(js,/iOS restrictions cannot be overridden/);
  assert.match(js,/captureError\(e\)/);
});

test('returning browsers have spare peer IDs and persistent device identity', () => {
  assert.match(js,/return idsFromPrimary\(/);
  assert.match(js,/localStorage\.getItem\('muckyducky-device-v1'\)/);
  assert.match(js,/metadata:\{device:deviceId,session:sessionId,rejoin:refreshRejoinActive\}/);
  assert.match(js,/incomingDevice!==remoteDevice/);
  assert.match(js,/incomingSession===previousSession/);
  assert.match(js,/advanceTarget\('no answer'\)/);
  assert.match(html,/app\.js\?v=38/);
});

test('interruption resilience and recovery are guarded',()=>{
assert.match(js,/t\.enabled=!userMuted/);
assert.match(js,/replacement\.enabled=!userMuted/);
assert.match(js,/const delays=\[1800,5000,10000,20000,30000\]/);
assert.match(js,/s\.addEventListener\('statechange',syncAudioSession\)/);
assert.match(js,/scheduleAudioResume\('playback paused'\)/);
assert.match(js,/resumeCall\('audio device changed'\)/);
assert.match(js,/resumeCall\('page shown'\)/);
assert.match(js,/!document\.hidden&&!audioSessionInterrupted/);
assert.match(html,/app\.js\?v=38/);
});

test('long quiet calls do not expire on elapsed time or silent RTP alone',()=>{
assert.doesNotMatch(js,/quality==='dead'&&Date\.now\(\)-lastRemote>/);
assert.match(js,/pc\.connectionState==='failed'\|\|pc\.connectionState==='closed'\|\|pc\.iceConnectionState==='failed'/);
assert.match(js,/function startClock\(\)/);
assert.doesNotMatch(js,/setTimeout\(\(\)=>teardown\(/);
assert.match(html,/app\.js\?v=38/);
});

test('the footer has a tiny unlabeled live visitor widget',()=>{assert.match(html,/id="onlineCount"/);assert.match(html,/\["small","mckdcky26q2","mdc"\]/);});

test("online counter has an independent image fallback",()=>{assert.match(html,/id="_waumdc"/);assert.match(html,/id="onlineFallback"/);assert.match(html,/whos\.amung\.us\/swidget\/mckdcky26q2\.png/);});

test("rejoin uses fresh signaling IDs without displacing anyone",()=>{assert.match(js,/const fresh=\(\)=>/);assert.match(js,/return \[primary,'md-'\+tag\+'-b',\.\.\.\['c','d','e','f'\]/);assert.match(js,/openPeer\(\(rescueJoin\|\|autoRescue\)\?7:6,ticket\)/);assert.match(js,/if\(p!==peer\|\|stopping\|\|!stream\)/);});

test('attempts each legacy room slot without claiming online status',()=>{
assert.match(js,/label:'A',id:ids\[0\]/);
assert.match(js,/label:'B',id:ids\[1\]/);
assert.match(js,/label:'C',id:original\.slice\(0,-1\)\+'c'/);
assert.match(js,/label:'D',id:original\.slice\(0,-1\)\+'d'/);
assert.match(js,/filter\(t=>t\.id!==peer\.id\)/);
assert.match(js,/slot attempts: /);
assert.match(js,/dialTargetIndex=\(dialTargetIndex\+1\)%targets\.length/);
assert.match(js,/if\(!data&&media\?\.open\)dialData\(\)/);
assert.match(html,/app\.js\?v=38/);
});

test('occupied IDs never imply active users and backup slots accept calls',()=>{
assert.match(js,/occupiedSlots\.add/);
assert.match(js,/may be stale/);
assert.doesNotMatch(js,/index>=2\)\{c\.close\(\)/);
assert.match(js,/returning device taking over unresponsive call/);
assert.match(js,/rejected incoming duplicate while existing call is protected/);
assert.match(js,/remote session changed; preserving media/);
assert.match(html,/app\.js\?v=38/);
});

test('manual scan works when user owns the waiting A slot',()=>{
 assert.match(html,/id="scanBtn"/);
 assert.match(js,/manualScan=true/);
 assert.match(js,/slot>=1\|\|manualScan/);
 assert.match(js,/slot<1&&!manualScan/);
 assert.match(js,/if\(stopping\|\|starting\|\|media\?\.open\)return/);
 assert.match(js,/advanceTarget\('skipped manually'\)/);
 assert.match(js,/manualScan=false/);
 assert.match(html,/app\.js\?v=38/);
});

test('scan button is available before a call and can start searching',()=>{
 assert.match(html,/<button id="scanBtn">find waiting participant<\/button>/);
 assert.match(js,/async function begin\(scanRequested=false,options=\{\}\)/);
 assert.match(js,/if\(!stream\)\{begin\(true\);return;\}/);
 assert.match(js,/manualScan=scanRequested/);
 assert.match(js,/ui\.scanBtn\.hidden=false/);
 assert.match(html,/app\.js\?v=38/);
});

test('Linux Chromium browsers can use basic audio capture fallback and focus recovery',()=>{
assert.match(js,/getUserMedia\(\{audio:true,video:false\}\)/);
assert.match(js,/window\.addEventListener\('focus'/);
assert.match(js,/PipeWire\/PulseAudio/);
assert.match(js,/Allow microphone access in Vivaldi/);
assert.match(html,/app\.js\?v=38/);
});

test('slot count is honest and own peer is never called',()=>{
 assert.match(html,/id="slotCounts"/);
 assert.match(js,/function allRoomSlots\(\)/);
 assert.match(js,/function updateSlotCounts\(\)/);
 assert.match(js,/t\.id===peer\?\.id/);
 assert.match(js,/t\.id===connectedPeer/);
 assert.match(js,/not checked \/ unknown/);
 assert.match(js,/selected\.id===peer\.id/);
 assert.match(js,/filter\(t=>t\.id!==peer\.id\)/);
 assert.match(html,/app\.js\?v=38/);
});

test('PeerJS unavailable signals empty only for the attempted ID',()=>{
 assert.match(js,/const unavailableId=media\.peer/);
 assert.match(js,/allRoomSlots\(\)\.find\(t=>t\.id===unavailableId\)/);
 assert.match(js,/emptyReports\[target\.label\]=Date\.now\(\)/);
 assert.match(js,/empty \(not registered at last check\)/);
 assert.match(js,/Date\.now\(\)-emptyReports\[t\.label\]<30000/);
 assert.match(js,/no answer \(occupancy unknown\)/);
 assert.match(html,/app\.js\?v=38/);
});

test('admin mode does not request a microphone for password 1',()=>{
 assert.match(html,/id="adminPanel"/);
 assert.match(html,/id="adminMetrics"/);
 assert.match(html,/id="adminRoomRows"/);
 assert.match(html,/presence\.js\?v=3/);
 assert.match(js,/ui\.password\.value==='1'/);
 assert.match(js,/muckyducky:admin-open/);
 assert.match(js,/muckyducky:presence/);
 assert.match(js,/room:stream\?activeRoomPrimary:null/);
 assert.match(html,/app\.js\?v=38/);
});

test('presence collector tracks reported rooms and call participation',()=>{
 assert.doesNotThrow(()=>new vm.Script(presence));
 assert.match(presence,/HUB_ID='md-presence-admin-v1'/);
 assert.match(presence,/Rooms with calls/);
 assert.match(presence,/type:'presence'/);
 assert.match(presence,/type:'snapshot'/);
 assert.match(presence,/previousConnected!==mediaConnected\|\|previousPeerId!==mediaPeerId\)sendReport\(\)/);
 assert.match(presence,/const STALE_MS=27000/);
 assert.match(presence,/crypto\.subtle\.digest\('SHA-256'/);
 assert.match(presence,/clearReporter\(\)/);
 assert.match(presence,/password\.value==='1'/);
 assert.match(html,/Live reports are not a complete server-wide count/);
});

test('occupied A/B slots fall back to discoverable C/D/E/F before random IDs',()=>{
 assert.match(js,/\.\.\.\['c','d','e','f'\]\.map\(s=>/);
 assert.match(js,/\{label:'E',id:original\.slice\(0,-1\)\+'e'\}/);
 assert.match(js,/\{label:'F',id:original\.slice\(0,-1\)\+'f'\}/);
 assert.match(js,/index<ids\.length-1/);
 assert.match(js,/openPeer\(index\+1,ticket\)/);
 assert.match(js,/openPeer\(\(rescueJoin\|\|autoRescue\)\?7:6,ticket\)/);
 assert.match(js,/selected\.id===peer\.id/);
});
test('connected audio cannot be displayed as other participant offline due to telemetry',()=>{
 assert.match(js,/remote\('audio connected/);
 assert.match(js,/diagnostics: reconnecting/);
 assert.match(js,/media\?\.open\)remote/);
 assert.doesNotMatch(js,/peer\.id<=media\.peer/);
 assert.match(js,/startClock\(\);play\(\);heartbeat\(\);dialData\(\)/);
});

test('rescue mode joins with a fresh peer ID and can dial old Safari A/B without claiming IDs',()=>{
 assert.match(js,/rescueJoin=new URLSearchParams\(window\.location\.search\)\.get\('rescue'\)==='1'/);
 assert.match(js,/if\(rescueJoin\)\{log\('rescue join:/);
 assert.match(js,/openPeer\(ids\.length-1,ticket\)/);
 assert.match(js,/slot>=1\|\|manualScan\|\|rescueJoin\|\|autoRescue/);
 assert.match(js,/index>=1\|\|manualScan\|\|rescueJoin\|\|autoRescue/);
 assert.match(js,/openPeer\(\(rescueJoin\|\|autoRescue\)\?7:6,ticket\)/);
 assert.match(html,/app\.js\?v=38/);
});

test('rescue join can dial older callers without taking occupied A or B',()=>{
 assert.match(js,/slot<1&&!manualScan&&!rescueJoin/);
 assert.match(js,/if\(rescueJoin\)\{log\('rescue join:/);
 assert.match(js,/manualScan=true;openPeer\(ids\.length-1,ticket\)/);
 assert.match(js,/get\('rescue'\)==='1'/);
 assert.match(html,/app\.js\?v=38/);
});

test('rescue mode cycles unresponsive slots quickly without occupying their IDs',()=>{
 assert.match(js,/\(rescueJoin\|\|autoRescue\)\?4500:8000/);
 assert.match(js,/nextRetry=\(rescueJoin\|\|autoRescue\)\?0:Date\.now\(\)\+1200/);
 assert.match(js,/\(rescueJoin\|\|autoRescue\)\?600:Math\.min/);
 assert.match(js,/openPeer\(ids\.length-1,ticket\)/);
});

test('unavailable A immediately yields to a fresh independent peer ID',()=>{
 assert.match(js,/if\(index===0&&!rescueJoin\)/);
 assert.match(js,/autoRescue=true;manualScan=true/);
 assert.match(js,/openPeer\(ids\.length-1,ticket\)/);
 assert.match(js,/without claiming B/);
 assert.match(js,/autoRescue=false/);
 assert.match(js,/rescueJoin\|\|autoRescue/);
 assert.match(html,/app\.js\?v=38/);
});

test('diagnostics outbound initiated by B to legacy A even when B ID sorts above A',()=>{
 assert.match(js,/if\(stopping\|\|!peer\?\.open\|\|data\|\|!media\?\.open\|\|!media\.peer\)return/);
 assert.doesNotMatch(js,/peer\.id<=media\.peer/);
 assert.match(js,/peer\.connect\(media\.peer,\{reliable:true\}\)/);
 assert.match(js,/connecting diagnostics to current audio peer/);
});
test('audio diagnosis distinguishes missing inbound RTP stats and outbound RTP',()=>{
 assert.match(js,/x\.mediaType==='audio'/);
 assert.match(js,/outbound\?\.packetsSent/);
 assert.match(js,/incoming RTP: not confirmed/);
 assert.match(js,/no inbound audio stats/);
});

test('find waiting participant reuses the live peer without reloading and clears stale remote-exit guard',()=>{
 assert.match(html,/<button id="scanBtn">find waiting participant<\/button>/);
 assert.match(js,/manualScan=true;holdRemote=false/);
 assert.match(js,/if\(peer\?\.open\)dial\(\)/);
 assert.match(js,/else if\(peer\?\.disconnected&&!peer\.destroyed\)/);
 assert.match(js,/openPeer\(ids\.length-1,epoch\)/);
 assert.match(js,/find waiting participant: scanning all known slots/);
 assert.match(html,/app\.js\?v=38/);
});

test('direct join uses reported waiting calling ID, not the room password',()=>{
 assert.match(js,/muckyducky:admin-join/);
 assert.match(js,/directPeerId:target/);
 assert.match(js,/if\(directTarget\)return directTarget===peer\.id/);
 assert.match(js,/requestedPeer\?idsFromPrimary/);
 assert.match(js,/joining a reported waiting peer directly/);
 assert.match(presence,/waitingPeers:\[\]/);
 assert.match(presence,/peerId:mediaPeerId/);
 assert.match(presence,/Join waiting participant/);
 assert.match(html,/app\.js\?v=38/);
 assert.match(html,/presence\.js\?v=3/);
});
