import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {MeldObservationCache} from '../river-tracking.mjs';
import {LiveCycle} from '../live-cycle.mjs';
import {TingfengSession} from '../bridge.mjs';
import {snapshotRecovery} from '../snapshot-recovery.mjs';
import {VisibleEventLog} from '../visible-event-log.mjs';
import {TerminalLog} from '../terminal-log.mjs';
const data=JSON.parse(fs.readFileSync(new URL('./fixtures/meld-retention-1104.json',import.meta.url),'utf8'));
const f=t=>structuredClone(data[t].result);
test('15:11 real missing own sideways face reaches decision and sends discard without rebuilding',async()=>{
 const a=f('15:11:23.790'),b=f('15:11:33.413'),s=new TingfengSession();s.restoreSnapshot(snapshotRecovery(a));
 let decisions=0,clicks=0,rebuilds=0;s.decide=async(e,h)=>{decisions++;s.pending={ledger:structuredClone(s.ledger)};assert.equal(e.state,'2 W6');return {output:{response:'PLAY T1'},visibleHand:h}};
 const pump=new LiveCycle({inspect:async()=>b,execute:async()=>{clicks++;return{}},saveRebuildScreenshot:async()=>{rebuilds++}},s,{before:a,decision:null});
 pump.publicFrame=a;pump.record=async()=>{};
 const result=await pump.step();assert.equal(decisions,1,JSON.stringify(result));assert.equal(clicks,1);assert.equal(rebuilds,0);
});
test('16:53 preserves all four known groups through animation and emits precisely one added kong',()=>{
 const cache=new MeldObservationCache(),a=cache.apply(f('16:53:49.473')),log=new VisibleEventLog(a),events=[];
 for(const t of ['16:53:49.578','16:53:49.685','16:53:50.439','16:53:50.546']){
  const b=cache.apply(f(t));assert.equal(b.opponent_melds.left.groups.length,2);assert.equal(b.opponent_melds.opposite.groups.length,2);events.push(...log.observe(b));
 }
 assert.deepEqual(events.filter(q=>/GANG|PENG/.test(q.state)).map(q=>q.state),['3 2 BUGANG Z7']);
 const lines=[],term=new TerminalLog(x=>lines.push(x),{color:false});term.scoreFrame=f('16:53:50.546');
 term.event({kind:'visible_public_events',requests:events});
 // Kongs share a line with the subsequently exposed dora indicator.
 term.event({kind:'visible_public_events',requests:[{state:'DORA T4 1'}]});
 assert.equal(lines.filter(l=>/加杠.*中/.test(l)).length,1,JSON.stringify(lines));
});
test('known melds survive empty, incomplete, rejected faces and temporary unknown round; clear on next hand',()=>{
 const c=new MeldObservationCache(),a=f('16:53:49.473');c.apply(a);
 for(let i=0;i<3;i++){let b=structuredClone(a);b.id='bad'+i;b.own_melds={complete:true,groups:[]};
 for(const p of ['left','opposite']){b.opponent_melds[p]={complete:i===0,groups:[]};b.opponent_meld_faces[p]={complete:false,tiles:[],rejected:[{}]};}
 if(i===1){b.round.wind=null;c.apply(b);b.round.wind=a.round.wind;}
 const r=c.apply(b);assert.equal(r.opponent_melds.left.groups.length,2);assert.equal(r.opponent_melds.opposite.groups.length,2);}
 const next=structuredClone(a);next.round.hand_number.value++;next.opponent_melds.left={complete:true,groups:[]};assert.equal(c.apply(next).opponent_melds.left.groups.length,0);
});
import {publicContinuation} from '../public-continuation.mjs';
test('16:53 added kong is committed into bot requests without snapshot repair, then rinshan and discard',()=>{
 const a=f('16:53:49.473'),b=f('16:53:50.546'),s=new TingfengSession();s.restoreSnapshot(snapshotRecovery(a));
 const c=publicContinuation(a,b,s);assert.deepEqual(c.requests.map(q=>q.state),['3 2 BUGANG Z7']);
 s.observeVerified(c,b.hand.tiles.map(t=>t.tile));
 const draw=structuredClone(b);draw.round.remaining.value--;draw.id='rinshan';
 const d=publicContinuation(b,draw,s);assert.deepEqual(d.requests.map(q=>q.state),['3 2 DRAW']);s.observeVerified(d,draw.hand.tiles.map(t=>t.tile));
 const end=structuredClone(draw);end.id='out';end.rivers.left.tiles.push({tile:'W2',sideways:false,color:{verified:true}});
 const e=publicContinuation(draw,end,s);assert.deepEqual(e.requests.map(q=>q.state),['3 2 PLAY W2']);
 s.observeVerified(e,end.hand.tiles.map(t=>t.tile));
 assert.equal(s.requests.filter(q=>q.state==='3 2 BUGANG Z7').length,1);
});
test('old exposed meld cannot be replaced by an inferred concealed kong or downgraded after upgrade',()=>{
 const c=new MeldObservationCache(),a=f('16:53:49.473');c.apply(a);
 let b=structuredClone(a);b.opponent_melds.left.groups[0]={...b.opponent_melds.left.groups[0],kind:'ANGANG',tiles:['Z7','Z7','Z7','Z7'],estimated:true};
 assert.equal(c.apply(b).opponent_melds.left.groups[0].kind,'PENG');
 c.apply(f('16:53:50.546'));assert.equal(c.apply(a).opponent_melds.left.groups[0].kind,'BUGANG');
});
