(() => {
'use strict';
const $ = id => document.getElementById(id);
const ui=Object.fromEntries(['dot','status','timer','password','micSelect','setup','callBtn','muteBtn','endBtn','restoreBtn','error','localState','remoteState','diagnostics','remoteAudio'].map(id=>[id,$(id)]));
const events=[];
const STORE='muckyducky-mic-v1';
let peer=null,media=null,data=null,stream=null,ids=null,slot=-1,epoch=0,stopping=false,starting=false,connecting=false;
let healthTimer=null,redialTimer=null,clockTimer=null,startedAt=0,lastRemote=0,lastHeartbeat=0,remoteReason='',remoteState='offline',pendingAudio=false,callAttemptAt=0,dataAttemptAt=0;
let preferredDevice='';
let recoveryBusy=false,lastRecoveryAt=0,peerRetryAt=0;
try{preferredDevice=localStorage.getItem(STORE)||'';}catch{}
function log(m){events.push(new Date().toLocaleTimeString()+'  '+m);if(events.length>100)events.shift();ui.diagnostics.textContent=events.join('\n');}
function state(m,t=''){if(ui.status.textContent!==m)log(m);ui.status.textContent=m;ui.dot.className='dot '+t;}
function problem(m){ui.error.textContent=m;ui.error.hidden=!m;if(m)log('error: '+m);}
function remote(m){remoteState=m;ui.remoteState.textContent=m;}
function track(){return stream?.getAudioTracks()[0];}
function refresh(){const t=track();ui.localState.textContent='signaling: '+(peer?.open?'online':'offline')+'\nmic: '+(!t?'off':t.readyState==='ended'?'ended':t.enabled?'on':'muted')+'\npage: '+document.visibilityState+'\nnetwork: '+(navigator.onLine?'online':'offline')+'\ncall: '+(media?.open?'open':'not connected');}
function transmit(msg){if(data?.open){try{data.send(msg);}catch(e){log('diagnostic send failed');}}}
function heartbeat(){refresh();transmit({type:'status',state:ui.localState.textContent,time:Date.now()});}
async function roomIds(password){
const bytes=new TextEncoder().encode('muckyducky-private-room-v2\u0000'+password);
const digest=await crypto.subtle.digest('SHA-256',bytes);
const h=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
return ['md-'+h.slice(0,42)+'-a','md-'+h.slice(0,42)+'-b'];
}
function stopClock(){clearInterval(clockTimer);clockTimer=null;ui.timer.textContent='00:00';}
function startClock(){if(clockTimer)return;startedAt=Date.now();clockTimer=setInterval(()=>{const n=Math.floor((Date.now()-startedAt)/1000);ui.timer.textContent=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');},1000);}
async function recoverMicrophone(){
if(stopping||!stream||recoveryBusy||Date.now()-lastRecoveryAt<12000)return;
const old=track();if(old&&old.readyState==='live'&&!old.muted)return;
recoveryBusy=true;lastRecoveryAt=Date.now();
try{
const next=await microphone();
if(stopping){next.getTracks().forEach(t=>t.stop());return;}
const replacement=next.getAudioTracks()[0];
for(const sender of media?.peerConnection?.getSenders?.()||[]){if(sender.track?.kind==='audio')await sender.replaceTrack(replacement);}
const prior=stream;stream=next;watchMicrophone(next);
if(prior)prior.getTracks().forEach(t=>t.stop());
log('microphone recovered');problem('');heartbeat();
}catch(e){log('microphone recovery needs attention: '+e.name);if(e.name==='NotAllowedError'||e.name==='NotFoundError')problem('microphone permission or device unavailable');}
finally{recoveryBusy=false;}
}
function closeMedia(){callAttemptAt=0;let c=media;media=null;if(c)try{c.close();}catch{}ui.remoteAudio.srcObject=null;ui.restoreBtn.hidden=true;pendingAudio=false;stopClock();}
function clearTimers(){clearInterval(healthTimer);clearInterval(redialTimer);healthTimer=redialTimer=null;}
function controls(active){ui.setup.hidden=active;ui.callBtn.hidden=active;ui.muteBtn.hidden=!active;ui.endBtn.hidden=!active;ui.callBtn.disabled=false;}
function teardown(reason='hang up button pressed'){
stopping=true;epoch++;transmit({type:'exit',reason});log('you: '+reason);clearTimers();closeMedia();const d=data;data=null;if(d)try{d.close();}catch{}const p=peer;peer=null;if(p)try{p.destroy();}catch{}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}ids=null;slot=-1;starting=false;connecting=false;lastRemote=0;remoteReason='';remote('offline');controls(false);ui.muteBtn.textContent='mute';state('offline');problem('');refresh();stopping=false;
}
async function play(){
if(!ui.remoteAudio.srcObject)return;
try{await ui.remoteAudio.play();pendingAudio=false;ui.restoreBtn.hidden=true;log('audio playing');}
catch(e){pendingAudio=true;ui.restoreBtn.hidden=false;log('playback blocked: '+e.name);problem('tap restore audio');}
}
async function loadDevices(){
if(!navigator.mediaDevices?.enumerateDevices)return;
try{
const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
ui.micSelect.replaceChildren(new Option('default',''));
devices.forEach((d,i)=>ui.micSelect.add(new Option(d.label||'microphone '+(i+1),d.deviceId)));
ui.micSelect.value=devices.some(d=>d.deviceId===preferredDevice)?preferredDevice:'';
}catch(e){log('device list unavailable: '+e.name);}
}
function mediaEvents(c){
if(media&&media!==c){c.close();return;}
media=c;state('connecting','wait');
const rtc=c.peerConnection;
if(rtc){
const check=()=>{log('webrtc: '+rtc.connectionState+' / ice '+rtc.iceConnectionState);
if(['failed','closed'].includes(rtc.connectionState)||rtc.iceConnectionState==='failed'){if(media===c&&!stopping){closeMedia();state('reconnecting','wait');}}
};
rtc.addEventListener('connectionstatechange',check);
rtc.addEventListener('iceconnectionstatechange',check);
}
c.on('stream',s=>{if(media!==c)return;callAttemptAt=0;ui.remoteAudio.srcObject=s;for(const t of s.getAudioTracks()){t.addEventListener('mute',()=>log('remote track muted'));t.addEventListener('unmute',()=>{log('remote track resumed');play();});t.addEventListener('ended',()=>log('remote track ended'));}state('connected','live');problem('');startClock();play();heartbeat();});
c.on('close',()=>{if(media!==c)return;media=null;ui.remoteAudio.srcObject=null;stopClock();if(!stopping){state('reconnecting','wait');remote('disconnected\nreason: '+(remoteReason||'unknown; connection ended'));}});
c.on('error',e=>{log('media error: '+(e.type||e.message));if(media===c){closeMedia();if(!stopping)state('reconnecting','wait');}});
}
function watchData(c){
if(data&&data!==c&&data.open){c.close();return;}
data=c;
c.on('open',()=>{dataAttemptAt=0;log('diagnostics linked');heartbeat();});
c.on('data',m=>{
if(!m||typeof m!=='object')return;
lastRemote=Date.now();
if(m.type==='status'){remote(m.state+'\nupdated: just now');}
if(m.type==='exit'){remoteReason=m.reason||'hang up';remote('offline\nreason: '+remoteReason);log('other person: '+remoteReason);}
});
c.on('close',()=>{if(data!==c)return;data=null;if(!stopping){log('diagnostics disconnected');if(Date.now()-lastRemote>25000)remote('unreachable\nreason: unknown');}});
c.on('error',e=>log('diagnostics error: '+e.message));
}
function dial(){
if(stopping||slot!==1||!peer?.open||!stream||media)return;
try{const c=peer.call(ids[0],stream);if(c){callAttemptAt=Date.now();mediaEvents(c);}}catch(e){log('dial failed: '+e.message);}
}
function dialData(){if(stopping||slot!==1||!peer?.open||data?.open)return;try{dataAttemptAt=Date.now();watchData(peer.connect(ids[0],{reliable:true}));}catch(e){log('data dial failed: '+e.message);}}
function peerReady(p,index,ticket){
p.on('open',()=>{
if(ticket!==epoch||stopping){p.destroy();return;}
slot=index;state('waiting','wait');refresh();
if(index===1){dial();dialData();}
clearTimers();
redialTimer=setInterval(()=>{
if(stopping||ticket!==epoch||!navigator.onLine)return;
if(peer?.disconnected&&!peer.destroyed){try{peer.reconnect();}catch{}}
if(slot===1){if(media&&!media.open&&callAttemptAt&&Date.now()-callAttemptAt>25000){log('outgoing call timed out; redialing');closeMedia();}if(data&&!data.open&&dataAttemptAt&&Date.now()-dataAttemptAt>20000){log('diagnostics timed out; reconnecting');const old=data;data=null;try{old.close();}catch{}}if(!media)dial();if(!data)dialData();}
},6000);
healthTimer=setInterval(()=>{
if(stopping||ticket!==epoch)return;
heartbeat();
if(data?.open&&lastRemote&&Date.now()-lastRemote>30000){remote('unresponsive\nreason: no heartbeat; browser/network may be suspended');}
if(track()?.readyState==='ended'||track()?.muted){recoverMicrophone();}
if(peer?.destroyed&&Date.now()-peerRetryAt>14000){peerRetryAt=Date.now();log('signaling closed; attempting recovery');const old=peer;peer=null;try{old.destroy();}catch{}if(slot>=0)openPeer(slot,ticket);}
if(media?.peerConnection?.connectionState==='failed'){log('webrtc failed; redialing');closeMedia();state('reconnecting','wait');}
},8000);
});
p.on('call',c=>{if(index!==0||stopping||media||!stream){c.close();return;}mediaEvents(c);c.answer(stream);});
p.on('connection',c=>{if(index===0)watchData(c);else c.close();});
p.on('disconnected',()=>{log('signaling disconnected (reason unknown)');refresh();if(!stopping&&!p.destroyed){try{p.reconnect();}catch{}}});
p.on('close',()=>log('signaling closed'));
p.on('error',e=>{
if(ticket!==epoch||stopping)return;
log('PeerJS error: '+e.type);
if(e.type==='unavailable-id'&&index===0){try{p.destroy();}catch{}if(peer===p)peer=null;openPeer(1,ticket);return;}
if(e.type==='unavailable-id'&&index===1){teardown('room full');problem('room full');return;}
if(e.type==='peer-unavailable'){if(media)closeMedia();state('waiting','wait');return;}
if(['network','server-error','socket-error','socket-closed','disconnected'].includes(e.type)){state('reconnecting','wait');return;}
problem('connection: '+e.type);
});
}
function openPeer(index,ticket){
if(stopping||ticket!==epoch||!stream)return;
try{const p=new Peer(ids[index],{debug:0,config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]}});peer=p;peerReady(p,index,ticket);}
catch(e){problem('signaling setup failed: '+e.message);}
}
async function microphone(){
const constraints={echoCancellation:true,noiseSuppression:true,autoGainControl:true};
if(preferredDevice)constraints.deviceId={ideal:preferredDevice};
return navigator.mediaDevices.getUserMedia({audio:constraints,video:false});
}
function watchMicrophone(s){
for(const t of s.getAudioTracks()){
t.addEventListener('mute',()=>{log('microphone suspended by browser/device');refresh();heartbeat();});
t.addEventListener('unmute',()=>{log('microphone resumed');refresh();heartbeat();});
t.addEventListener('ended',()=>{if(stopping||stream!==s)return;log('microphone ended; attempting recovery');refresh();recoverMicrophone();});
}
}
async function begin(){
if(starting||stream||peer)return;
starting=true;ui.callBtn.disabled=true;problem('');
try{
if(!window.Peer)throw Error('PeerJS did not load');
if(!navigator.mediaDevices?.getUserMedia)throw Error('microphone unavailable (HTTPS required)');
const password=ui.password.value;
if(password.length<4)throw Error('enter a shared room password (4+ characters)');
state('starting','wait');
const ticket=++epoch;
const newIds=await roomIds(password);
if(ticket!==epoch)return;
ids=newIds;
if(navigator.audioSession&&'type' in navigator.audioSession){try{navigator.audioSession.type='play-and-record';}catch{}}
stream=await microphone();
if(ticket!==epoch){stream.getTracks().forEach(t=>t.stop());stream=null;return;}
watchMicrophone(stream);controls(true);refresh();loadDevices();openPeer(0,ticket);
}catch(e){state('offline');problem('start failed: '+e.message);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}}
finally{starting=false;ui.callBtn.disabled=false;}
}
ui.callBtn.addEventListener('click',begin);
ui.endBtn.addEventListener('click',()=>teardown());
ui.muteBtn.addEventListener('click',()=>{const t=track();if(!t)return;t.enabled=!t.enabled;ui.muteBtn.textContent=t.enabled?'mute':'unmute';log(t.enabled?'unmuted':'muted');heartbeat();});
ui.restoreBtn.addEventListener('click',play);
ui.micSelect.addEventListener('change',()=>{preferredDevice=ui.micSelect.value;try{if(preferredDevice)localStorage.setItem(STORE,preferredDevice);else localStorage.removeItem(STORE);}catch{}log('microphone preference saved');});
document.addEventListener('visibilitychange',()=>{log('page '+document.visibilityState);heartbeat();if(!document.hidden){if(pendingAudio)play();if(track()?.readyState==='ended')recoverMicrophone();if(peer?.disconnected&&!peer.destroyed)try{peer.reconnect();}catch{}}});
window.addEventListener('pagehide',()=>{log('pagehide: navigation, tab closure, or browser suspension (unknown)');heartbeat();});
window.addEventListener('online',()=>{log('internet reported online');heartbeat();if(peer?.disconnected&&!peer.destroyed)try{peer.reconnect();}catch{}if(track()?.readyState==='ended')recoverMicrophone();});
window.addEventListener('offline',()=>{log('internet reported offline');heartbeat();});
navigator.mediaDevices?.addEventListener?.('devicechange',loadDevices);
ui.remoteAudio.addEventListener('pause',()=>{if(media)log('remote playback paused');});
ui.remoteAudio.addEventListener('error',()=>{log('audio element error');ui.restoreBtn.hidden=false;});
window.addEventListener('error',e=>problem('script error: '+e.message));
window.addEventListener('unhandledrejection',e=>problem('error: '+(e.reason?.message||String(e.reason))));
updateOnBoot();
function updateOnBoot(){refresh();loadDevices();}
})();