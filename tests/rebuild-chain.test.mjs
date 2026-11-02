import fs from 'node:fs';
import {snapshotRecovery} from '../snapshot-recovery.mjs';
import {TingfengSession} from '../bridge.mjs';
import {publicContinuation} from '../public-continuation.mjs';
const rows=JSON.parse(fs.readFileSync(new URL('./fixtures/rebuild-chain.json',import.meta.url),'utf8'));
import assert from 'node:assert/strict';
import test from 'node:test';
const ix=0;
test('one snapshot continues through three real discards, without rebuilding or removing a second west',()=>{
 let a=structuredClone(rows[ix]),session=new TingfengSession();session.restoreSnapshot(snapshotRecovery(a));
 const got=[];
 for(const frame of rows.slice(ix+1,ix+4)){
  const b=structuredClone(frame),span=publicContinuation(a,b,session);
  session.observeVerified(span,b.hand.tiles.map(t=>t.tile));
  got.push(...span.requests.map(q=>q.state).filter(Boolean));assert.ok(Number.isInteger(b.round.remaining.value));a=b;
 }
 assert.deepEqual(got,['3 3 PLAY Z3','3 0 DRAW','3 0 PLAY B1','3 1 DRAW','3 1 PLAY T6']);
});
test('a river face already in recovered history is aligned without a second PLAY',()=>{
 const a=structuredClone(rows[ix]),b=structuredClone(rows[ix+1]),session=new TingfengSession();
 const snapshot=snapshotRecovery(a,{previous:b});session.restoreSnapshot(snapshot);const s=publicContinuation(a,b,session);
 assert.equal(s.alignSnapshotRiver,true);assert.deepEqual(s.requests,[]);
});
