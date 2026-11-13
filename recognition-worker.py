"""Persistent JSON-lines recognizer; no clicks and no hidden game data."""
import json
import sys
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
from time import perf_counter
from concurrent.futures import ThreadPoolExecutor
import cv2
cv2.setNumThreads(1)
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from vision import load
from frame_memory import read_memory
from collections import OrderedDict
memory_frames=OrderedDict()
from recognize_coded_frame import PublicTileTail,recognize_frame,read_rivers,configure_region_workers
from coded_tiles import configure_decoder_workers
configure_decoder_workers(5)
configure_region_workers(2)
from auto_win_vision import read_auto_win
from time_reserve_vision import read_time_reserve
from control_vision import recognize_controls,configure_control_workers
configure_control_workers(3)
from round_vision import read_round as read_round_base,read_seats
from sanma_vision import adapt_round,adapt_result,exclude_kita,read_physical_seats
import control_vision
sanma=False
last_sanma_round=None
seat_key=seat_map=None
def read_round(image):
    global last_sanma_round,seat_key,seat_map
    state=read_round_base(image,include_seats=False)
    key=(sanma,state['wind'],state['hand_number']['value'],state['counters']['honba'])
    if None not in key:
        if seat_key!=key:
            identity=(read_physical_seats if sanma else read_seats)(image)
            if identity.get('verified'):
                seat_key,seat_map=key,identity
            state['seat_identity']=identity
        else:state['seat_identity']=seat_map
    else:
        same=seat_key is not None and all(v is None or v==old for v,old in zip(key,seat_key))
        # The compass can be readable before the round label/counters.
        # Use it for this frame without binding it to an unidentified hand.
        state['seat_identity']=seat_map if same else (read_physical_seats if sanma else read_seats)(image)
    if sanma:
        state=adapt_round(None,state)
        if state.get('seat_identity',{}).get('verified'):last_sanma_round=state
    return state
from settlement_vision import read_settlement
from score_vision import read_scores
from meld_vision import read_own_melds,read_visible_melds,read_public_melds
from frame_layout import calibrate,restore_coordinates
from incremental_rivers import IncrementalRivers
from native_face_retry import refine_native_regions,retry_own_meld_faces
river_tracker=IncrementalRivers()
public_tail=PublicTileTail()
from selection_vision import riichi_choices,post_call_choices
from choice_vision import read_call_choices
from phase_vision import recognize_phase
from start_vision import recognize_start
from modal_confirm_vision import read_modal_confirm
from modal_text import read_modal_text

ROOT=Path(__file__).parent
control_stage=ThreadPoolExecutor(max_workers=1)

def timed_controls(image):
    start=perf_counter()
    return recognize_controls(image),(perf_counter()-start)*1000

