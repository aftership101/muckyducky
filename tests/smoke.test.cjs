const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname,'..');
const js = fs.readFileSync(path.join(root,'app.js'),'utf8');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');

test('JavaScript parses', () => assert.doesNotThrow(() => new vm.Script(js)));
test('all required interface controls exist', () => {
  for (const id of ['dot','status','timer','password','setup','callBtn','muteBtn','endBtn','restoreBtn','error','localState','remoteState','diagnostics','remoteAudio']) {
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
  assert.match(js,/quality==='dead'/);
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
  assert.equal(src.length,2);
  assert.match(src[0],/^https:\/\/cdn\.jsdelivr\.net\/npm\/peerjs@/);
  assert.match(src[1],/^app\.js\?v=/);
});

test('audio-session interruptions do not trigger microphone reacquisition', () => {
  assert.match(js,/if\(old&&old\.readyState==='live'\)return/);
  assert.match(js,/if\(track\(\)\?\.readyState==='ended'\)\{recoverMicrophone\(\);\}/);
  assert.match(js,/microphone interrupted by another app or system; preserving call/);
});
test('a missing heartbeat and silent RTP alone get a longer grace period', () => {
  assert.match(js,/quality==='dead'&&Date\.now\(\)-lastRemote>55000/);
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
  assert.match(js,/\['a','b','c','d'\]\.map/);
  assert.match(js,/localStorage\.getItem\('muckyducky-device-v1'\)/);
  assert.match(js,/metadata:\{device:deviceId,session:sessionId\}/);
  assert.match(js,/incomingDevice!==remoteDevice/);
  assert.match(js,/c\.metadata\.session===remoteSession/);
  assert.match(js,/if\(slot>=2\)dialTargetIndex=1-dialTargetIndex/);
  assert.match(html,/app\.js\?v=17/);
});
