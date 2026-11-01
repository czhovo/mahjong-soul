// Convert recognized, frame-bound public values to the frozen bot's schema.
// This module observes a table; it never starts, ends, or advances a game.
export function visibleContext(frame,metadata){
  if(!metadata?.verified||metadata.observationId!==frame.id)
    throw Error('Public metadata is not verified for this frame');
  const positions=['self','right','opposite','left'];
  const seats=positions.map(p=>metadata.seats?.[p]);
  if(seats.some(s=>!Number.isInteger(s)||s<0||s>3)||new Set(seats).size!==4)
    throw Error('Four distinct seat identities required');
  const points=metadata.points;
  if(!points?.verified||points.point_basis!=='hand-opening'||points.observationId!==frame.id||!points.source||
    !Array.isArray(points.scores)||points.scores.length!==4||points.scores.some(s=>!Number.isInteger(s))||
    !Number.isInteger(points.riichi_sticks)||points.riichi_sticks<0)
    throw Error('Confirmed settlement/opening point ledger required for this frame');
  const scores=[...points.scores];
  const context=structuredClone(metadata.context);
  if(!context||context.schema!==1||!Number.isInteger(context.remaining_scheduled_hands)||
    context.remaining_scheduled_hands<1||!Number.isInteger(context.hand_index)||context.hand_index<1||
    context.is_last_scheduled_hand!==(context.remaining_scheduled_hands===1))
    throw Error('Incomplete match context');
  if(!Array.isArray(context.tie_priority)||context.tie_priority.length!==4||
    [...context.tie_priority].sort().join(',')!=='0,1,2,3')throw Error('Invalid tie priority');
  if(!Number.isInteger(context.honba)||context.honba<0||
    !Number.isInteger(context.riichi_sticks)||context.riichi_sticks<0)
    throw Error('Honba and deposits must be observed');
  return {...context,scores,riichi_sticks:points.riichi_sticks,point_source:points.source,source:`visible-frame:${frame.id}`};
}
