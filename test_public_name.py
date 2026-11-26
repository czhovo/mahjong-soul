"""Synthetic labels only; no account screenshots are needed for these checks."""
import unittest
import cv2
import numpy as np
from native_layout import crop_native
from player_nickname import Nickname, SOURCE, WIN, RANK_NAMES, matched_page

class PublicNameMatching(unittest.TestCase):
    def setUp(self):
        self.image=np.zeros((800,1368,3),np.uint8)
        self.name=Nickname()

    def label(self,box,text):
        roi=crop_native(self.image,box)
        roi[:]=0
        cv2.putText(roi,text,(4,roi.shape[0]//2+5),cv2.FONT_HERSHEY_SIMPLEX,.48,(255,255,255),1,cv2.LINE_AA)

    def learn(self,source):
        self.label(SOURCE[source],'East7')
        self.assertFalse(self.name.observe(self.image,source,1))
        self.assertTrue(self.name.observe(self.image,source,2))

    def test_rank_requires_a_unique_match_on_a_visible_results_page(self):
        self.learn('lobby')
        self.label(RANK_NAMES[0],'East72')
        self.label(RANK_NAMES[3],'East7')
        restored=Nickname()
        restored.restore(self.name.pack())
        self.assertIsNone(matched_page(self.image,restored,3,True))
        self.assertIsNone(matched_page(self.image,restored,4,False))
        self.assertEqual(matched_page(self.image,restored,4,True),{'kind':'match-result'})
        self.label(RANK_NAMES[0],'East7')
        self.assertIsNone(matched_page(self.image,restored,4,True))

    def test_own_win_ribbon_after_learning_from_table(self):
        self.learn('table')
        roi=crop_native(self.image,WIN);h,w=roi.shape[:2]
        def ribbon(text):
            flat=np.zeros_like(roi)
            cv2.putText(flat,text,(90,h//2+7),cv2.FONT_HERSHEY_SIMPLEX,.8,(255,255,255),1,cv2.LINE_AA)
            roi[:]=cv2.warpAffine(flat,cv2.getRotationMatrix2D((w/2,h/2),5,1),(w,h),flags=cv2.INTER_NEAREST)
        ribbon('Other')
        self.assertIsNone(matched_page(self.image,self.name,3,False))
        ribbon('East7')
        self.assertEqual(matched_page(self.image,self.name,3,False),{'kind':'own-win-settlement'})

if __name__=='__main__':unittest.main()
