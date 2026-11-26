"""Persistent JSON-lines recognizer; no clicks and no hidden game data."""
import json
import sys
import traceback
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
from time import perf_counter
from concurrent.futures import ThreadPoolExecutor
import cv2
cv2.setNumThreads(1)
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
sys.path.insert(0,str(ROOT))
from vision import load
from frame_memory import read_memory
from collections import OrderedDict
memory_frames=OrderedDict()
from recognize_coded_frame import PublicTileTail,recognize_frame,read_rivers,configure_region_workers,own_tile_visible
from coded_tiles import configure_decoder_workers
configure_decoder_workers(5)
configure_region_workers(2)
from auto_win_vision import read_auto_win,read_auto_kita
from time_reserve_vision import read_time_reserve
from fixed_controls import palettes,recognize_controls
palettes(False)
palettes(True)
from round_vision import read_round as read_round_base,read_seats
from sanma_vision import adapt_round,adapt_result,exclude_kita,read_physical_seats,profile as sanma_profile,read_kita_region
sanma=False
last_sanma_round=None
seat_key=seat_map=None
def read_round(image):
    global last_sanma_round,seat_key,seat_map
    state=read_round_base(image,include_seats=False)
    key=(sanma,state['wind'],state['hand_number']['value'],state['counters']['honba'])
    players=3 if sanma else 4
    valid_key=key[1] in range(4) and key[2] in range(1,players+1) and isinstance(key[3],int) and key[3]>=0
    same=seat_key is not None and any(v is not None for v in key[1:]) and all(v is None or v==old for v,old in zip(key,seat_key))
    if same:
        identity=seat_map
    elif not own_tile_visible(image,check_codes=valid_key):
        identity={'verified':False,'reason':'no-visible-hand'}
    else:
        identity=(read_physical_seats if sanma else read_seats)(image)
        if identity.get('verified') and seat_key is not None:
            _,old_wind,old_hand,_=seat_key
            advanced=key[1:3]==(old_wind+(old_hand==players),old_hand%players+1)
            if advanced and identity['seats']['self']!=(seat_map['seats']['self']-1)%players:
                # The round label can advance before the red dealer marker.
                identity={'verified':False,'reason':'dealer-not-rotated','previousRound':list(seat_key[1:]),'observedSeats':identity['seats']}
        if identity.get('verified') and valid_key:
            seat_key,seat_map=key,identity
    state['seat_identity']=identity
    if sanma:
        state=adapt_round(None,state)
        if state.get('seat_identity',{}).get('verified'):last_sanma_round=state
    return state
from settlement_vision import read_settlement
from score_vision import read_scores
from meld_vision import read_own_melds,read_visible_melds,read_public_melds
from frame_layout import calibrate,restore_coordinates
from native_layout import crop_native
from coded_tiles import decode,color_check
from incremental_rivers import IncrementalRivers
from native_face_retry import refine_native_regions,retry_own_meld_faces
river_tracker=IncrementalRivers()
public_tail=PublicTileTail()
from selection_vision import riichi_choices,post_call_choices
from choice_vision import read_call_choices
from phase_vision import recognize_phase,confirm_error,BUTTON_ERROR
from player_nickname import Nickname,matched_page
nickname=Nickname()

def observe_name(result,image,source,frame_id):
    if nickname.observe(image,source,frame_id):result['nicknameUpdate']=nickname.pack()
from start_vision import recognize_start
from modal_confirm_vision import read_modal_confirm
from modal_text import read_modal_text

control_stage=ThreadPoolExecutor(max_workers=1)

def timed_controls(image):
    start=perf_counter()
    return recognize_controls(image,sanma=sanma),(perf_counter()-start)*1000

_VERSIONS_PATH=ROOT/'versions.json'
RECOGNIZER_VERSION=json.loads(_VERSIONS_PATH.read_text(encoding='utf-8'))['recognize'] if _VERSIONS_PATH.exists() else 'v7'

