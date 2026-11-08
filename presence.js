(() => {
'use strict';
const HUB_ID='md-presence-admin-v1';
const TICK_MS=4000;
const STALE_MS=27000;
const $=id=>document.getElementById(id);
const panel=$('adminPanel'),setup=$('setup'),controls=document.querySelector('.controls');
const adminStatus=$('adminStatus'),metrics=$('adminMetrics'),roomRows=$('adminRoomRows');
const password=$('password');
const reports=new Map(),connections=new Set();
let adminMode=false,adminPeer=null,adminViewer=false,adminConnection=null;
let reporterPeer=null,reporterConnection=null,reporterLastDial=0,reporterLastSent=0;
let roomPrimary=null,roomTag=null,roomGeneration=0,mediaConnected=false;
let lastAdminConnection=0,lastSnapshot=null,adminLastDial=0;
const session=(()=>{
try {
  let id=sessionStorage.getItem('muckyducky-presence-tab-v1');
  if(!id){id=crypto.randomUUID();sessionStorage.setItem('muckyducky-presence-tab-v1',id);}
  return id;
} catch {return crypto.randomUUID?.()||Math.random().toString(36).slice(2);}
})();
function setStatus(s){adminStatus.textContent=s;}
function clearReporter(){
  if(reporterConnection){try{if(reporterConnection.open)reporterConnection.send({type:'leave',session});}catch{}}
  try{reporterConnection?.close();}catch{}
  reporterConnection=null;
  try{reporterPeer?.destroy();}catch{}
  reporterPeer=null;reporterLastDial=0;reporterLastSent=0;
}
function onPresence(d){
  const next=typeof d?.room==='string'&&/^md-[a-f0-9]{42}-a$/.test(d.room)?d.room:null;
  mediaConnected=!!d?.connected;
  if(next===roomPrimary)return;
  roomPrimary=next;roomTag=null;
  const generation=++roomGeneration;
  clearReporter();
  if(!next)return;
  crypto.subtle.digest('SHA-256',new TextEncoder().encode('muckyducky-admin-room-tag-v1|'+next))
    .then(bytes=>{
      if(generation!==roomGeneration||!roomPrimary)return;
      roomTag=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('').slice(0,20);
      ensureReporter();
    }).catch(()=>{});
}
function sendReport(){
  if(!reporterConnection?.open||!roomTag)return;
  try {
    reporterConnection.send({type:'presence',session,room:roomTag,connected:mediaConnected});
    reporterLastSent=Date.now();
  }catch{}
}
function ensureReporter(){
  if(adminMode||!roomTag)return;
  if(!reporterPeer||reporterPeer.destroyed){
    try{reporterPeer=new Peer(undefined,{debug:0});}catch{return;}
    const p=reporterPeer;
    p.on('open',()=>{if(reporterPeer===p)ensureReporter();});
    p.on('error',e=>{
      if(reporterPeer!==p)return;
      if(e.type==='peer-unavailable'){try{reporterConnection?.close();}catch{} reporterConnection=null;return;}
      if(['network','server-error','socket-error','socket-closed'].includes(e.type)){
        try{p.destroy();}catch{} if(reporterPeer===p){reporterPeer=null;reporterConnection=null;}
      }
    });
    p.on('disconnected',()=>{if(reporterPeer===p&&!p.destroyed)try{p.reconnect();}catch{}});
    return;
  }
  if(!reporterPeer.open)return;
  if(reporterConnection?.open){if(Date.now()-reporterLastSent>=TICK_MS)sendReport();return;}
  if(reporterConnection&&Date.now()-reporterLastDial<9000)return;
  try{reporterConnection?.close();}catch{}
  reporterConnection=null;
  if(Date.now()-reporterLastDial<9000)return;
  reporterLastDial=Date.now();
  try{
    const c=reporterPeer.connect(HUB_ID,{reliable:true});
    reporterConnection=c;
    c.on('open',()=>{if(reporterConnection===c)sendReport();});
    c.on('close',()=>{if(reporterConnection===c)reporterConnection=null;});
    c.on('error',()=>{if(reporterConnection===c)reporterConnection=null;});
  }catch{reporterConnection=null;}
}
function liveEntries(){
  const now=Date.now();
  for(const [key,value] of reports)if(now-value.at>STALE_MS)reports.delete(key);
  return [...reports.values()];
}
function snapshotFromReports(){
  const byRoom=new Map();
  const all=liveEntries();
  for(const r of all){
    const row=byRoom.get(r.room)||{room:r.room,participants:0,connected:0,latest:0};
    row.participants++;if(r.connected)row.connected++;
    row.latest=Math.max(row.latest,r.at);
    byRoom.set(r.room,row);
  }
  return {type:'snapshot',rooms:[...byRoom.values()].sort((a,b)=>a.room.localeCompare(b.room)),
    participants:all.length,connected:all.filter(x=>x.connected).length,updated:Date.now()};
}
function render(snapshot){
  if(!adminMode||!snapshot)return;
  const rooms=Array.isArray(snapshot.rooms)?snapshot.rooms:[];
  const participants=Number(snapshot.participants)||0,connected=Number(snapshot.connected)||0;
  const counts=[['Rooms reporting',rooms.length],['Participants reporting',participants],
    ['In a call',connected],['Waiting',Math.max(0,participants-connected)]];
  metrics.replaceChildren();
  for(const [title,count] of counts){
    const div=document.createElement('div');div.className='adminMetric';
    const value=document.createElement('strong');value.textContent=String(count);
    const label=document.createElement('span');label.textContent=title;
    div.append(value,label);metrics.append(div);
  }
  roomRows.replaceChildren();
  if(rooms.length===0){
    const row=document.createElement('tr'),cell=document.createElement('td');
    cell.colSpan=4;
    cell.textContent='No room activity reported yet. Existing callers must load this version for tracking.';
    row.append(cell);roomRows.append(row);
  } else {
    rooms.forEach((r,i)=>{
      const row=document.createElement('tr');
      const items=['Room '+(i+1),String(r.participants||0),String(r.connected||0),String(Math.max(0,(r.participants||0)-(r.connected||0)))];
      for(const value of items){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
      row.title='Anonymous room tag: '+String(r.room||'').slice(0,8);
      roomRows.append(row);
    });
  }
}
function broadcast(){
  if(!adminMode||adminViewer)return;
  const snapshot=snapshotFromReports();
  render(snapshot);
  for(const c of connections)if(c.open)try{c.send(snapshot);}catch{}
}
function onHostConnection(c){
  connections.add(c);
  c.on('open',()=>{try{c.send(snapshotFromReports());}catch{}});
  c.on('data',m=>{
    if(!m||typeof m!=='object')return;
    if(m.type==='presence'&&typeof m.session==='string'&&m.session.length<=100&&/^[a-f0-9]{20}$/.test(m.room||'')){
      reports.set(m.session,{room:m.room,connected:!!m.connected,at:Date.now()});
      broadcast();
    }else if(m.type==='leave'&&typeof m.session==='string'){
      reports.delete(m.session);broadcast();
    }else if(m.type==='view'){try{c.send(snapshotFromReports());}catch{}}
  });
  c.on('close',()=>connections.delete(c));
  c.on('error',()=>connections.delete(c));
}
function stopAdminPeer(){
  try{adminConnection?.close();}catch{} adminConnection=null;
  try{adminPeer?.destroy();}catch{}adminPeer=null;
  for(const c of connections)try{c.close();}catch{}
  connections.clear();reports.clear();
  adminViewer=false;adminLastDial=0;lastSnapshot=null;
}
function startAdminViewer(){
  if(!adminMode)return;
  adminViewer=true;
  setStatus('Connecting to the active admin collector…');
  try{adminPeer=new Peer(undefined,{debug:0});}
  catch{setStatus('Admin collector unavailable.');return;}
  const p=adminPeer;
  p.on('open',()=>{if(adminPeer===p)connectViewer();});
  p.on('error',e=>{
    if(adminPeer!==p)return;
    if(e.type==='peer-unavailable'){try{adminConnection?.close();}catch{}adminConnection=null;setStatus('Collector unavailable; retrying…');}
    else if(['network','server-error','socket-error','socket-closed'].includes(e.type))setStatus('Signaling unavailable; retrying…');
  });
  p.on('disconnected',()=>{if(adminPeer===p&&!p.destroyed)try{p.reconnect();}catch{}});
}
function connectViewer(){
  if(!adminMode||!adminViewer||!adminPeer?.open||adminConnection?.open)return;
  if(adminConnection&&Date.now()-adminLastDial<8500)return;
  try{adminConnection?.close();}catch{}adminConnection=null;
  if(Date.now()-adminLastDial<8500)return;
  adminLastDial=Date.now();
  try{
    const c=adminPeer.connect(HUB_ID,{reliable:true});adminConnection=c;
    c.on('open',()=>{if(adminConnection!==c)return;setStatus('Live — receiving reported activity');c.send({type:'view'});});
    c.on('data',m=>{if(adminConnection!==c||m?.type!=='snapshot')return;lastSnapshot=Date.now();render(m);});
    c.on('close',()=>{if(adminConnection===c){adminConnection=null;setStatus('Collector disconnected; retrying…');}});
    c.on('error',()=>{if(adminConnection===c)adminConnection=null;});
  }catch{adminConnection=null;}
}
function startAdminHost(){
  setStatus('Starting live presence collector…');
  try{adminPeer=new Peer(HUB_ID,{debug:0});}
  catch{setStatus('Could not start the collector.');return;}
  const p=adminPeer;
  p.on('open',()=>{
    if(!adminMode||adminPeer!==p){p.destroy();return;}
    adminViewer=false;
    setStatus('Live — collecting room reports');
    p.on('connection',onHostConnection);
    broadcast();
  });
  p.on('error',e=>{
    if(!adminMode||adminPeer!==p)return;
    if(e.type==='unavailable-id'){
      try{p.destroy();}catch{}adminPeer=null;
      startAdminViewer();return;
    }
    setStatus('Collector signaling error ('+e.type+').');
  });
  p.on('disconnected',()=>{if(adminMode&&adminPeer===p&&!p.destroyed)try{p.reconnect();}catch{}});
}
function openAdmin(){
  if(adminMode)return;
  // This is a convenience entry point, not authentication.
  adminMode=true;setup.hidden=true;controls.hidden=true;panel.hidden=false;
  $('slotCounts').hidden=true;
  clearReporter();roomPrimary=null;roomTag=null;++roomGeneration;
  render({rooms:[],participants:0,connected:0});
  startAdminHost();
}
function closeAdmin(){
  if(!adminMode)return;
  adminMode=false;stopAdminPeer();panel.hidden=true;setup.hidden=false;controls.hidden=false;
  password.value='';
  setStatus('Offline');
}
password.addEventListener('input',()=>{if(password.value==='1')openAdmin();});
$('closeAdmin').addEventListener('click',closeAdmin);
window.addEventListener('muckyducky:admin-open',openAdmin);
window.addEventListener('muckyducky:presence',e=>onPresence(e.detail));
setInterval(()=>{
  if(adminMode){
    if(!adminViewer&&adminPeer?.open)broadcast();
    else if(adminViewer) {
      if(adminPeer?.open)connectViewer();
      if(lastSnapshot&&Date.now()-lastSnapshot>STALE_MS)setStatus('Live data is stale; reconnecting…');
    }
  }else ensureReporter();
},TICK_MS);
window.addEventListener('pagehide',()=>{clearReporter();stopAdminPeer();});
})();