print(json.dumps({'type':'ready','recognizer_version':'v4'}),flush=True)
for line in sys.stdin:
    request={}
    controls_future=None
    try:
        request=json.loads(line)
        requested_sanma=request.get('game')=='sanma'
        if requested_sanma!=sanma:
            seat_key=seat_map=last_sanma_round=None
            public_tail.reset();river_tracker.reset()
            control_vision._last_controls=None
        sanma=requested_sanma
        archive_root=Path(__file__).parent/('sanma' if sanma else '')
        if sanma:control_vision.ART['KITA']='op_babei'
        else:control_vision.ART.pop('KITA',None)
        started=perf_counter()
        descriptor=request.get('frameMemory')
        key=(descriptor['name'],descriptor['sequence']) if descriptor else None
        if key is not None and key in memory_frames:
            image=memory_frames[key].copy()
        elif descriptor:
            image=read_memory(descriptor)
            memory_frames[key]=image.copy()
            while len(memory_frames)>4:memory_frames.popitem(last=False)
        else:image=load(request['image'])
        native_image=image
        loaded=perf_counter()
        if request.get('phase')=='save_rebuild':
            from rebuild_screenshot import save_rebuild
            saved=save_rebuild(image,request['observationId'],request.get('capturedAt'),request.get('evidence',{}),directory=archive_root/'saved-rebuild-screenshots')
            print(json.dumps({'id':request['id'],'saved':saved},ensure_ascii=False),flush=True)
            continue
        modal_confirm=read_modal_confirm(native_image)
        if modal_confirm:
            print(json.dumps({'id':request['id'],'modal_confirm':modal_confirm},ensure_ascii=False),flush=True)
            continue
        if request.get('beginMatchArchive'):
            seat_key=seat_map=last_sanma_round=None
            river_tracker.reset();public_tail.reset()
        result_page=None
        if request.get('phase')=='post_match':
            image,scale=calibrate(image)
            result={'id':request['id'],'terminal_phase':recognize_phase(image),'result_page':result_page}
            restore_coordinates(result,scale)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        if request.get('phase')=='probe':
            image,scale=calibrate(image)
            result={'id':request['id'],'round':read_round(image),'terminal_phase':recognize_phase(image),'settlement':read_settlement(image),'result_page':result_page,'time_reserve':read_time_reserve(image),'start_page':recognize_start(image,sanma=sanma)}
            if sanma:adapt_result(image,result,last_sanma_round,native_image,scale)
            restore_coordinates(result,scale)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        if request.get('phase')=='rivers':
            image,scale=calibrate(image)
            state=read_round(image)
            ident=None
            if state.get('seat_identity',{}).get('verified') and all(isinstance(v,int) for v in (state.get('wind'),state.get('hand_number',{}).get('value'),state.get('counters',{}).get('honba'))):
                ident=(state['wind'],state['hand_number']['value'],state['counters']['honba'],tuple(sorted(state['seat_identity']['seats'].items())))
            river_image=exclude_kita(image,state) if sanma else image
            result={'id':request['id'],'rivers':read_rivers(river_image,tracker=river_tracker,identity=(ident,))}
            refine_native_regions(result,exclude_kita(native_image,state,scale) if sanma else native_image,scale)
            river_tracker.accept_refined(result['rivers'],river_image,(ident,))
            if sanma:adapt_result(image,result,state,native_image,scale)
            restore_coordinates(result,scale)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        if request.get('phase')=='settlement':
            result={'id':request['id'],'settlement':read_settlement(image),'result_page':result_page}
            if sanma:adapt_result(image,result,last_sanma_round)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        count=request.get('meld_count',0);phase=request['phase']
        if count not in range(5) or phase not in ('waiting','discard','auto'):raise ValueError('Explicit valid meld count and phase required')
        expected=None if phase=='auto' else (14 if phase=='discard' else 13)-3*count
        image,scale=calibrate(image)
        round_started=perf_counter()
        round_state=read_round(image)
        round_ms=(perf_counter()-round_started)*1000
        river_identity=None
        if round_state.get('seat_identity',{}).get('verified') and all(isinstance(v,int) for v in (round_state.get('wind'),round_state.get('hand_number',{}).get('value'),round_state.get('counters',{}).get('honba'))):
            river_identity=(round_state.get('wind'),round_state.get('hand_number',{}).get('value'),round_state.get('counters',{}).get('honba'),tuple(sorted(round_state['seat_identity']['seats'].items())))
        selection_mode=request.get('selection') or request.get('selection_overlay')
        combinations=read_call_choices(image) if selection_mode=='post_call' else None
        if combinations and combinations['verified']:
            count-=1
            if count<0:raise ValueError('Combination selection requires pending call')
        settlement=read_settlement(image) if request.get('observeSettlement') else None
        if request.get('selection') not in ('riichi','post_call'):
            controls_future=control_stage.submit(timed_controls,image)
        # During a verified riichi selection the decision is already frozen.
        # Only fresh hand identity, enabled discard and own melds are needed;
        # full public-state recognition resumes for effect confirmation.
        coded_image=exclude_kita(image,round_state) if sanma else image
        coded=recognize_frame(coded_image,expected,hand_right=150+(14-3*count)*67.5+35,selection_only=request.get('selection') in ('riichi','post_call'),retry_river_scales=not request.get('fast_rivers',False),river_tracker=river_tracker,river_identity=river_identity,public_tail=public_tail)
        retry_own_meld_faces(coded,exclude_kita(native_image,round_state,scale) if sanma else native_image,scale)
        if request.get('auto_meld_count'):
            inferred=read_own_melds(coded['meld_faces'],coded['meld_rejected'],None,image)
            if inferred['complete']:
                detected_count=len(inferred['groups'])
                if detected_count!=count:
                    count=detected_count
                    coded=recognize_frame(coded_image,None,hand_right=150+(14-3*count)*67.5+35,retry_river_scales=True,river_tracker=river_tracker,river_identity=river_identity,public_tail=public_tail)
        refine_native_regions(coded,exclude_kita(native_image,round_state,scale) if sanma else native_image,scale)
        river_tracker.accept_refined(coded.get('rivers',{}),coded_image,(river_identity,))
        coded_at=perf_counter()
        if phase=='auto':
            visible=len(coded['hand']['tiles'])
            phase='waiting' if visible==13-3*count else 'discard' if visible==14-3*count else 'unknown'
            expected=visible if phase!='unknown' else None
            # Cardinality is only a candidate phase. The event ledger still
            # verifies the exact hand change before any bot call or action.
            coded['hand']['complete']=expected is not None and not coded['hand']['rejected'] and coded['hand']['outline_verified']
        coded['own_melds']=read_own_melds(coded['meld_faces'],coded['meld_rejected'],count,image)
        coded['opponent_melds']={}
        for position,entry in coded['opponent_meld_faces'].items():
            coded['opponent_melds'][position]=read_public_melds(image,entry,position)
        coded['hand'].update(expected_count=expected,meld_count=count,phase=phase)
        if selection_mode=='riichi':coded['selection']=riichi_choices(image,coded['hand'])
        if selection_mode=='post_call':coded['selection']=post_call_choices(image,coded['hand'],coded['own_melds'])
        if combinations and combinations['verified']:coded['call_choices']=combinations
        grouped_at=perf_counter()
        # A pending transaction already chose its call/riichi button. During
        # discard selection only enabled hand targets are actionable; button
        # matching resumes on the subsequent full effect-confirmation frame.
        controls,controls_ms=controls_future.result() if controls_future else ({},0)
        controls_at=perf_counter()
        round_at=perf_counter()
        result={**coded,'result_page':result_page,'id':request['id'],'controls':controls,'round':round_state,'auto_win':read_auto_win(image,sanma=sanma),'time_reserve':read_time_reserve(image),
          'recognitionStagesMs':{'load':(loaded-started)*1000,'coded':(coded_at-loaded)*1000,
            'groupAndSelection':(grouped_at-coded_at)*1000,'controls':controls_ms,
            'controlsWait':(controls_at-grouped_at)*1000,
            'round':round_ms}}
        if request.get('observeSettlement'):result['terminal_phase']=recognize_phase(image)
        if settlement is not None:result['settlement']=settlement
        if request.get('readTableScores'):
            scores=read_scores(image)
            result['table_scores']={'scores':scores,'complete':all(s['value'] is not None for s in scores.values()),'source':'table-center-fixed-regions'}
        if sanma:adapt_result(image,result,last_sanma_round,native_image,scale)
        result=restore_coordinates(result,scale)
    except Exception as error:
        result={'id':request.get('id'),'error':str(error)}
    finally:
        # Do not let a failed frame's parallel task leak into the next request.
        if controls_future is not None:
            try:controls_future.result()
            except Exception:pass
    result['recognizer_version']='v4'
    print(json.dumps(result,ensure_ascii=False),flush=True)
