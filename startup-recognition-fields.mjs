// Semantic fields only: pixel coordinates, confidence scores and timings vary.
export function startupRecognitionFields(frame,mode){
 const fields={};
 const positions={self:'本方',right:'下家',opposite:'对家',left:'上家'};
 if(mode==='probe')return {'开局页面':frame.start_page?.page,'开局按钮':frame.start_page?.controls&&Object.keys(frame.start_page.controls).sort()};
 if(mode==='riichi')return {'立直选牌验证':frame.selection?.verified,'立直合法弃牌':frame.selection?.legalDiscards};
 for(const [key,name] of [['hand','手牌'],['dora','宝牌指示牌']]){
  fields[name]=frame[key]?.tiles?.map(t=>t.tile);
  fields[name+'完整']=frame[key]?.complete;
 }
 for(const [position,name] of Object.entries(positions)){
  const river=frame.rivers?.[position];
  fields[name+'牌河']=river?.tiles?.map(t=>t.tile);
  fields[name+'牌河完整']=river?.complete;
  fields[name+'横置牌']=river?.tiles?.flatMap((t,i)=>t.sideways?[i+1]:[]);
  const meld=position==='self'?frame.own_melds:frame.opponent_melds?.[position];
  fields[name+'副露']=meld?.groups?.map(g=>({kind:g.kind,tiles:g.tiles,calledIndex:g.calledIndex,fromRelative:g.fromRelative}));
  fields[name+'副露完整']=meld?.complete;
  fields[name+'点数']=frame.table_scores?.scores?.[position]?.value;
  fields[name+'结算点数']=frame.settlement?.scores?.[position]?.value;
 }
 Object.assign(fields,{
  '场风':frame.round?.wind,'局数':frame.round?.hand_number?.value,
  '本场':frame.round?.counters?.honba,'供托':frame.round?.counters?.riichi_sticks,
  '剩余牌山':frame.round?.remaining?.value,'座位验证':frame.round?.seat_identity?.verified,
  '四家自风':frame.round?.seat_identity?.seats,'庄家':frame.round?.seat_identity?.dealer,
  '行动方':frame.round?.turn?.position,'操作按钮':frame.controls&&Object.keys(frame.controls).sort(),
  '自动和牌验证':frame.auto_win?.verified,'自动和牌开启':frame.auto_win?.enabled,
  '计时验证':frame.time_reserve?.verified,'长考秒数':frame.time_reserve?.reserve_seconds,'操作秒数':frame.time_reserve?.action_seconds,
  '结果页':frame.result_page,'桌面点数完整':frame.table_scores?.complete,'结算点数完整':frame.settlement?.complete,
  '终局阶段':frame.terminal_phase?.name,'终局按钮':frame.terminal_phase?.controls&&Object.keys(frame.terminal_phase.controls).sort()
 });
 return fields;
}

export function validateStartupFields(frame,expected,mode){
 const actual=startupRecognitionFields(frame,mode);
 for(const [name,value] of Object.entries(expected)){
  if(JSON.stringify(actual[name])!==JSON.stringify(value))
   throw Error(`${name}样本不匹配：预期 ${JSON.stringify(value)}；实际 ${JSON.stringify(actual[name])??'缺失'}`);
 }
 return actual;
}
