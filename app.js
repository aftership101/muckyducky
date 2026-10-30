/* One fixed two-person room. PeerJS Cloud signaling; no server or room passwords. */
(() => {
'use strict';
const el=id=>document.getElementById(id);
const ui=Object.fromEntries(['status','timer','callBtn','idle','active','muteBtn','endBtn','restoreBtn','error','diagnostics','copyLogBtn','remoteAudio'].map(k=>[k,el(k)]));
const ROOM='muckyducky-single-room-v1'; // Both visitors use these same two PeerJS IDs.
const ids=[ROOM+'-a',ROOM+'-b'];
const logs=[];
let peer=null, call=null, stream=null, slot=-1, retry=null, clock=null, started=0, ending=false, joining=false, reconnecting=false;
const note=s=>{logs.push(new Date().toLocaleTimeString()+' '+s);if(logs.length>120)logs.shift();ui.diagnostics.textContent=logs.join('\n');};
const status=s=>{ui.status.textContent=s;note(s);};
const error=s=>{ui.error.textContent=s;ui.error.hidden=!s;if(s)note('error: '+s);};
function stopClock(){clearInterval(clock);clock=null;started=0;ui.timer.textContent='00:00';}
function startClock(){if(clock)return;started=Date.now();clock=setInterval(()=>{let n=Math.floor((Date.now()-started)/1000);ui.timer.textContent=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');},1000);}
function clearCall(){if(call){const c=call;call=null;try{c.close();}catch{}}ui.remoteAudio.srcObject=null;ui.restoreBtn.hidden=true;stopClock();}
function finish(){ending=true;clearInterval(retry);retry=null;clearCall();if(peer){try{peer.destroy();}catch{}peer=null;}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}slot=-1;joining=false;reconnecting=false;ui.active.hidden=true;ui.idle.hidden=false;ui.callBtn.disabled=false;ui.muteBtn.textContent='mute';ui.muteBtn.setAttribute('aria-pressed','false');error('');status('not connected');ending=false;}
async function playAudio(){if(!ui.remoteAudio.srcObject)return;try{await ui.remoteAudio.play();ui.restoreBtn.hidden=true;note('remote audio playing');}catch(e){ui.restoreBtn.hidden=false;error('Safari needs a tap to restore audio.');note('play blocked: '+e.name);}}
function watchCall(c){
if(call&&call!==c){c.close();return;}
call=c;status('connecting...');
c.on('stream',remote=>{ui.remoteAudio.srcObject=remote;for(const t of remote.getAudioTracks()){t.addEventListener('mute',()=>note('remote mic track muted'));t.addEventListener('unmute',()=>{note('remote track unmuted');playAudio();});t.addEventListener('ended',()=>note('remote track ended'));}status('connected');error('');startClock();playAudio();});
c.on('close',()=>{if(call!==c)return;call=null;ui.remoteAudio.srcObject=null;stopClock();if(!ending){status('waiting for other person...');}});
c.on('error',e=>{note('call error: '+(e.type||e.message));if(call===c){call=null;ui.remoteAudio.srcObject=null;stopClock();}if(!ending)status('connection interrupted; retrying...');});
}
function dial(){
if(ending||!peer?.open||!stream||call||slot!==1)return;
try{const c=peer.call(ids[0],stream);if(c){note('dialing other person');watchCall(c);}}catch(e){note('dial error: '+e.message);}
}
function configure(p,index){
p.on('open',()=>{slot=index;status('waiting for other person...');if(index===1){dial();retry=setInterval(()=>{if(!call)dial();},7000);}});
p.on('call',incoming=>{if(index!==0||call||ending||!stream){incoming.close();return;}note('incoming call');watchCall(incoming);incoming.answer(stream);});
p.on('disconnected',()=>{note('signaling disconnected');if(!ending&&!p.destroyed){try{p.reconnect();}catch(e){note(e.message);}}});
p.on('error',e=>{
note('signaling error: '+e.type);
if(e.type==='unavailable-id'&&index===0&&!ending){try{p.destroy();}catch{}peer=null;openSlot(1);return;}
if(e.type==='unavailable-id'&&index===1){error('room is full (two people already joined).');finish();error('room is full (two people already joined).');return;}
if(e.type==='peer-unavailable'){if(call){clearCall();}status('waiting for other person...');return;}
error('Connection problem: '+(e.type||'unknown'));});
p.on('close',()=>note('signaling closed'));
}
function openSlot(index){if(ending||!stream)return;try{peer=new Peer(ids[index],{debug:0,config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]}});configure(peer,index);}catch(e){error('Could not open connection: '+e.message);finish();}}
async function begin(){
if(joining||stream||peer)return;
joining=true;ui.callBtn.disabled=true;error('');
if(!window.Peer){joining=false;ui.callBtn.disabled=false;error('PeerJS could not load. Check your internet.');return;}\nif(!navigator.mediaDevices?.getUserMedia){joining=false;ui.callBtn.disabled=false;error('Microphone API unavailable. Open the HTTPS GitHub Pages site and allow microphone access.');return;}
try{
ui.remoteAudio.autoplay=true;ui.remoteAudio.playsInline=true;ui.remoteAudio.muted=false;
status('requesting microphone...');
stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
for(const t of stream.getAudioTracks()){t.addEventListener('mute',()=>note('local audio track muted'));t.addEventListener('unmute',()=>note('local audio track unmuted'));t.addEventListener('ended',()=>{note('microphone stopped by system');error('Microphone stopped; rejoin manually if needed.');});}
ui.idle.hidden=true;ui.active.hidden=false;status('joining room...');openSlot(0);
}catch(e){status('not connected');error('Microphone unavailable: '+(e.name||e.message));if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}}finally{joining=false;ui.callBtn.disabled=false;}
}
ui.callBtn.addEventListener('click',()=>{status('call button pressed');begin();});
ui.endBtn.addEventListener('click',finish);
ui.muteBtn.addEventListener('click',()=>{const track=stream?.getAudioTracks()[0];if(!track)return;track.enabled=!track.enabled;ui.muteBtn.textContent=track.enabled?'mute':'unmute';ui.muteBtn.setAttribute('aria-pressed',String(!track.enabled));note(track.enabled?'unmuted':'muted');});
ui.restoreBtn.addEventListener('click',()=>playAudio());
ui.copyLogBtn.addEventListener('click',()=>navigator.clipboard.writeText(logs.join('\n')).catch(()=>error('Could not copy log.')));
document.addEventListener('visibilitychange',()=>{note('visibility: '+document.visibilityState);if(!document.hidden&&ui.remoteAudio.srcObject&&ui.remoteAudio.paused)playAudio();});
ui.remoteAudio.addEventListener('pause',()=>{if(call)note('remote audio paused');});
ui.remoteAudio.addEventListener('error',()=>{note('remote audio element error');ui.restoreBtn.hidden=false;});
ui.remoteAudio.addEventListener('stalled',()=>note('remote audio stalled'));
window.addEventListener('error',e=>error('Script error: '+e.message));\nwindow.addEventListener('unhandledrejection',e=>error('Call error: '+(e.reason?.message||String(e.reason))));\n})();