print(json.dumps({'type':'ready','recognizer_version':RECOGNIZER_VERSION}),flush=True)
for line in sys.stdin:
    request={}
    controls_future=None
    try:
        request=json.loads(line)
        if request.get('restoreNickname'):nickname.restore(request['restoreNickname'])
        requested_sanma=request.get('game')=='sanma'
        if requested_sanma!=sanma:
            seat_key=seat_map=last_sanma_round=None
            public_tail.reset();river_tracker.reset()
        sanma=requested_sanma
        players=3 if sanma else 4
        started=perf_counter()
        descriptor=request.get('frameMemory')
        key=(descriptor['name'],descriptor['sequence']) if descriptor else None
        if key is not None and key in memory_frames:
            memory_frames.move_to_end(key)
            image=memory_frames[key]
        elif descriptor:
            image=read_memory(descriptor)
            memory_frames[key]=image
            while len(memory_frames)>4:memory_frames.popitem(last=False)
        else:image=load(request['image'])
        native_image=image
        loaded=perf_counter()
        if request.get('phase')=='save_rebuild':
            from rebuild_screenshot import save_rebuild
            saved=save_rebuild(image,request['observationId'],request.get('capturedAt'),request.get('evidence',{}),directory=(ROOT/'sanma' if sanma else ROOT)/'saved-rebuild-screenshots')
            print(json.dumps({'id':request['id'],'saved':saved},ensure_ascii=False),flush=True)
            continue
        modal_confirm=read_modal_confirm(native_image)
        if modal_confirm:
            print(json.dumps({'id':request['id'],'modal_confirm':modal_confirm},ensure_ascii=False),flush=True)
            continue
        if request.get('beginMatchArchive'):
            seat_key=seat_map=last_sanma_round=None
            river_tracker.reset();public_tail.reset()
        end_confirm=confirm_error(native_image)
        result_page=matched_page(native_image,nickname,players,end_confirm<BUTTON_ERROR)
        if request.get('phase')!='post_match' and result_page and result_page.get('kind')=='own-win-settlement':
            print(json.dumps({'id':request['id'],'result_page':result_page,
                'terminal_phase':{'name':'settlement','controls':{}},
                'recognizer_version':RECOGNIZER_VERSION},ensure_ascii=False),flush=True)
            continue
        if request.get('phase')=='post_match':
            # This worker survives rematching; the next game's East is drawn
            # independently. Invalidate at match end, before any opening probe.
            seat_key=seat_map=last_sanma_round=None
        if request.get('phase')=='post_match' or request.get('checkPostMatchLobby'):
            lobby_image,lobby_scale=calibrate(native_image)
            # The lobby can already be drawn behind the rematch dialog.
            # Resolve actual foreground controls before considering its backdrop.
            end_phase=recognize_phase(lobby_image,result_page,players=players,confirm=end_confirm,post_match=True,after_rematch=request.get('afterRematch',False))
            start={} if end_phase['controls'] else recognize_start(lobby_image,lobby_only=True)
            if start.get('page')=='lobby':
                result={'id':request['id'],'start_page':start,'terminal_phase':{'name':'lobby','controls':{}},'result_page':result_page}
                observe_name(result,native_image,'lobby',key or request['id'])
                restore_coordinates(result,lobby_scale)
                print(json.dumps(result,ensure_ascii=False),flush=True)
                continue
            if request.get('phase')=='post_match' or end_phase['controls']:
                result={'id':request['id'],'terminal_phase':end_phase,'result_page':result_page}
                restore_coordinates(result,lobby_scale)
                print(json.dumps(result,ensure_ascii=False),flush=True)
                continue
        entry_round=None
        if request.get('phase')=='probe':
            image,scale=calibrate(image)
            state=read_round(image)
            terminal=recognize_phase(image,result_page,players=players,confirm=end_confirm)
            overlay=read_settlement(image)
            result={'id':request['id'],'round':state,'terminal_phase':terminal,'settlement':overlay,'result_page':result_page}
            if sanma:adapt_result(image,result,last_sanma_round,native_image,scale,public_tail=public_tail)
            eligible=request.get('readOpening') and terminal['name']!='match_end' and not result['settlement']['complete']
            if request.get('checkPostMatchLobby') and state['wind'] is None and state['hand_number']['value'] is None and state['counters']['honba'] is None:
                # The old table may still be visible underneath matchmaking.
                # Tile codes alone do not establish the next game here.
                eligible=False
            complete_identity=(state['seat_identity'].get('verified') and state['wind'] is not None
                               and state['hand_number']['value'] is not None and state['counters']['honba'] is not None)
            visible_tiles=False
            if eligible and not complete_identity:
                # A valid tile code AND its matching suit stripe in the rack
                # or indicator is table evidence, never a substitute seat/wind.
                for box in ((150,635,1150,800),(12,60,222,123)):
                    roi=crop_native(image,box)
                    if any(color_check(roi,t['corners'],t['tile'])['verified'] for t in decode(roi)):
                        visible_tiles=True
                        break
            if eligible and (complete_identity or visible_tiles):
                entry_round=state
                entry_settlement=result['settlement']
            else:
                result.update(time_reserve=read_time_reserve(image),start_page=recognize_start(image,sanma=sanma))
                if result['start_page'].get('page')=='lobby':observe_name(result,native_image,'lobby',key or request['id'])
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
            empty_pos=state.get('empty_position') if sanma else None
            result={'id':request['id'],'rivers':read_rivers(river_image,tracker=river_tracker,identity=(ident,),exclude_position=empty_pos)}
            refine_native_regions(result,river_image if image is native_image else (exclude_kita(native_image,state) if sanma else native_image),scale,skip_own_melds=True,same_pixels=(image is native_image))
            river_tracker.accept_refined(result['rivers'],river_image,(ident,))
            if sanma:adapt_result(image,result,state,native_image,scale)
            restore_coordinates(result,scale)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        if request.get('phase')=='controls':
            image,scale=calibrate(image)
            result={'id':request['id'],'controls':recognize_controls(image,sanma=sanma),'auto_win':read_auto_win(image,sanma=sanma)}
            if sanma:result['auto_kita']=read_auto_kita(image,sanma=sanma)
            restore_coordinates(result,scale)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        if request.get('phase')=='settlement':
            result={'id':request['id'],'settlement':read_settlement(image),'result_page':result_page}
            if sanma:adapt_result(image,result,last_sanma_round)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            continue
        count=request.get('meld_count',0);phase='auto' if entry_round is not None else request['phase']
        if count not in range(5) or phase not in ('waiting','discard','auto'):raise ValueError('Explicit valid meld count and phase required')
        expected=None if phase=='auto' else (14 if phase=='discard' else 13)-3*count
        if entry_round is None:image,scale=calibrate(image)
        round_started=perf_counter()
        round_state=entry_round if entry_round is not None else read_round(image)
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
        empty_pos=round_state.get('empty_position') if sanma else None
        precomputed_self_kita=None
        self_kita_count=None
        if sanma:
            public_tail.begin(river_identity)
            self_phys=round_state.get('physical_positions',{}).get('self')
            self_kbox=sanma_profile().get('kita_boxes',{}).get(self_phys) if self_phys else None
            if self_kbox:
                precomputed_self_kita=public_tail.kita(image,'self',self_kbox,lambda img,b:read_kita_region(img,b,native_image,scale))
                cnt=precomputed_self_kita.get('count')
                self_kita_count=cnt if isinstance(cnt,int) else 'unknown'
            else:
                self_kita_count='unknown'
        coded_image=exclude_kita(image,round_state) if sanma else image
        remaining_wall=round_state.get('remaining',{}).get('value')
        force_hand_rescan=bool(request.get('force_hand_rescan'))
        coded=recognize_frame(coded_image,expected,hand_right=150+(14-3*count)*67.5+35,selection_only=request.get('selection') in ('riichi','post_call'),retry_river_scales=not request.get('fast_rivers',False),river_tracker=river_tracker,river_identity=river_identity,public_tail=public_tail,remaining=remaining_wall,players=players,force_hand_rescan=force_hand_rescan,self_kita_count=self_kita_count,exclude_position=empty_pos)
        native_coded_image=coded_image if image is native_image else (exclude_kita(native_image,round_state) if sanma else native_image)
        retry_own_meld_faces(coded,native_coded_image,scale)
        if request.get('auto_meld_count'):
            inferred=read_own_melds(coded['meld_faces'],coded['meld_rejected'],None,image)
            if inferred['complete']:
                detected_count=len(inferred['groups'])
                if detected_count!=count:
                    count=detected_count
                    coded=recognize_frame(coded_image,None,hand_right=150+(14-3*count)*67.5+35,retry_river_scales=True,river_tracker=river_tracker,river_identity=river_identity,public_tail=public_tail,remaining=remaining_wall,players=players,force_hand_rescan=force_hand_rescan,self_kita_count=self_kita_count,exclude_position=empty_pos)
        refine_native_regions(coded,native_coded_image,scale,skip_own_melds=True,same_pixels=(image is native_image))
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
        auto_win=read_auto_win(image,sanma=sanma)
        result={**coded,'result_page':result_page,'id':request['id'],'controls':controls,'round':round_state,'auto_win':auto_win,'auto_kita':read_auto_kita(image,sanma),'time_reserve':read_time_reserve(image),
          'recognitionStagesMs':{'load':(loaded-started)*1000,'coded':(coded_at-loaded)*1000,
            'groupAndSelection':(grouped_at-coded_at)*1000,'controls':controls_ms,
            'controlsWait':(controls_at-grouped_at)*1000,
            'round':round_ms}}
        if request.get('observeSettlement'):result['terminal_phase']=recognize_phase(image,result_page,players=players,confirm=end_confirm)
        if settlement is not None:result['settlement']=settlement
        if request.get('readTableScores') or (request.get('readRiichiScores') and 'LIZHI' in controls):
            scores=read_scores(image)
            result['table_scores']={'scores':scores,'complete':all(s['value'] is not None for s in scores.values()),'source':'table-center-fixed-regions'}
        if sanma:adapt_result(image,result,last_sanma_round,native_image,scale,public_tail=public_tail,precomputed_self_kita=precomputed_self_kita)
        if entry_round is not None:
            result.update(entryTable=True,terminal_phase=terminal,settlement=entry_settlement)
        if len(result['hand'].get('tiles') or ())>=2 and not result_page and not result.get('settlement',{}).get('complete') and result.get('terminal_phase',{}).get('name') not in ('match_end','settlement','lobby'):
            observe_name(result,native_image,'table',key or request['id'])
        result=restore_coordinates(result,scale)
    except Exception as error:
        result={'id':request.get('id'),'error':str(error)}
        if isinstance(error,cv2.error):
            frames=traceback.extract_tb(error.__traceback__)
            site=' > '.join(f'{Path(f.filename).name}:{f.lineno} {f.name}' for f in frames if Path(f.filename).resolve().parent==ROOT)
            result['error']=f"{request.get('phase')} [{site}]: {error}"
            if error.code==-215 and error.err=='!_src.empty()' and error.func.split('::')[-1]=='cvtColor':
                result.update(errorCode='EMPTY_COLOR_INPUT',errorSite=site)
    finally:
        # Do not let a failed frame's parallel task leak into the next request.
        if controls_future is not None:
            try:controls_future.result()
            except Exception:pass
    result['recognizer_version']=RECOGNIZER_VERSION
    print(json.dumps(result,ensure_ascii=False),flush=True)
