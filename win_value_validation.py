"""Validate only recognized fields against the supplied Mahjong Soul score tables.

Entries: nondealer ron, dealer ron, nondealer tsumo (child, dealer),
dealer tsumo per payer. The screenshot's points mean TOTAL receipts.
No live round, seat, honba, deposits, or hand reconstruction is consulted.
"""
FU_VALUES = (20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110)
TABLE = {
 20: [None, (None,None,(400,700),700), (None,None,(700,1300),1300), (None,None,(1300,2600),2600)],
 25: [None, (1600,2400,None,None), (3200,4800,(800,1600),1600), (6400,9600,(1600,3200),3200)],
 30: [(1000,1500,(300,500),500), (2000,2900,(500,1000),1000), (3900,5800,(1000,2000),2000), (7700,11600,(2000,3900),3900)],
 40: [(1300,2000,(400,700),700), (2600,3900,(700,1300),1300), (5200,7700,(1300,2600),2600)],
 50: [(1600,2400,(400,800),800), (3200,4800,(800,1600),1600), (6400,9600,(1600,3200),3200)],
 60: [(2000,2900,(500,1000),1000), (3900,5800,(1000,2000),2000), (7700,11600,(2000,3900),3900)],
 70: [(2300,3400,(600,1200),1200), (4500,6800,(1200,2300),2300)],
 80: [(2600,3900,(700,1300),1300), (5200,7700,(1300,2600),2600)],
 90: [(2900,4400,(800,1500),1500), (5800,8700,(1500,2900),2900)],
 100: [(3200,4800,(800,1600),1600), (6400,9600,(1600,3200),3200)],
 110: [(3600,5300,None,None), (7100,10600,(1800,3600),3600)],
}

def limit_points(child, players):
 # Total receipts: sanma nondealer tsumo loses one child payment;
 # dealer tsumo has the same total as nondealer ron at every limit.
 values={child,child*3//2}
 if players==3:values.add(child*3//4)
 return values

def possible_points(han, fu, players=4):
 if players not in (3,4):raise ValueError('Unsupported player count')
 if type(han) is not int or han < 1 or fu not in FU_VALUES:return set()
 if han >= 5:
  child = 8000 if han == 5 else 12000 if han <= 7 else 16000 if han <= 10 else 24000 if han <= 12 else 32000
  return limit_points(child,players)
 row = TABLE[fu]
 if han > len(row):return limit_points(8000,players)
 entry = row[han-1]
 if entry is None:return set()
 child_ron, dealer_ron, child_tsumo, dealer_tsumo = entry
 values = {v for v in (child_ron,dealer_ron) if v is not None}
 if child_tsumo:values.add((players-2)*child_tsumo[0]+child_tsumo[1])
 if dealer_tsumo:values.add((players-1)*dealer_tsumo)
 return values

ALL_POINTS = set().union(*(possible_points(h,f) for h in range(1,14) for f in FU_VALUES))
SANMA_POINTS = set().union(*(possible_points(h,f,3) for h in range(1,14) for f in FU_VALUES))

def validate_win_values(han, fu, points, players=4):
 if players not in (3,4):raise ValueError('Unsupported player count')
 reasons=[]
 if type(han) is not int or han < 1:
  han=None;reasons.append('han-unreadable-or-invalid')
 if type(fu) is not int or fu not in FU_VALUES:
  fu=None;reasons.append('fu-unreadable-or-invalid')
 if type(points) is not int or points not in (SANMA_POINTS if players==3 else ALL_POINTS):
  points=None;reasons.append('total-points-unreadable-or-invalid')
 if han is not None and fu is not None:
  allowed=possible_points(han,fu,players)
  if not allowed:
   han=fu=None;reasons.append('impossible-han-fu-combination')
  elif points is not None and points not in allowed:
   # A conflict cannot identify which OCR field was wrong. Do not invent
   # a replacement or retain a partially authoritative conflicting tuple.
   han=fu=points=None;reasons.append('han-fu-total-points-conflict')
 return {'han':han,'fu':fu,'points':points,
         'complete':all(v is not None for v in (han,fu,points)),
         'validation':{'valid':not reasons,'reasons':reasons}}
